import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
// Требуется для второго теста: путь к самому бинарю Electron, не к
// электронной обёртке API. Импорт `electron` вне рантайма Electron
// возвращает именно этот путь строкой (тот же механизм, что использует
// playwright-core внутри electron.launch()).
import electronBinary from 'electron';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Тест поднимает настоящий хост из собранного @harnas/host — без `pnpm --filter
// @harnas/host build` (и `pnpm --filter @harnas/desktop build`) ему нечего
// запускать. Защитный skip — на случай свежего клона без сборки, а не на
// случай отсутствия самого пакета.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const hostReady = existsSync(hostEntry);

test.skip(!hostReady, `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

test.describe('окно поднимает хост и переживает его перезапуск', () => {
  let home: string;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-'));
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('пустой список работ, хост поднят, Node в рендерере недоступен', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
    });

    const window = await app.firstWindow();
    await expect(window.getByText('Работ пока нет')).toBeVisible();
    expect(existsSync(path.join(home, 'host', 'host.sock'))).toBe(true);

    const requireType = await window.evaluate(() => typeof (globalThis as { require?: unknown }).require);
    expect(requireType).toBe('undefined');

    const bridgeType = await window.evaluate(() => typeof (globalThis as { harnas?: unknown }).harnas);
    expect(bridgeType).not.toBe('undefined');

    await app.close();
  });

  test('второй запуск фокусирует первое окно и завершается сам', async () => {
    const first = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
    });
    await first.firstWindow();

    // Второй экземпляр обычно завершается (app.quit()) раньше, чем Playwright
    // успевает подключить к нему CDP через electron.launch() — тот тогда сам
    // бросает ошибку вместо того, чтобы отдать «закрывшийся» handle. Поэтому
    // второй процесс поднимаем напрямую и ждём только его кода выхода.
    const secondExitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(electronBinary, [mainEntry], {
        env: { ...process.env, HARNAS_HOME: home },
      });
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    expect(secondExitCode).toBe(0);

    expect(first.windows().length).toBe(1);
    await first.close();
  });
});
