import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { findRunnerBinary, probeCliVersion } from '@parley/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliRun } from './cli-run.js';
import { createCliInstaller, INSTALLER_MAX_BYTES } from './install-run.js';
import { createCliUpdates } from './updates.js';
import { createCliUpdateRunner } from './update-run.js';

/**
 * Установка CLI из Parley (спека 2026-11-11, §4.2). Сети и настоящих установщиков здесь нет: адреса из таблицы
 * (`claude.ai`, `downloads.claude.ai`, …) уходят на локальный HTTPS-стаб с сертификатом тестового CA, который
 * создаётся при запуске теста; агент HTTPS соединяется со стабом и проверяет сертификат по этому CA. Установщик —
 * скрипт из ответа стаба: он кладёт бинарь-заглушку в `$HOME/.local/bin` временной домашней папки.
 */
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Тело кусками без Content-Length. */
  chunked?: Buffer[];
  /** Не отвечать вовсе. */
  hang?: boolean;
}

let pki = '';
let server: https.Server;
let agent: https.Agent;
/** Тот же стаб, но без тестового CA: сертификат не проходит проверку. */
let untrusted: https.Agent;
const routes = new Map<string, Reply>();
const requests: string[] = [];

beforeAll(async () => {
  pki = await mkdtemp(path.join(tmpdir(), 'parley-install-pki-'));
  const run = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: pki, stdio: 'ignore' });
  };
  await writeFile(
    path.join(pki, 'ca.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=Parley test-only CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
  );
  await writeFile(
    path.join(pki, 'leaf.cnf'),
    'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:claude.ai,DNS:downloads.claude.ai,DNS:evil.example,DNS:chatgpt.com,DNS:releases.openai.com,DNS:qwen-code-assets.oss-cn-hangzhou.aliyuncs.com,DNS:opencode.ai\n',
  );
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-config', 'ca.cnf');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=parley-test-stub');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.cnf');
  const ca = await readFile(path.join(pki, 'ca.pem'));
  server = https.createServer({ key: await readFile(path.join(pki, 'leaf.key')), cert: await readFile(path.join(pki, 'leaf.pem')) }, (request, response) => {
    const key = `${request.headers.host ?? ''}${request.url ?? ''}`;
    requests.push(key);
    const reply = routes.get(key) ?? { status: 404, body: 'not found' };
    if (reply.hang === true) return;
    response.writeHead(reply.status ?? 200, reply.headers ?? {});
    if (reply.chunked !== undefined) {
      for (const chunk of reply.chunked) response.write(chunk);
      response.end();
      return;
    }
    response.end(reply.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  class StubAgent extends https.Agent {
    override createConnection(options: tls.ConnectionOptions): ReturnType<typeof tls.connect> {
      return tls.connect({ ...options, host: '127.0.0.1', port, servername: options.servername ?? (options.host as string) });
    }
  }
  agent = new StubAgent({ ca, keepAlive: false });
  untrusted = new StubAgent({ keepAlive: false });
});

afterAll(async () => {
  agent.destroy();
  untrusted.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(pki, { recursive: true, force: true });
});

let home = '';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-install-home-')));
  routes.clear();
  requests.length = 0;
  log.info.mockClear();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Установщик-заглушка: пишет argv и окружение, кладёт `$HOME/.local/bin/<cmd>`, который печатает версию. */
function installerScript(command: string, version = '2.1.400', extra = ''): string {
  return `#!/bin/sh
printf '%s\\n' "$0" "$@" > "$HOME/installer-argv"
env > "$HOME/installer-env"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/${command}" <<'STUB'
#!/bin/sh
echo "$@" > "$HOME/smoke-args"
echo ${version}
STUB
chmod +x "$HOME/.local/bin/${command}"
${extra}
echo "installed ${command}"
`;
}

interface Options {
  env?: NodeJS.ProcessEnv;
  version?: string | null;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  platform?: NodeJS.Platform;
  cli?: ReturnType<typeof createCliRun>;
}

function installer(options: Options = {}) {
  const fresh = vi.fn(async () => (options.version === undefined ? '2.1.400' : options.version));
  const checkOne = vi.fn(async () => undefined);
  const env = { HOME: home, PATH: '/usr/bin:/bin', ...options.env };
  const cli = options.cli ?? createCliRun();
  const exec = vi.spyOn(cli, 'exec');
  const instance = createCliInstaller({
    log,
    cli,
    versions: { fresh },
    updates: { checkOne },
    env,
    agent,
    timeoutMs: options.timeoutMs ?? 20_000,
    smokeTimeoutMs: 20_000,
    downloadTimeoutMs: options.downloadTimeoutMs ?? 5000,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  return { instance, fresh, checkOne, exec, env };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('установка CLI: успех', () => {
  it('скачивание, запуск константным argv, бинарь по ожидаемому пути с pathNote, версия, проба, перепроверка', async () => {
    const body = installerScript('claude');
    routes.set('claude.ai/install.sh', { body });
    const { instance, fresh, checkOne, exec } = installer();
    const result = await instance.install('claude', 'window (c-1)');
    expect(result).toEqual({
      state: 'done',
      ok: true,
      version: '2.1.400',
      output: expect.stringContaining('installed claude'),
      pathNote: `${path.join(home, '.local/bin')} is not on your shell PATH; Parley finds claude there`,
      smoke: { ok: true, output: expect.stringContaining('2.1.400') },
    });
    expect(fresh).toHaveBeenCalledWith('claude', { force: true });
    expect(checkOne).toHaveBeenCalledWith('claude', { force: true });
    expect((await readFile(path.join(home, 'smoke-args'), 'utf8')).trim()).toBe('--version');
    // argv: интерпретатор из таблицы, файл во временной папке, константные аргументы (у Claude их нет).
    const [first] = exec.mock.calls;
    expect(first?.[0]).toBe('/bin/bash');
    expect(first?.[1].slice(0, 2)).toEqual(['--noprofile', '--norc']);
    const script = first?.[1][2] as string;
    expect(path.basename(path.dirname(script))).toMatch(/^parley-install-/);
    expect(first?.[1]).toHaveLength(3);
    // Временная папка убрана; отпечаток установщика в журнале.
    expect(existsSync(path.dirname(script))).toBe(false);
    const sha256 = createHash('sha256').update(body).digest('hex');
    expect(log.info).toHaveBeenCalledWith('provider CLI installer downloaded', expect.objectContaining({ command: 'claude', sha256, bytes: Buffer.byteLength(body) }));
  });

  it('qwen: константные аргументы `--method standalone`, ничего из запроса', async () => {
    routes.set('qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh', { body: installerScript('qwen', '0.28.0') });
    const { instance } = installer({ version: '0.28.0' });
    expect(await instance.install('qwen', 'w')).toMatchObject({ ok: true, version: '0.28.0' });
    const argv = (await readFile(path.join(home, 'installer-argv'), 'utf8')).trimEnd().split('\n');
    expect(argv.slice(1)).toEqual(['--method', 'standalone']);
    expect(path.basename(argv[0] as string)).toBe('install.sh');
  });

  it('opencode: константный argv без аргументов, бинарь в ~/.opencode/bin, версия `opencode vX.Y.Z`; реальный установщик не запускается', async () => {
    // A stub installer in place of https://opencode.ai/v2/install: it writes ~/.opencode/bin/opencode and prints nothing else.
    const body = `#!/bin/sh
printf '%s\\n' "$0" "$@" > "$HOME/installer-argv"
mkdir -p "$HOME/.opencode/bin"
cat > "$HOME/.opencode/bin/opencode" <<'STUB'
#!/bin/sh
echo "$@" > "$HOME/smoke-args"
echo "opencode v2.2.7"
STUB
chmod +x "$HOME/.opencode/bin/opencode"
echo "installed opencode"
`;
    routes.set('opencode.ai/v2/install', { body });
    const { instance, exec } = installer({ version: '2.2.7' });
    expect(await instance.install('opencode', 'w')).toMatchObject({ ok: true, version: '2.2.7' });
    const argv = (await readFile(path.join(home, 'installer-argv'), 'utf8')).trimEnd().split('\n');
    expect(argv.slice(1)).toEqual([]);
    expect(path.basename(argv[0] as string)).toBe('install.sh');
    expect((await readFile(path.join(home, 'smoke-args'), 'utf8')).trim()).toBe('--version');
    // Only the installer and the smoke probe ran: never `upgrade`.
    expect(exec.mock.calls.map((call) => call[1])).not.toContainEqual(expect.arrayContaining(['upgrade']));
  });

  it('qwen: после установки status() уже знает способ (перепроверка дожидается до ответа)', async () => {
    const wrapper = `mkdir -p "$HOME/.local/lib/qwen-code/bin" && mv "$HOME/.local/bin/qwen" "$HOME/.local/lib/qwen-code/bin/qwen" && ln -s "$HOME/.local/lib/qwen-code/bin/qwen" "$HOME/.local/bin/qwen"`;
    routes.set('qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh', { body: installerScript('qwen', '0.28.0', wrapper) });
    const parley = path.join(home, 'parley-home');
    await mkdir(parley, { recursive: true });
    const env = { HOME: home, PATH: '/usr/bin:/bin' };
    const updates = createCliUpdates({
      fetchImpl: (async () => ({ status: 200, json: async () => ({ latest: '0.28.0' }) })) as unknown as typeof fetch,
      log,
      home: parley,
      userHome: home,
      env,
    });
    expect(await updates.status('qwen', null)).toMatchObject({ method: null });
    const instance = createCliInstaller({ log, versions: { fresh: async () => '0.28.0' }, updates, env, agent, timeoutMs: 20_000, smokeTimeoutMs: 20_000, downloadTimeoutMs: 5000 });
    expect(await instance.install('qwen', 'w')).toMatchObject({ ok: true });
    expect(await updates.status('qwen', '0.28.0')).toMatchObject({ method: 'standalone', state: 'up-to-date' });
  });

  it('медленная перепроверка не задерживает результат установки дольше своего срока', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    const instance = createCliInstaller({
      log,
      versions: { fresh: async () => '2.1.400' },
      updates: { checkOne: () => new Promise<void>(() => undefined) },
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      agent,
      timeoutMs: 20_000,
      smokeTimeoutMs: 20_000,
      downloadTimeoutMs: 5000,
      recheckTimeoutMs: 50,
    });
    expect(await instance.install('claude', 'w')).toMatchObject({ ok: true });
  });

  it('папка бинаря есть в PATH — pathNote нет', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    const { instance } = installer({ env: { PATH: `${path.join(home, '.local/bin')}:/usr/bin:/bin` } });
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('pathNote');
  });

  it('PATH хоста не меняется: соседние git и node в той папке не находятся вместо своих, бинарь находится и после перезапуска', async () => {
    routes.set('chatgpt.com/codex/install.sh', {
      body: installerScript('codex', '0.170.0', 'printf "#!/bin/sh\\n" > "$HOME/.local/bin/git"; printf "#!/bin/sh\\n" > "$HOME/.local/bin/node"; chmod +x "$HOME/.local/bin/git" "$HOME/.local/bin/node"'),
    });
    const { instance, env } = installer({ version: '0.170.0' });
    expect(await instance.install('codex', 'w')).toMatchObject({ ok: true, pathNote: expect.stringContaining('.local/bin') });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(await readFile(path.join(home, 'installer-env'), 'utf8')).toContain('PATH=/usr/bin:/bin\n');
    expect(await findRunnerBinary('git', env).catch(() => null)).not.toBe(path.join(home, '.local/bin/git'));
    expect(await findRunnerBinary('node', env).catch(() => null)).not.toBe(path.join(home, '.local/bin/node'));
    // «Перезапуск»: новый поиск и новая проба версии без состояния установщика находят тот же бинарь.
    expect(await findRunnerBinary('codex', { HOME: home, PATH: '/usr/bin:/bin' })).toBe(path.join(home, '.local/bin/codex'));
    expect(await probeCliVersion('codex', 5000, { HOME: home, PATH: '/usr/bin:/bin' })).toBe('0.170.0');
  });

  it('PARLEY_<CMD>_BIN важнее ожидаемого пути', async () => {
    const own = path.join(home, 'own/claude');
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, '#!/bin/sh\necho 2.1.500\n', { mode: 0o755 });
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    const { instance, exec } = installer({ env: { PARLEY_CLAUDE_BIN: own } });
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('pathNote');
    expect(exec.mock.calls.at(-1)?.[0]).toBe(own);
  });
});

describe('установка CLI: скачивание', () => {
  it('редирект на HTTP отклоняется, установщик не запускается', async () => {
    routes.set('claude.ai/install.sh', { status: 302, headers: { location: 'http://downloads.claude.ai/claude-code-releases/bootstrap.sh' } });
    const { instance, exec } = installer();
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ state: 'done', ok: false, version: null, manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash' });
    expect((result as { error: string }).error).toContain('non-HTTPS');
    expect(exec).not.toHaveBeenCalled();
  });

  it('HTTPS-редирект на хост вне списка CLI отклоняется, туда не ходим', async () => {
    routes.set('claude.ai/install.sh', { status: 302, headers: { location: 'https://evil.example/install.sh' } });
    routes.set('evil.example/install.sh', { body: installerScript('claude') });
    const { instance, exec } = installer();
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('evil.example');
    expect(requests).toEqual(['claude.ai/install.sh']);
    expect(exec).not.toHaveBeenCalled();
  });

  it('редирект внутри списка CLI выполняется', async () => {
    routes.set('claude.ai/install.sh', { status: 302, headers: { location: 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' } });
    routes.set('downloads.claude.ai/claude-code-releases/bootstrap.sh', { body: installerScript('claude') });
    const { instance } = installer();
    expect(await instance.install('claude', 'w')).toMatchObject({ ok: true });
    expect(requests).toEqual(['claude.ai/install.sh', 'downloads.claude.ai/claude-code-releases/bootstrap.sh']);
  });

  it.each([
    ['с Content-Length', { body: Buffer.alloc(INSTALLER_MAX_BYTES + 1, 0x23) }],
    ['кусками без Content-Length', { chunked: [Buffer.alloc(INSTALLER_MAX_BYTES / 2, 0x23), Buffer.alloc(INSTALLER_MAX_BYTES / 2 + 10, 0x23)] }],
  ])('тело больше 1 МБ (%s) отклоняется', async (_label, reply) => {
    routes.set('claude.ai/install.sh', reply);
    const { instance, exec } = installer();
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain(String(INSTALLER_MAX_BYTES));
    expect(exec).not.toHaveBeenCalled();
  });

  it('сервер молчит — отказ по таймауту скачивания', async () => {
    routes.set('claude.ai/install.sh', { hang: true });
    const { instance, exec } = installer({ downloadTimeoutMs: 300 });
    const result = await instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('download failed') });
    expect(exec).not.toHaveBeenCalled();
  });

  it('сертификат проверяется: без тестового CA скачивание отклоняется', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    const result = await createCliInstaller({ log, versions: { fresh: async () => null }, env: { HOME: home, PATH: '' }, agent: untrusted }).install('claude', 'w');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('download failed') });
    expect(existsSync(path.join(home, 'installer-argv'))).toBe(false);
  });

  it('не-200 — отказ', async () => {
    routes.set('claude.ai/install.sh', { status: 500, body: 'oops' });
    const result = await installer().instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 500') });
  });
});

