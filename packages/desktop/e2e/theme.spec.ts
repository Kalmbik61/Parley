/**
 * Тест 3 куска 1.4 плана «облик Orca» (спека 4.7): тема окна следует за
 * системной схемой ОС независимо от того, подключён ли хост и что на экране —
 * `body { background: var(--background) }` в `styles/base.css` красит документ
 * сразу по CSS, а `<html>.dark` рендерер выставляет из `matchMedia` ещё до
 * первого кадра React (`main.tsx`). `electron.launch({ colorScheme })`
 * эмулирует `prefers-color-scheme` на уровне Chromium (Playwright) — этого
 * достаточно, реальный хост и сессии тут не нужны, поэтому в отличие от
 * `smoke.spec.ts` не ждём никакого текста на экране, только вычисленный стиль.
 *
 * Эмуляция применяется не мгновенно к моменту, когда `firstWindow()`
 * разрешается — гонка между стартовой загрузкой окна и подключением
 * CDP-сессии Playwright: `matchMedia(...).matches`, вызванный заново (как в
 * `waitForFunction` ниже), эмулированную схему уже видит, а вот однократное
 * чтение `dark` при загрузке модуля `store/ui.ts` могло случиться раньше, чем
 * подключилась эмуляция, — событие `change` у уже созданного `MediaQueryList`
 * при этом не приходит (опытным путём: без `reload()` тест то проходит, то
 * нет, в зависимости от того, кто в этой гонке успел раньше). Поэтому сперва
 * ждём, чтобы эмуляция точно была активна, и затем перезагружаем страницу —
 * `main.tsx` заново читает уже гарантированно верную схему до первого кадра.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { stopHost } from './stop-host.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Тот же защитный skip, что и в `smoke.spec.ts`: без сборки хоста окну нечего
// поднимать при старте.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const hostReady = existsSync(hostEntry);

test.skip(!hostReady, `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

test.describe('тема окна следует за системной схемой (кусок 1.4 плана «облик Orca», спека 4.7)', () => {
  let home: string;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-theme-'));
  });

  test.afterEach(async () => {
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('тёмная схема ОС — фон body #0a0a0a', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
      colorScheme: 'dark',
    });

    const window = await app.firstWindow();
    await window.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
    await window.reload();
    await window.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
    const background = await window.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(10, 10, 10)');

    await app.close();
  });

  test('светлая схема ОС — фон body #ffffff', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARNAS_HOME: home },
      colorScheme: 'light',
    });

    const window = await app.firstWindow();
    await window.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
    await window.reload();
    await window.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
    const background = await window.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(255, 255, 255)');

    await app.close();
  });
});
