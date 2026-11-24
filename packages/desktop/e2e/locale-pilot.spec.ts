import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const stubAgent = fileURLToPath(new URL('./stub-echo-agent.mjs', import.meta.url));
const workTitle = 'Pilot project';
const sessionName = 'Оригинал Alpha';
const size = { width: 1000, height: 640 };

async function createWork(window: Page, projectPath: string, title: string): Promise<string> {
  return window.evaluate(async (params) => {
    const bridge = (globalThis as unknown as { parley: { call(method: string, params: unknown): Promise<{ workId: string }> } }).parley;
    return (await bridge.call('works.create', params)).workId;
  }, { projectPath, title, goal: '' });
}

const cases = [
  {
    locale: 'en', initial: 'ru', preference: 'Язык интерфейса', sidebar: 'Workspaces', search: 'Search',
    palette: 'Command palette', query: 'new session', action: 'New session or room', dialog: 'New session',
    name: 'Session name', agent: 'Agent 1', effort: 'Effort', submit: 'Start session', count: '1 session', finished: 'finished',
  },
  {
    locale: 'ru', initial: 'en', preference: 'Interface language', sidebar: 'Работы', search: 'Поиск',
    palette: 'Палитра команд', query: 'НОВАЯ СЕССИЯ', action: 'Новая сессия или комната', dialog: 'Новая сессия',
    name: 'Название сессии', agent: 'Агент 1', effort: 'Усилие', submit: 'Запустить сессию', count: '1 сессия', finished: 'завершено',
  },
] as const;

for (const wording of cases) {
  test(`${wording.locale} session pilot after restarting Parley`, async () => {
    const testInfo = test.info();
    const home = await makeTempHome('locale-pilot');
    const projectPath = await makeTempProject('locale-pilot');
    let app: ElectronApplication | null = null;

    async function launch(locale: 'en' | 'ru') {
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height), size);
      await expect(window.getByTestId('landing')).toBeVisible();
      await expect(window.locator('html')).toHaveAttribute('lang', locale);
      return { electronApp, window };
    }

    try {
      const uiFile = path.join(home, 'desktop', 'ui.json');
      await mkdir(path.dirname(uiFile), { recursive: true });
      await writeFile(uiFile, JSON.stringify({ version: 1, locale: wording.initial, appearance: 'light' }), 'utf8');
      const before = await launch(wording.initial);
      await before.window.keyboard.press('Meta+,');
      const preference = before.window.getByRole('combobox', { name: wording.preference });
      await preference.selectOption(wording.locale);
      await expect(preference).toHaveValue(wording.locale);
      await quitApp(before.electronApp);
      app = null;

      const { electronApp, window } = await launch(wording.locale);
      await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
      const workId = await createWork(window, projectPath, workTitle);
      const otherWork = await createWork(window, projectPath, 'Second workspace');
      const card = (id: string) => window.locator(`[role="treeitem"][data-work-key="${projectPath} ${id}"]`);
      const sidebar = window.getByRole('tree', { name: wording.sidebar });
      await expect(sidebar).toBeVisible();
      await card(workId).getByText(workTitle, { exact: true }).click();
      await expect(card(workId).getByRole('button', { name: wording.action })).toBeVisible();
      await window.locator('[data-work-sidebar]').getByRole('button', { name: `${wording.search} ⌘J`, exact: true }).click();
      const palette = window.getByRole('dialog', { name: wording.palette });
      await palette.getByRole('combobox').fill(wording.query);
      await palette.getByRole('option').filter({ hasText: wording.action }).click();

      const dialog = window.getByRole('dialog', { name: wording.dialog });
      await expect(dialog.getByRole('radiogroup', { name: wording.agent })).toBeVisible();
      await dialog.getByRole('textbox', { name: wording.name }).fill(sessionName);
      await window.evaluate(() => document.fonts.ready.then(() => undefined));
      const effortLabel = dialog.getByRole('combobox', { name: wording.effort }).locator(':scope > span');
      expect(await effortLabel.evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
      await window.screenshot({ path: testInfo.outputPath(`session-dialog-${wording.locale}.png`), animations: 'disabled' });
      await dialog.getByRole('button', { name: wording.submit, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(card(workId).getByText(wording.count, { exact: true })).toBeVisible();
      const row = card(workId).locator('[data-session-id]').filter({ hasText: sessionName });
      await expect(row).toBeVisible();
      const sessionId = await row.getAttribute('data-session-id');
      const log = path.join(projectPath, '.parley', 'works', workId, 'events', `${sessionId}.jsonl`);
      await mkdir(path.dirname(log), { recursive: true });
      const hook = (hook_event_name: string) => appendFile(log, `${JSON.stringify({ hook_event_name })}\n`);

      await card(otherWork).getByText('Second workspace', { exact: true }).click();
      await hook('UserPromptSubmit');
      await expect(row.locator('[data-state="working"]')).toBeVisible();
      await hook('Stop');
      const title = `${workTitle} · S01 ${sessionName} — ${wording.finished}`;
      const notifications = () => electronApp.evaluate(() =>
        (globalThis as { __parleyNotifications?: { title: string; click(): void }[] }).__parleyNotifications?.map((note) => note.title) ?? [],
      );
      await expect.poll(notifications).toContain(title);
      expect((await notifications()).filter((item) => item === title)).toHaveLength(1);
      await electronApp.evaluate((_electron, target) => {
        (globalThis as { __parleyNotifications?: { title: string; click(): void }[] }).__parleyNotifications?.find((note) => note.title === target)?.click();
      }, title);
      await expect(window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`)).toHaveAttribute('data-active', 'true');
      await window.screenshot({ path: testInfo.outputPath(`sidebar-${wording.locale}.png`), animations: 'disabled' });
    } finally {
      await stopApp(app);
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    }
  });
}
