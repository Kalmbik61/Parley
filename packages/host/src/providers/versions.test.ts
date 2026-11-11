import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Log } from '../log.js';
import { probeCliVersion, startProviderVersions } from './versions.js';

/**
 * Настоящие claude и codex здесь не запускаются никогда, даже с --version: проба зовётся
 * либо с подменой (`probe`), либо на выдуманную команду, чьё имя переменной-оверрайда
 * (`PARLEY_<ИМЯ>_BIN`) указывает на скрипт-заглушку во временном каталоге.
 */
const COMMAND = 'parley-fake-cli';
const OVERRIDE = 'PARLEY_PARLEY_FAKE_CLI_BIN';

let dir = '';
let home = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-versions-'));
  home = await mkdtemp(path.join(tmpdir(), 'parley-versions-home-'));
  process.env['PARLEY_HOME'] = home;
});

afterEach(async () => {
  delete process.env[OVERRIDE];
  delete process.env['PARLEY_HOME'];
  await Promise.all([dir, home].map((path_) => rm(path_, { recursive: true, force: true })));
});

/**
 * Кладёт скрипт-заглушку и направляет на неё оверрайд выдуманной команды. Свежий исполняемый
 * файл система на macOS проверяет при первом запуске, и это занимает секунды — дольше таймаута
 * пробы, — поэтому заглушка сперва запускается один раз впрок (`--warm`, скрипт на него сразу
 * выходит), а проба потом видит уже прогретый файл.
 */
