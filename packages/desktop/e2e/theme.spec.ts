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

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');

const isDark = (window: Page): Promise<boolean> => window.evaluate(() => document.documentElement.classList.contains('dark'));
const background = (window: Page): Promise<string> => window.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** Фон окна — `--background` = `surface` палитры Organic (спека окна 2026-09-29, раздел 4): светлая #ebddc5, тёмная #161513. */
const LIGHT_BACKGROUND = 'rgb(235, 221, 197)';
const DARK_BACKGROUND = 'rgb(22, 21, 19)';

test.describe('тема окна по nativeTheme main (спека 4.7, раунд main-r2)', () => {
  let home: string;
  /** Окно теста — его гасит afterEach, и после упавшего теста тоже. */
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('theme');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  async function launch(): Promise<Page> {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home } });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  /** Штатный выход перед перезапуском с тем же домом: хвост разбора Chromium не ждётся (`quitApp`). */
  async function quit(): Promise<void> {
    if (app !== null) await quitApp(app);
    app = null;
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
    expect(await background(window)).toBe(DARK_BACKGROUND);

    await pickTheme(window, 'Theme: light');
    await expect.poll(() => isDark(window)).toBe(false);
    expect(await background(window)).toBe(LIGHT_BACKGROUND);
  });

  test('выбранная тема переживает перезапуск окна и перезагрузку страницы', async () => {
    let window = await launch();
    await pickTheme(window, 'Theme: dark');
    await expect.poll(() => isDark(window)).toBe(true);
    await expect.poll(savedAppearance).toBe('dark');
    await quit();

    window = await launch();
    // С первого кадра — без ожидания события: начальная тёмность приходит синхронно.
    expect(await isDark(window)).toBe(true);
    expect(await background(window)).toBe(DARK_BACKGROUND);
    // Перезагрузка страницы: `.dark` ставит `main.tsx` до React, экран связи тут не важен.
    await window.reload({ waitUntil: 'load' });
    expect(await isDark(window)).toBe(true);
    await quit();

    window = await launch();
    await pickTheme(window, 'Theme: light');
    await expect.poll(() => isDark(window)).toBe(false);
    await expect.poll(savedAppearance).toBe('light');
    await quit();

    window = await launch();
    expect(await isDark(window)).toBe(false);
    expect(await background(window)).toBe(LIGHT_BACKGROUND);
  });

  // Облик Organic вживую (кусок 1 плана «Organic»): jsdom стилей не считает, поэтому то, что держат
  // `fonts.test.ts` и `lucide-stroke.test.tsx` по тексту CSS, здесь сверяется с настоящим окном.
  test('шрифты Figtree и Caprasimo грузятся из сборки, база окна 13px, значки lucide — 2.75', async () => {
    const window = await launch();
    const facts = await window.evaluate(async () => {
      // `load()` тянет файл из @font-face и отдаёт подошедшие начертания: запасной системный шрифт
      // дал бы пустой список, а не `loaded`.
      const loaded = async (font: string): Promise<string[]> =>
        (await document.fonts.load(font)).map((face) => `${face.family.replace(/"/g, '')}:${face.status}`);
      const body = getComputedStyle(document.body);
      const icon = document.querySelector('svg.lucide');
      return {
        family: body.fontFamily,
        size: body.fontSize,
        figtree: await loaded('500 13px Figtree'),
        caprasimo: await loaded('14px Caprasimo'),
        stroke: icon === null ? null : getComputedStyle(icon).strokeWidth,
      };
    });

    expect(facts.family.startsWith('Figtree')).toBe(true);
    expect(facts.size).toBe('13px');
    expect(facts.figtree).toEqual(['Figtree:loaded']);
    expect(facts.caprasimo).toEqual(['Caprasimo:loaded']);
    expect(facts.stroke, 'в окне нет ни одного значка lucide (svg.lucide)').not.toBeNull();
    expect(parseFloat(facts.stroke ?? '')).toBe(2.75);
  });
});
