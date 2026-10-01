import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    expect(calls.sort()).toEqual(['claude', 'codex', 'glm']);
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

    expect(calls.sort()).toEqual(['claude', 'codex', 'glm', 'opencode']);
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