async function stub(body: string): Promise<string> {
  const file = path.join(dir, 'fake-cli');
  await writeFile(file, `#!/bin/sh\n[ "$1" = "--warm" ] && exit 0\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
  await promisify(execFile)(file, ['--warm'], { timeout: 30_000 });
  process.env[OVERRIDE] = file;
  return file;
}

describe('probeCliVersion: одна проба `<команда> --version`', () => {
  it('claude-подобный ответ «2.1.276 (Claude Code)» — версия 2.1.276', async () => {
    await stub('[ "$1" = "--version" ] && echo "2.1.276 (Claude Code)"');
    expect(await probeCliVersion(COMMAND)).toBe('2.1.276');
  });

  it('codex-подобный ответ «codex-cli 0.44.0» — версия 0.44.0', async () => {
    await stub('[ "$1" = "--version" ] && echo "codex-cli 0.44.0"');
    expect(await probeCliVersion(COMMAND)).toBe('0.44.0');
  });

  it('зовётся ровно с одним аргументом --version — больше ничего не передаётся', async () => {
    const log = path.join(dir, 'argv.txt');
    await stub(`echo "$#:$1" > "${log}"; echo "1.2.3"`);
    await probeCliVersion(COMMAND);
    expect((await readFile(log, 'utf8')).trim()).toBe('1:--version');
  });

  it('ответ без версии, ненулевой выход, пустой вывод, нет бинаря — null', async () => {
    await stub('echo "нет версии здесь"');
    expect(await probeCliVersion(COMMAND)).toBeNull();
    await stub('echo "1.2.3"; exit 3');
    expect(await probeCliVersion(COMMAND)).toBeNull();
    await stub('true');
    expect(await probeCliVersion(COMMAND)).toBeNull();
    process.env[OVERRIDE] = path.join(dir, 'нет-такого');
    expect(await probeCliVersion(COMMAND)).toBeNull();
  });

  it('зависший бинарь обрывается по таймауту и убивается — процесса после пробы нет', async () => {
    const pidFile = path.join(dir, 'pid.txt');
    await stub(`echo $$ > "${pidFile}"; exec sleep 30`);

    const started = Date.now();
    // Таймаут с запасом: под нагрузкой (весь набор тестов разом) оболочка стартует не сразу,
    // а без записанного pid убитый процесс не проверить.
    expect(await probeCliVersion(COMMAND, 1500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(6000);

    for (let attempt = 0; attempt < 40 && !existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});

const silentLog = (): Log & { warnings: string[] } => {
  const warnings: string[] = [];
  return { info: () => {}, warn: (message: string) => void warnings.push(message), error: () => {}, warnings };
};

describe('startProviderVersions: одна проба на старте, с кэшем', () => {
  it('shares simultaneous retries and recovers from an unknown startup version', async () => {
    let calls = 0;
    let complete: ((value: string | null) => void) | undefined;
    const versions = startProviderVersions(async command => {
      if (command !== 'codex') return null;
      calls += 1;
      if (calls === 1) return null;
      return new Promise<string | null>(resolve => { complete = resolve; });
    }, silentLog(), { stamp: async () => null });
    await versions.ready;
    const first = versions.fresh('codex');
    const second = versions.fresh('codex');
    await vi.waitFor(() => expect(calls).toBe(2));
    complete!('0.162.0');
    expect(await Promise.all([first, second])).toEqual(['0.162.0', '0.162.0']);
    expect(versions.get('codex')).toBe('0.162.0');
  });

  it('fresh reuses the supplied probe after an upgrade and updates the cache', async () => {
    let version = '2.1.286';
    const versions = startProviderVersions(async () => version, silentLog(), { stamp: async () => null });
    await versions.ready;
    expect(versions.get('claude')).toBe('2.1.286');
    version = '2.1.287';
    expect(await versions.fresh('claude')).toBe('2.1.287');
    expect(versions.get('claude')).toBe('2.1.287');
    expect(await startProviderVersions(undefined, silentLog()).fresh('claude')).toBeNull();
  });
  it('без пробы (тесты, PARLEY_SKIP_VERSION_PROBE) версий нет и ничего не запускается', async () => {
    const versions = startProviderVersions(undefined, silentLog());
    await versions.ready;
    expect(versions.get('claude')).toBeNull();
  });

  it('каждая команда реестра пробуется один раз; версии лежат в кэше и не перечитываются', async () => {
    const calls: string[] = [];
    const versions = startProviderVersions(async (command) => {
      calls.push(command);
      return command === 'claude' ? '2.1.276' : command === 'codex' ? '0.44.0' : null;
    }, silentLog());
    await versions.ready;

    expect(calls.sort()).toEqual(['claude', 'codex', 'qwen']);
    expect(versions.get('claude')).toBe('2.1.276');
    expect(versions.get('codex')).toBe('0.44.0');
    expect(versions.get('glm')).toBeNull();
    expect(versions.get('claude')).toBe('2.1.276');
    expect(calls).toHaveLength(3);
  });

  it('пробуются и провайдеры из providers.json, и одна команда — один раз', async () => {
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ opencode: { badge: 'OpenCode', command: 'opencode' }, claude2: { badge: 'C2', command: 'claude' } }),
      'utf8',
    );
    const calls: string[] = [];
    const versions = startProviderVersions(async (command) => {
      calls.push(command);
      return '9.9.9';
    }, silentLog());
    await versions.ready;

    expect(calls.sort()).toEqual(['claude', 'codex', 'opencode', 'qwen']);
    expect(versions.get('opencode')).toBe('9.9.9');
  });

  it('проба упала — версия null, остальные пробы не страдают, ready не отказывает', async () => {
    const versions = startProviderVersions(async (command) => {
      if (command === 'claude') throw new Error('сломалась');
      return '0.1.0';
    }, silentLog());
    await expect(versions.ready).resolves.toBeUndefined();

    expect(versions.get('claude')).toBeNull();
    expect(versions.get('codex')).toBe('0.1.0');
  });

  it('битый providers.json — версий нет, в журнале предупреждение, ready не отказывает', async () => {
    await writeFile(path.join(home, 'providers.json'), '{не json', 'utf8');
    const log = silentLog();
    const versions = startProviderVersions(async () => '1.0.0', log);
    await expect(versions.ready).resolves.toBeUndefined();

    expect(versions.get('claude')).toBeNull();
    expect(log.warnings).toHaveLength(1);
  });

  it('команду, которой не было в реестре на старте, не пробуют: версия null', async () => {
    const versions = startProviderVersions(async () => '1.0.0', silentLog());
    await versions.ready;
    expect(versions.get('позже-добавленная')).toBeNull();
  });
});


/**
 * Скрипт на node: считает свои запуски в файле и печатает версию. Это «интерпретируемый» бинарь (кэш с отпечатком),
 * в отличие от обёртки на оболочке. `#!` ведёт на абсолютный node, чтобы PATH теста не играл роли.
 */
async function nodeStub(version: string, name = 'fake-cli'): Promise<string> {
  const file = path.join(dir, name);
  const count = path.join(dir, 'count.txt');
  await writeFile(
    file,
    `#!${process.execPath}\nif (process.argv[2] === '--warm') process.exit(0);\nrequire('node:fs').appendFileSync(${JSON.stringify(count)}, 'x\\n');\nconsole.log(${JSON.stringify(version)});\n`,
    'utf8',
  );
  await chmod(file, 0o755);
  await promisify(execFile)(file, ['--warm'], { timeout: 30_000 });
  return file;
}

const spawned = async (): Promise<number> => {
  try {
    return (await readFile(path.join(dir, 'count.txt'), 'utf8')).split('\n').filter((line) => line !== '').length;
  } catch {
    return 0;
  }
};

/** Только своя команда доходит до настоящего процесса; настоящие claude и codex реестра не запускаются. */
const realProbe = (command: string): Promise<string | null> => (command === COMMAND ? probeCliVersion(command) : Promise.resolve(null));

describe('fresh: кэш проб версий по бинарю', () => {
  it('20 одинаковых запросов запускают один процесс: и одновременные, и последовательные', async () => {
    process.env[OVERRIDE] = await nodeStub('1.2.3');
    const versions = startProviderVersions(realProbe, silentLog());
    await versions.ready;
    const together = await Promise.all(Array.from({ length: 10 }, () => versions.fresh(COMMAND)));
    expect(together.every((version) => version === '1.2.3')).toBe(true);
    for (let index = 0; index < 10; index += 1) expect(await versions.fresh(COMMAND)).toBe('1.2.3');
    expect(await spawned()).toBe(1);
    expect(versions.get(COMMAND)).toBe('1.2.3');
  });

  it('замена файла на месте (другие размер и mtime) видна следующей пробе', async () => {
    const file = await nodeStub('1.2.3');
    process.env[OVERRIDE] = file;
    const versions = startProviderVersions(realProbe, silentLog());
    await versions.ready;
    expect(await versions.fresh(COMMAND)).toBe('1.2.3');
    await nodeStub('1.2.40');
    await utimes(file, new Date(), new Date(Date.now() + 60_000));
    expect(await versions.fresh(COMMAND)).toBe('1.2.40');
    expect(await spawned()).toBe(2);
  });

  it('симлинк, переведённый на файл новой версии, виден следующей пробе (nvm, Cellar, ~/.local/bin)', async () => {
    const one = await nodeStub('1.0.0', 'cli-1');
    const two = await nodeStub('2.0.0', 'cli-2');
    const link = path.join(dir, 'cli');
    await symlink(one, link);
    process.env[OVERRIDE] = link;
    const versions = startProviderVersions(realProbe, silentLog());
    await versions.ready;
    expect(await versions.fresh(COMMAND)).toBe('1.0.0');
    expect(await versions.fresh(COMMAND)).toBe('1.0.0');
    expect(await spawned()).toBe(1);
    await rm(link);
    await symlink(two, link);
    expect(await versions.fresh(COMMAND)).toBe('2.0.0');
    expect(await spawned()).toBe(2);
  });

  it('обёртка на оболочке не кэшируется: каждый вызов запускает процесс', async () => {
    await stub(`echo x >> "${path.join(dir, 'count.txt')}"; echo "3.0.0"`);
    const versions = startProviderVersions(realProbe, silentLog());
    await versions.ready;
    for (let index = 0; index < 3; index += 1) expect(await versions.fresh(COMMAND)).toBe('3.0.0');
    expect(await spawned()).toBe(3);
  });

  it('force обходит кэш и обновляет его', async () => {
    process.env[OVERRIDE] = await nodeStub('1.2.3');
    const versions = startProviderVersions(realProbe, silentLog());
    await versions.ready;
    await versions.fresh(COMMAND);
    await versions.fresh(COMMAND, { force: true });
    await versions.fresh(COMMAND, { force: true });
    expect(await spawned()).toBe(3);
    await versions.fresh(COMMAND);
    expect(await spawned()).toBe(3);
  });

  it('null-ответ повторно не пробуется 29 999 мс и пробуется после 30 000', async () => {
    let clock = 0;
    process.env[OVERRIDE] = await nodeStub('');
    const versions = startProviderVersions(realProbe, silentLog(), { now: () => clock });
    await versions.ready;
    clock = 1;
    expect(await versions.fresh(COMMAND)).toBeNull();
    clock = 29_999;
    expect(await versions.fresh(COMMAND)).toBeNull();
    expect(await spawned()).toBe(1);
    clock = 30_002;
    await versions.fresh(COMMAND);
    expect(await spawned()).toBe(2);
  });

  it('нет бинаря: null на 30 с без повторных проб; появившийся файл виден сразу', async () => {
    let calls = 0;
    const missing = path.join(dir, 'late-cli');
    process.env[OVERRIDE] = missing;
    const versions = startProviderVersions(async (command) => {
      if (command !== COMMAND) return null;
      calls += 1;
      return existsSync(missing) ? '4.0.0' : null;
    }, silentLog());
    await versions.ready;
    for (let index = 0; index < 5; index += 1) expect(await versions.fresh(COMMAND)).toBeNull();
    expect(calls).toBe(1);
    await nodeStub('4.0.0', 'late-cli');
    expect(await versions.fresh(COMMAND)).toBe('4.0.0');
    expect(calls).toBe(2);
  });
});
