import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

/**
 * Уборка E2E после упавшего теста (fix-tests, п. 2): под нагрузкой тест падал раньше, чем хост
 * записывал pid-файл, или afterEach тратил таймаут на выход Electron — и хост его дома жил
 * дальше. Здесь те же пути уборки, что у упавшего теста, проверяются напрямую.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hostPid(home: string): Promise<number> {
  const file = path.join(home, 'host', 'host.pid');
  await expect.poll(() => existsSync(file)).toBe(true);
  // Первая строка замка — pid, вторая — время старта процесса (раунд lane-r5).
  return Number((await readFile(file, 'utf8')).split('\n')[0]);
}

test.describe('уборка E2E: хост теста не переживает его падение', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('teardown');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('хост без pid-файла (тест упал до его записи) находится по host.err и гасится', async () => {
    // Хост как после выхода окна: отделён, родитель — launchd (оболочка-посредник сразу
    // выходит), stderr — в host.err его дома, как у `spawnHost`.
    const dir = path.join(home, 'host');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const shell = spawn('/bin/sh', ['-c', `${quote(process.execPath)} ${quote(hostEntry)} </dev/null >/dev/null 2>>${quote(path.join(dir, 'host.err'))} &`], {
      env: { ...process.env, HARNAS_HOME: home },
      stdio: 'ignore',
    });
    await once(shell, 'exit');
    const pid = await hostPid(home);
    // Состояние «pid-файла ещё нет»: хост жив, найти его можно только по host.err.
    await rm(path.join(dir, 'host.pid'));
    expect(isAlive(pid)).toBe(true);

    await stopHost(home);
    expect(isAlive(pid)).toBe(false);
  });

  test('окно, брошенное посреди теста, и поднятый им хост гасятся уборкой afterEach', async () => {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, HARNAS_HOME: home } });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    const electronPid = app.process().pid ?? 0;
    const pid = await hostPid(home);
    expect(isAlive(pid)).toBe(true);

    // Тот же путь, что у afterEach упавшего теста.
    await stopApp(app);
    app = null;
    await stopHost(home);
    expect(isAlive(electronPid)).toBe(false);
    expect(isAlive(pid)).toBe(false);
  });
});
