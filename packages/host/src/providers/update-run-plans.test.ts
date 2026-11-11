import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliRun } from './cli-run.js';
import { createCliUpdateRunner, NPM_REGISTRY } from './update-run.js';

/**
 * План обновления из таблицы `CLI_TOOLS` (спека 2026-11-11, §4.1, §4.3). Настоящих qwen, node и npm здесь нет:
 * всё — скрипты-заглушки во временной папке; сеть не трогается. Заглушка node на `--version` отвечает версией из
 * файла `node-version` рядом, на всё остальное записывает argv и окружение — значит, «ничего не запущено» видно по
 * отсутствию этих файлов.
 */
let root = '';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function stub(file: string, body: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(file, 0o755);
  // Свежий исполняемый файл на macOS проверяется при первом запуске долго: греем его заранее.
  execFileSync(file, ['--warm'], { stdio: 'ignore' });
  return file;
}

interface Prefix {
  prefix: string;
  qwen: string;
  node: string;
  npmCli: string;
  argv: string;
  env: string;
  userconfigSize: string;
}

/** npm-префикс с установленным qwen: `bin/qwen` → `lib/node_modules/@qwen-code/qwen-code/cli.js`, свой node и npm. */
async function npmPrefix(name: string, parts: { node?: boolean; npm?: boolean; nodeVersion?: string; engines?: string } = {}): Promise<Prefix> {
  const prefix = path.join(root, name);
  const pkg = path.join(prefix, 'lib/node_modules/@qwen-code/qwen-code');
  const argv = path.join(prefix, 'argv');
  const env = path.join(prefix, 'env');
  const userconfigSize = path.join(prefix, 'userconfig-size');
  await stub(path.join(pkg, 'cli.js'), `echo "$@" > "${prefix}/smoke-args"; echo 0.28.0`);
  await rm(path.join(prefix, 'smoke-args'), { force: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', engines: { node: parts.engines ?? '>=22.0.0' } }));
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  const qwen = path.join(prefix, 'bin/qwen');
  await symlink('../lib/node_modules/@qwen-code/qwen-code/cli.js', qwen);
  const node = path.join(prefix, 'bin/node');
  if (parts.node !== false) {
    await writeFile(path.join(prefix, 'node-version'), parts.nodeVersion ?? 'v22.12.0');
    await stub(
      node,
      `case "$1" in
  --version) cat "${prefix}/node-version" ;;
  --warm) ;;
  *)
    for arg in "$@"; do printf '%s\\n' "$arg"; done > "${argv}"
    env > "${env}"
    [ -f "$8" ] && wc -c < "$8" | tr -d ' ' > "${userconfigSize}"
    echo "added 1 package"
    ;;
esac`,
    );
  }
  const npmCli = path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
  if (parts.npm !== false) {
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, '// stub\n');
  }
  return { prefix, qwen, node, npmCli, argv, env, userconfigSize };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-update-plans-')));
  log.info.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Options {
  bin: string;
  command?: 'qwen' | 'codex' | 'claude';
  now?: string | null;
  after?: string | null;
  latest?: string | null;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  cli?: ReturnType<typeof createCliRun>;
}

function runner(options: Options) {
  const command = options.command ?? 'qwen';
  const fresh = vi.fn(async () => (options.after === undefined ? '0.28.0' : options.after));
  const update = createCliUpdateRunner({
    log,
    versions: { get: () => (options.now === undefined ? '0.27.2' : options.now), fresh },
    updates: { latest: async () => (options.latest === undefined ? '0.28.0' : options.latest) },
    runningSessions: async () => 0,
    env: { [`PARLEY_${command.toUpperCase()}_BIN`]: options.bin, PATH: '/usr/bin:/bin', ...options.env },
    userHome: options.userHome ?? path.join(root, 'home'),
    timeoutMs: 20_000,
    smokeTimeoutMs: 20_000,
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  });
  return { update, fresh };
}

const lines = async (file: string): Promise<string[]> => (await readFile(file, 'utf8')).trimEnd().split('\n');

describe('qwen: автономная установка', () => {
  it('запускается `<бинарь> update`, проба — `--version`', async () => {
    const home = path.join(root, 'home');
    const bin = await stub(
      path.join(home, '.local/lib/qwen-code/bin/qwen'),
      `case "$1" in
  update) echo "$@" > "${root}/update-args"; echo updated ;;
  --warm) ;;
  *) echo "$@" > "${root}/smoke-args"; echo 0.28.0 ;;
esac`,
    );
    const { update } = runner({ bin, userHome: home });
    const result = await update.run('qwen', 'w');
    expect(result).toMatchObject({ state: 'done', ok: true, from: '0.27.2', to: '0.28.0', smoke: { ok: true } });
    expect((await readFile(path.join(root, 'update-args'), 'utf8')).trim()).toBe('update');
    expect((await readFile(path.join(root, 'smoke-args'), 'utf8')).trim()).toBe('--version');
  });
});

describe('qwen: привязанное npm-обновление', () => {
  it('заглушка node получает ровно argv §4.3 с --prefix активной установки и пустым userconfig, который потом удаляется', async () => {
    const a = await npmPrefix('prefix-a');
    const { update } = runner({ bin: a.qwen });
    const result = await update.run('qwen', 'w');
    expect(result).toMatchObject({ state: 'done', ok: true, from: '0.27.2', to: '0.28.0', smoke: { ok: true } });
    const argv = await lines(a.argv);
    expect(argv).toEqual([a.npmCli, 'install', '-g', '--prefix', a.prefix, `--registry=${NPM_REGISTRY}`, '--userconfig', expect.any(String), '@qwen-code/qwen-code@latest']);
    expect(NPM_REGISTRY).toBe('https://registry.npmjs.org/');
    expect((await readFile(a.userconfigSize, 'utf8')).trim()).toBe('0');
    expect(existsSync(argv[7] as string)).toBe(false);
    expect((await readFile(path.join(a.prefix, 'smoke-args'), 'utf8')).trim()).toBe('--version');
  });

  it('две установки на диске: обновляется та, что запускает Parley', async () => {
    const a = await npmPrefix('prefix-a');
    const b = await npmPrefix('prefix-b');
    const { update } = runner({ bin: b.qwen });
    expect(await update.run('qwen', 'w')).toMatchObject({ ok: true });
    expect(existsSync(a.argv)).toBe(false);
    const argv = await lines(b.argv);
    expect(argv[0]).toBe(b.npmCli);
    expect(argv[4]).toBe(b.prefix);
  });

  it.each([
    ['нет node рядом с установкой', { node: false }],
    ['нет npm-cli.js рядом с установкой', { npm: false }],
  ])('%s — ручная команда, ничего не запускается и версия не пробуется', async (_label, parts) => {
    const a = await npmPrefix('prefix-a', parts);
    const { update, fresh } = runner({ bin: a.qwen });
    const result = await update.run('qwen', 'w');
    expect(result).toMatchObject({ state: 'done', ok: false, from: '0.27.2', to: '0.27.2', manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
    expect(result).not.toHaveProperty('smoke');
    expect((result as { output: string }).output).toContain('missing');
    expect(existsSync(a.argv)).toBe(false);
    expect(existsSync(path.join(a.prefix, 'smoke-args'))).toBe(false);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('npm на PATH не берётся: без своего node установка не обновляется, даже если в PATH есть node и npm', async () => {
    const a = await npmPrefix('prefix-a', { node: false });
    const pathDir = path.join(root, 'path-bin');
    await stub(path.join(pathDir, 'npm'), `echo "$@" > "${root}/path-npm"`);
    await stub(path.join(pathDir, 'node'), `echo "$@" > "${root}/path-node"; echo v22.12.0`);
    await rm(path.join(root, 'path-npm'), { force: true });
    await rm(path.join(root, 'path-node'), { force: true });
    const { update } = runner({ bin: a.qwen, env: { PATH: `${pathDir}:/usr/bin:/bin` } });
    expect(await update.run('qwen', 'w')).toMatchObject({ ok: false, manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
    expect(existsSync(path.join(root, 'path-npm'))).toBe(false);
    expect(existsSync(path.join(root, 'path-node'))).toBe(false);
  });

  it('Node ниже 22 — ручная команда с причиной, npm не запускается', async () => {
    const a = await npmPrefix('prefix-a', { nodeVersion: 'v20.11.1' });
    const { update } = runner({ bin: a.qwen });
    const result = await update.run('qwen', 'w');
    expect(result).toMatchObject({ ok: false, manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
    expect((result as { output: string }).output).toContain('Node 20.11.1');
    expect((result as { output: string }).output).toContain('>=22.0.0');
    expect(existsSync(a.argv)).toBe(false);
  });

  it('engines.node пакета выше 22 поднимает границу', async () => {
    const a = await npmPrefix('prefix-a', { nodeVersion: 'v22.12.0', engines: '>=24.1' });
    const result = await runner({ bin: a.qwen }).update.run('qwen', 'w');
    expect((result as { output: string }).output).toContain('>=24.1.0');
    expect(existsSync(a.argv)).toBe(false);
  });

  it('окружение: BASH_ENV, NODE_OPTIONS и npm_config_registry не доходят, HTTPS_PROXY и NODE_EXTRA_CA_CERTS доходят', async () => {
    const a = await npmPrefix('prefix-a');
    const { update } = runner({
      bin: a.qwen,
      env: {
        BASH_ENV: path.join(root, 'no-such-rc'),
        NODE_OPTIONS: '--require /no/such.js',
        npm_config_registry: 'https://evil.example/',
        NPM_CONFIG_USERCONFIG: '/no/such/npmrc',
        npm_package_name: 'x',
        NODE_PATH: '/no/such',
        HTTPS_PROXY: 'http://proxy.test:3128',
        NODE_EXTRA_CA_CERTS: '/etc/test-ca.pem',
      },
    });
    expect(await update.run('qwen', 'w')).toMatchObject({ ok: true });
    const env = await readFile(a.env, 'utf8');
    expect(env).not.toContain('BASH_ENV');
    expect(env).not.toContain('NODE_OPTIONS');
    expect(env).not.toContain('npm_config_registry');
    expect(env).not.toContain('NPM_CONFIG_USERCONFIG');
    expect(env).not.toContain('npm_package_name');
    expect(env).not.toContain('NODE_PATH');
    expect(env).toContain('HTTPS_PROXY=http://proxy.test:3128');
    expect(env).toContain('NODE_EXTRA_CA_CERTS=/etc/test-ca.pem');
  });

  it.each([
    ['версия не изменилась и не равна найденной', '0.27.2'],
    ['откат', '0.26.0'],
  ])('%s — неудача с ручной командой', async (_label, after) => {
    const a = await npmPrefix('prefix-a');
    const result = await runner({ bin: a.qwen, now: '0.27.2', after, latest: '0.28.0' }).update.run('qwen', 'w');
    expect(result).toMatchObject({ state: 'done', ok: false, to: after, manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
  });
});

describe('qwen: brew и неизвестный способ', () => {
  it('brew — ручная команда brew upgrade, ничего не запускается', async () => {
    const bin = await stub(path.join(root, 'brew/Cellar/qwen-code/0.27.2/bin/qwen'), `[ "$1" = --warm ] || echo "$@" > "${root}/spawned"`);
    const { update, fresh } = runner({ bin });
    const result = await update.run('qwen', 'w');
    expect(result).toMatchObject({ state: 'done', ok: false, manualCommand: 'brew upgrade qwen-code' });
    expect(existsSync(path.join(root, 'spawned'))).toBe(false);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('неизвестный способ — ручная npm-команда, ничего не запускается', async () => {
    const bin = await stub(path.join(root, 'somewhere/qwen'), `[ "$1" = --warm ] || echo "$@" > "${root}/spawned"`);
    const result = await runner({ bin }).update.run('qwen', 'w');
    expect(result).toMatchObject({ ok: false, manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
    expect(existsSync(path.join(root, 'spawned'))).toBe(false);
  });
});

describe('флаг занятости, общий с установкой', () => {
  it('пока установка qwen держит общий раннер, обновление qwen получает busy и ничего не запускает', async () => {
    const a = await npmPrefix('prefix-a');
    const cli = createCliRun();
    let release!: () => void;
    const install = cli.exclusive('qwen', () => new Promise<void>((resolve) => (release = resolve)));
    const { update } = runner({ bin: a.qwen, cli });
    expect(await update.run('qwen', 'w')).toEqual({ state: 'busy' });
    expect(existsSync(a.argv)).toBe(false);
    release();
    await install;
    expect(await update.run('qwen', 'w')).toMatchObject({ state: 'done', ok: true });
  });

  it('два одновременных обновления qwen: второе — busy', async () => {
    const a = await npmPrefix('prefix-a');
    const { update } = runner({ bin: a.qwen });
    const first = update.run('qwen', 'a');
    expect(await update.run('qwen', 'b')).toEqual({ state: 'busy' });
    expect(await first).toMatchObject({ state: 'done', ok: true });
  });

  it('разные CLI не блокируют друг друга: обновление codex идёт, qwen обновляется', async () => {
    const a = await npmPrefix('prefix-a');
    const codex = await stub(path.join(root, 'codex-bin/codex'), `case "$1" in update) sleep 1 ;; *) ;; esac`);
    const cli = createCliRun();
    let codexDone = false;
    const codexRun = runner({ bin: codex, command: 'codex', now: '0.162.0', after: '0.166.0', latest: '0.166.0', cli })
      .update.run('codex', 'a')
      .finally(() => (codexDone = true));
    const qwen = await runner({ bin: a.qwen, cli }).update.run('qwen', 'b');
    expect(qwen).toMatchObject({ state: 'done', ok: true });
    expect(codexDone).toBe(false);
    expect(await codexRun).toMatchObject({ state: 'done', ok: true });
  });
});

describe('claude: проба после обновления', () => {
  it('проба Claude — безобидное `--version`', async () => {
    const bin = await stub(
      path.join(root, 'claude-bin/claude'),
      `case "$1" in
  update) exit 0 ;;
  --warm) ;;
  *) echo "$@" > "${root}/smoke-args"; echo "2.1.320 (Claude Code)" ;;
esac`,
    );
    const result = await runner({ bin, command: 'claude', now: '2.1.300', after: '2.1.320', latest: '2.1.320' }).update.run('claude', 'w');
    expect(result).toMatchObject({ ok: true, smoke: { ok: true } });
    expect((await readFile(path.join(root, 'smoke-args'), 'utf8')).trim()).toBe('--version');
  });
});
