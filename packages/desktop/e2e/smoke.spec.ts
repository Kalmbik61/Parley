import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
// Требуется для второго теста: путь к самому бинарю Electron, не к
// электронной обёртке API. Импорт `electron` вне рантайма Electron
// возвращает именно этот путь строкой (тот же механизм, что использует
// playwright-core внутри electron.launch()).
import electronBinary from 'electron';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');

test.describe('окно поднимает хост и переживает его перезапуск', () => {
  let home: string;
  /** Окно теста — его гасит afterEach, и после упавшего теста тоже. */
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('smoke');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('пустой список работ, хост поднят, Node в рендерере недоступен', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
    });
    running = app;

    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    expect(existsSync(path.join(home, 'host', 'host.sock'))).toBe(true);

    const requireType = await window.evaluate(() => typeof (globalThis as { require?: unknown }).require);
    expect(requireType).toBe('undefined');

    const bridgeType = await window.evaluate(() => typeof (globalThis as { harnas?: unknown }).harnas);
    expect(bridgeType).not.toBe('undefined');
  });

  test('ожидаемый отказ канала не печатается в stderr main, сбой — печатается (fix-lane-post, п. 4)', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
    });
    running = app;
    let mainLog = '';
    app.process().stderr?.on('data', (chunk: Buffer) => {
      mainLog += chunk.toString('utf8');
    });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    const callCode = (method: string, params: unknown): Promise<string> =>
      window.evaluate(
        async ([m, p]) => {
          const bridge = (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas;
          return bridge.call(m, p).then(
            () => 'ok',
            (error: unknown) => String(error),
          );
        },
        [method, params] as const,
      );
    // Неверные параметры — хост отвечает bad_request: окно покажет свой текст, это не сбой main.
    expect(await callCode('works.create', {})).toContain('bad_request');
    // Неизвестный метод — `failed`: такой отказ Electron по-прежнему печатает.
    expect(await callCode('no.such.method', {})).toContain('failed');
    await expect.poll(() => mainLog).toContain("Error occurred in handler for 'host:call'");
    expect(mainLog).toContain('unknown method: no.such.method');
    expect(mainLog).not.toContain('bad_request');
  });

  test('второй запуск фокусирует первое окно и завершается сам', async () => {
    const first = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
    });
    running = first;
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
  });
});