describe('установка CLI: процесс', () => {
  it('таймаут убивает всю группу и возвращает отказ с хвостом', async () => {
    routes.set('claude.ai/install.sh', { body: `#!/bin/sh\necho starting\nsleep 30 &\necho $! > "$HOME/bg-pid"\nwait\n` });
    const started = Date.now();
    const result = await installer({ timeoutMs: 1000 }).instance.install('claude', 'w');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('timed out'), output: expect.stringContaining('starting') });
    const pid = Number((await readFile(path.join(home, 'bg-pid'), 'utf8')).trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('ненулевой выход: хвост вывода и ручная команда', async () => {
    routes.set('qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh', {
      body: '#!/bin/sh\necho "EACCES: permission denied" >&2\nexit 7\n',
    });
    const result = await installer().instance.install('qwen', 'w');
    expect(result).toMatchObject({
      state: 'done',
      ok: false,
      version: null,
      error: 'The installer exited with code 7',
      output: expect.stringContaining('permission denied'),
      manualCommand: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash -s -- --method standalone',
    });
  });

  it('окружение: BASH_ENV, NODE_OPTIONS и npm_config_registry не доходят, прокси и CA доходят', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    await installer({
      env: {
        BASH_ENV: path.join(home, 'no-such-rc'),
        ENV: path.join(home, 'no-such-env'),
        PROMPT_COMMAND: 'echo hi',
        NODE_OPTIONS: '--require /no/such.js',
        NODE_PATH: '/no/such',
        npm_config_registry: 'https://evil.example/',
        NPM_CONFIG_PREFIX: '/no/such',
        npm_package_name: 'x',
        CLAUDE_CODE_SESSION_ID: 'parent',
        HTTPS_PROXY: 'http://proxy.test:3128',
        HTTP_PROXY: 'http://proxy.test:3128',
        NO_PROXY: 'localhost',
        NODE_EXTRA_CA_CERTS: '/etc/test-ca.pem',
        SSL_CERT_FILE: '/etc/test-cert.pem',
      },
    }).instance.install('claude', 'w');
    const env = await readFile(path.join(home, 'installer-env'), 'utf8');
    for (const name of ['BASH_ENV', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_PREFIX', 'npm_package_name', 'CLAUDE_CODE_SESSION_ID']) {
      expect(env).not.toContain(`${name}=`);
    }
    expect(env).not.toMatch(/^ENV=/m);
    expect(env).toContain('HTTPS_PROXY=http://proxy.test:3128');
    expect(env).toContain('HTTP_PROXY=http://proxy.test:3128');
    expect(env).toContain('NO_PROXY=localhost');
    expect(env).toContain('NODE_EXTRA_CA_CERTS=/etc/test-ca.pem');
    expect(env).toContain('SSL_CERT_FILE=/etc/test-cert.pem');
  });

  it('выход 0, но бинаря нет — отказ', async () => {
    routes.set('claude.ai/install.sh', { body: '#!/bin/sh\necho nothing\n' });
    const result = await installer().instance.install('claude', 'w');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('was not found') });
  });

  it('версия не узнана или проба упала — отказ', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    expect(await installer({ version: null }).instance.install('claude', 'w')).toMatchObject({ ok: false, version: null, error: expect.stringContaining('version') });
    routes.set('claude.ai/install.sh', { body: `${installerScript('claude')}\nprintf '#!/bin/sh\\nexit 3\\n' > "$HOME/.local/bin/claude"\n` });
    expect(await installer().instance.install('claude', 'w')).toMatchObject({ ok: false, version: '2.1.400', smoke: { ok: false }, error: expect.stringContaining('check run') });
  });

  it('временные папки установщика не остаются', async () => {
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('parley-install-') && !name.startsWith('parley-install-home') && !name.startsWith('parley-install-pki')));
    await installer().instance.install('claude', 'w');
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('parley-install-') && !name.startsWith('parley-install-home') && !name.startsWith('parley-install-pki'));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});

