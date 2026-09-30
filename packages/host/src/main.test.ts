import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { removeHome, tempHome } from '../test/helpers.js';
import { hostPaths } from './paths.js';

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const mainScript = fileURLToPath(new URL('./main.ts', import.meta.url));

const COMMANDS = ['claude', 'codex', 'glm'] as const;

let homes: string[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/**
 * Поднимает `tsx main.ts` с заглушками вместо ВСЕХ трёх команд реестра: настоящие claude и
 * codex здесь не запускаются никогда, даже с `--version`. Каждая заглушка при вызове дописывает
 * свои аргументы в `calls.txt` (`<команда>:<число аргументов>:<первый>`). Свежий исполняемый файл
 * система на macOS проверяет при первом запуске — секунды, дольше таймаута пробы, — поэтому
 * каждая заглушка сперва запускается впрок (`--warm`, на него она сразу выходит).
 * Возвращает записи `calls.txt` после того, как хост поднялся и проба отработала (или не пошла).
 */
async function hostCalls(skipProbe: boolean): Promise<string[]> {
  const home = await tempHome();
  homes.push(home);
  const bin = await mkdtemp(path.join(tmpdir(), 'parley-main-probe-'));
  dirs.push(bin);
  const calls = path.join(bin, 'calls.txt');

  const env: Record<string, string | undefined> = {
    ...process.env,
    HARNAS_HOME: home,
    // Явное значение в обе стороны: наследованное из настройки тестов выключало бы пробу.
    HARNAS_SKIP_VERSION_PROBE: skipProbe ? '1' : '0',
  };
  for (const name of COMMANDS) {
    const file = path.join(bin, name);
    await writeFile(
      file,
      `#!/bin/sh\n[ "$1" = "--warm" ] && exit 0\necho "${name}:$#:$1" >> "${calls}"\necho "1.2.3"\n`,
      'utf8',
    );
    await chmod(file, 0o755);
    await promisify(execFile)(file, ['--warm'], { timeout: 30_000 });
    env[`HARNAS_${name.toUpperCase()}_BIN`] = file;
  }

  const child = spawn(process.execPath, ['--import', tsxLoader, mainScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    expect(await waitFor(() => existsSync(hostPaths(home).pid), 20_000)).toBe(true);
    // Проба идёт сразу за стартом и быстрая. Без пробы даём ей время, которого хватило бы.
    const done = (): boolean =>
      existsSync(calls) && readFileSync(calls, 'utf8').trim().split('\n').length >= COMMANDS.length;
    await waitFor(done, skipProbe ? 2000 : 15_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill('SIGTERM');
    await once(child, 'exit');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  return existsSync(calls) ? (await readFile(calls, 'utf8')).trim().split('\n') : [];
}

describe('main.ts: проба версий CLI на старте (дизайн комнат, 3.2)', () => {
  it('по умолчанию хост зовёт у каждой команды реестра ровно `--version`, по одному разу', async () => {
    const calls = await hostCalls(false);
    expect(calls.sort()).toEqual(['claude:1:--version', 'codex:1:--version', 'glm:1:--version']);
  }, 60_000);

  it('HARNAS_SKIP_VERSION_PROBE=1 — ни одна команда не запускается: так живут тесты и E2E', async () => {
    expect(await hostCalls(true)).toEqual([]);
  }, 60_000);
});
