import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

/**
 * Битый `works-index.json` на старте хоста (раунд lane-r5, п. 1). Прежде хост после listen
 * падал в первом чтении работ, и works.list не отвечал никогда: окно висело на пустом сайдбаре.
 * Теперь works.list отвечает отказом с причиной `works-unreadable`: окно показывает причину по-
 * английски, Landing не рисует и сохранённые раскладки не отсеивает (пустой список — не ответ).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

test.describe('битый works-index.json на старте хоста (lane-r5)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('unreadable');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('окно видит причину отказа, Landing нет, раскладки и индекс не тронуты', async () => {
    const index = path.join(home, 'works-index.json');
    await writeFile(index, '{ broken');
    const layouts = path.join(home, 'desktop', 'layouts.json');
    await mkdir(path.dirname(layouts), { recursive: true });
    const savedLayouts = `${JSON.stringify({ version: 2, works: { '/tmp/p\u0000w-0001': { saved: true } } }, null, 2)}\n`;
    await writeFile(layouts, savedLayouts);

    app = await electron.launch({ args: [mainEntry], env: { ...process.env, HARNAS_HOME: home } });
    const window = await app.firstWindow();

    await expect(window.getByRole('alert')).toContainText("Host couldn't read the workspace list");
    await expect(window.getByTestId('landing')).toHaveCount(0);
    // Хост жив и отвечает: методы вне снимка работают, works.list — отказ, а не вечное ожидание.
    const info = await window.evaluate(() => (globalThis as unknown as Parley).parley.call('host.info', {}));
    expect(info).toBeTruthy();
    const listed = await window.evaluate(() =>
      (globalThis as unknown as Parley).parley.call('works.list', {}).then(
        () => 'resolved',
        (error: unknown) => String(error),
      ),
    );
    expect(listed).toContain('works-unreadable');
    expect(await readFile(layouts, 'utf8')).toBe(savedLayouts);
    expect(await readFile(index, 'utf8')).toBe('{ broken');
  });
});