describe('установка CLI: занятость и платформа', () => {
  it('флаг занятости общий с обновлением: пока идёт обновление qwen, установка qwen — busy, и наоборот', async () => {
    const cli = createCliRun();
    let release!: () => void;
    const holding = cli.exclusive('qwen', () => new Promise<void>((resolve) => (release = resolve)));
    const { instance, exec } = installer({ cli });
    expect(await instance.install('qwen', 'w')).toEqual({ state: 'busy' });
    expect(exec).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    release();
    await holding;

    routes.set('claude.ai/install.sh', { hang: true });
    const updater = createCliUpdateRunner({
      log,
      cli,
      versions: { get: () => null, fresh: async () => null },
      updates: { latest: async () => null },
      runningSessions: async () => 0,
      env: { PATH: '' },
    });
    const pending = installer({ cli, downloadTimeoutMs: 500 }).instance.install('claude', 'w');
    expect(await updater.run('claude', 'w')).toEqual({ state: 'busy' });
    await pending;
  });

  it('разные CLI друг друга не блокируют', async () => {
    const cli = createCliRun();
    let release!: () => void;
    const holding = cli.exclusive('codex', () => new Promise<void>((resolve) => (release = resolve)));
    routes.set('claude.ai/install.sh', { body: installerScript('claude') });
    expect(await installer({ cli }).instance.install('claude', 'w')).toMatchObject({ state: 'done', ok: true });
    release();
    await holding;
  });

  it('Windows: ручная команда, ничего не скачивается и не запускается', async () => {
    const { instance, exec } = installer({ platform: 'win32' });
    expect(await instance.install('claude', 'w')).toEqual({
      state: 'done',
      ok: false,
      version: null,
      output: '',
      error: 'Parley does not run installers on Windows',
      manualCommand: 'irm https://claude.ai/install.ps1 | iex',
    });
    expect(await instance.install('qwen', 'w')).toMatchObject({ manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
    expect(await instance.install('opencode', 'w')).toMatchObject({ manualCommand: 'npm install -g @opencode/cli@latest' });
    expect(requests).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('команда не из таблицы — отказ без запуска', async () => {
    const { instance, exec } = installer();
    await expect(instance.install('mystery' as 'qwen', 'w')).rejects.toThrow('unsupported');
    expect(exec).not.toHaveBeenCalled();
  });
});
