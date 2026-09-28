/**
 * Тема окна (спека 4.7; раунд main-r2, п. 1 — ревью 6.3-B, Important 1). Источник истины —
 * `nativeTheme` main: рендерер берёт начальную тёмность синхронно (`app:is-dark`) и следит за
 * `app:appearance`. Выбор «Theme: dark» / «Theme: light» в палитре меняет `nativeTheme.themeSource`
 * и `ui.json` — `.dark` на `<html>` должен смениться сразу и остаться тем же после перезапуска окна.
 *
 * Запуск — без `colorScheme`: с ним Playwright подменяет `prefers-color-scheme` в обход
 * `nativeTheme`, и тест проверял бы эмуляцию, а не окно. По той же причине ожидания не зависят
 * от системной темы машины: сначала тема выбирается явно.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Без сборки хоста окну нечего поднимать при старте.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

const isDark = (window: Page): Promise<boolean> => window.evaluate(() => document.documentElement.classList.contains('dark'));
const background = (window: Page): Promise<string> => window.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('тема окна по nativeTheme main (спека 4.7, раунд main-r2)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-theme-'));
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  async function launch(): Promise<Page> {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, HARNAS_HOME: home } });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  async function pickTheme(window: Page, label: 'Theme: dark' | 'Theme: light'): Promise<void> {
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type(label);
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(label);
    await window.keyboard.press('Enter');
    await expect(window.locator('[data-palette]')).toHaveCount(0);
  }

  async function savedAppearance(): Promise<unknown> {
    const file = JSON.parse(await readFile(path.join(home, 'desktop', 'ui.json'), 'utf8')) as { appearance?: unknown };
    return file.appearance;
  }

  test('Theme: dark / Theme: light из палитры меняют .dark сразу', async () => {
    const window = await launch();

    await pickTheme(window, 'Theme: dark');
    await expect.poll(() => isDark(window)).toBe(true);
    expect(await background(window)).toBe('rgb(10, 10, 10)');

    await pickTheme(window, 'Theme: light');
    await expect.poll(() => isDark(window)).toBe(false);
    expect(await background(window)).toBe('rgb(255, 255, 255)');
  });

  test('выбранная тема переживает перезапуск окна и перезагрузку страницы', async () => {
    let window = await launch();
    await pickTheme(window, 'Theme: dark');
    await expect.poll(() => isDark(window)).toBe(true);
    await expect.poll(savedAppearance).toBe('dark');
    await app?.close();

    window = await launch();
    // С первого кадра — без ожидания события: начальная тёмность приходит синхронно.
    expect(await isDark(window)).toBe(true);
    expect(await background(window)).toBe('rgb(10, 10, 10)');
    // Перезагрузка страницы: `.dark` ставит `main.tsx` до React, экран связи тут не важен.
    await window.reload({ waitUntil: 'load' });
    expect(await isDark(window)).toBe(true);
    await app?.close();

    window = await launch();
    await pickTheme(window, 'Theme: light');
    await expect.poll(() => isDark(window)).toBe(false);
    await expect.poll(savedAppearance).toBe('light');
    await app?.close();

    window = await launch();
    expect(await isDark(window)).toBe(false);
    expect(await background(window)).toBe('rgb(255, 255, 255)');
  });
});
