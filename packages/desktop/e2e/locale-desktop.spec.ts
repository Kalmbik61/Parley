import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const size = { width: 800, height: 500 };
const cases = [
  {
    locale: 'en', topMenu: ['Parley', 'Edit', 'View', 'Workspace', 'Tab', 'Terminal'],
    nativeEdit: 'Undo', settings: 'Settings', notifications: 'Notifications', notifySound: "Sound when you're needed",
    palette: 'Command palette', query: 'toggle workspace sidebar', longAction: 'Toggle workspace sidebar',
    newTab: 'New browser tab', address: 'Address', font: /Figtree/, heading: /Caprasimo/,
  },
  {
    locale: 'ru', topMenu: ['Parley', 'Правка', 'Вид', 'Работа', 'Вкладка', 'Терминал'],
    nativeEdit: 'Отменить', settings: 'Настройки', notifications: 'Уведомления', notifySound: 'Звук, когда нужен ваш ответ',
    palette: 'Палитра команд', query: 'ПОКАЗАТЬ ИЛИ СКРЫТЬ ПАНЕЛЬ РАБОТ', longAction: 'Показать или скрыть панель работ',
    newTab: 'Новая вкладка браузера', address: 'Адрес', font: /system-ui/, heading: /system-ui/,
  },
] as const;

for (const labels of cases) {
  test(`${labels.locale}: desktop menus, accessible names and search at minimum size`, async ({}, testInfo) => {
    test.setTimeout(60_000);
    const home = await makeTempHome('locale-desktop');
    const projectPath = await makeTempProject('locale-desktop');
    let app: ElectronApplication | null = null;

    try {
      const ui = path.join(home, 'desktop');
      await mkdir(ui, { recursive: true });
      await writeFile(path.join(ui, 'ui.json'), JSON.stringify({ version: 1, locale: labels.locale, appearance: 'light' }));
      app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home } });
      const window = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height), size);
      await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
      await expect(window.locator('html')).toHaveAttribute('lang', labels.locale);
      const fonts = await window.evaluate(async () => {
        await document.fonts.ready;
        const style = getComputedStyle(document.documentElement);
        return {
          body: getComputedStyle(document.body).fontFamily,
          heading: style.getPropertyValue('--font-heading'),
        };
      });
      expect(fonts.body).toMatch(labels.font);
      expect(fonts.heading).toMatch(labels.heading);

      const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => ({
        label: item.label, children: item.submenu?.items.map((child) => ({ label: child.label, role: child.role })),
      })));
      expect(menu?.map((item) => item.label)).toEqual(labels.topMenu);
      expect(menu?.[1]?.children?.find(({ role }) => role === 'undo')?.label).toBe(labels.nativeEdit);
      expect(menu?.[0]?.children?.map((item) => item.label)).toContain(labels.settings);

      await expect(window.getByTestId('landing')).toBeVisible();
      await window.evaluate((project) => (globalThis as unknown as {
        parley: { call(method: string, params: unknown): Promise<unknown> };
      }).parley.call('works.create', { projectPath: project, title: 'Test Проект Alpha', goal: '' }), projectPath);
      await expect(window.getByTestId('app-shell')).toBeVisible();

      await window.keyboard.press('Meta+J');
      const palette = window.getByRole('dialog', { name: labels.palette });
      const search = palette.getByRole('combobox');
      await search.fill(labels.query);
      const option = palette.getByRole('option').filter({ hasText: labels.longAction });
      await expect(option.getByText(labels.longAction, { exact: true })).toHaveAttribute('title', labels.longAction);
      expect(await palette.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await window.screenshot({ path: testInfo.outputPath(`palette-${labels.locale}.png`), animations: 'disabled' });
      await search.fill(labels.newTab);
      await palette.getByRole('option').filter({ hasText: labels.newTab }).click();
      await expect(window.getByRole('textbox', { name: labels.address })).toBeVisible();

      await window.keyboard.press('Meta+,');
      const settings = window.getByRole('dialog', { name: labels.settings });
      await settings.getByText(labels.notifications, { exact: true }).click();
      await expect(settings.getByLabel(labels.notifySound, { exact: true })).toBeVisible();
      expect(await settings.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return el.scrollWidth <= el.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth + 1;
      })).toBe(true);
      await window.screenshot({ path: testInfo.outputPath(`settings-${labels.locale}.png`), animations: 'disabled' });
    } finally {
      await stopApp(app);
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    }
  });
}
