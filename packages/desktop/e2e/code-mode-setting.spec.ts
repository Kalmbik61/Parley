import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Переключатель Code Mode и строка состояния под ним (план T12a, слайс D) в настоящем окне, с настоящим хостом и временным `PARLEY_HOME`:
 * по умолчанию включён и подписан «Code Mode (Beta)», строки состояния у включённого нет (решение человека m-7348); выключение пишет обе записи,
 * и строка — «Off»; включение — снова без строки. Затем config.json выключен рукой, без строки хранилища: окно, открытое заново, сразу говорит «Off, but not durable» (лид m-7289,
 * R2). Окно 800×500: строка не уходит за край. Снимки — в `CODE_MODE_SHOTS` (по умолчанию `.omc/reviews/shots`), не в репозиторий.
 *
 * Вместо `claude` — заглушка агента; список доказанных провайдеров пуст, ничего не включается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = process.env['CODE_MODE_SHOTS'] ?? path.resolve(dirname, '../../../.omc/reviews/shots');

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };
async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(300);
  await mkdir(shots, { recursive: true });
  await window.screenshot({ path: path.join(shots, `${name}.png`) });
}

test.describe('переключатель Code Mode в настройках', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('code-mode-setting');
    project = await makeTempProject('code-mode-setting');
  });
  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('по умолчанию включён, строки нет; выключение и включение пишут настройку, строка следует', async () => {
    test.setTimeout(120_000);
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' } });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    // Хотя бы одна работа, чтобы окно показало оболочку и палитра открылась.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'code-mode-setting', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'setting', task: '', parent: null });

    const openSettings = async (): Promise<void> => {
      await window.getByRole('button', { name: 'Search ⌘J' }).first().click();
      await window.getByRole('dialog').getByRole('combobox').fill('Settings');
      await window.keyboard.press('Enter');
      await expect(window.getByRole('dialog')).toContainText('Settings');
      await window.getByRole('tab', { name: 'Agents' }).click();
    };
    await openSettings();

    const toggle = window.getByRole('switch', { name: 'Code Mode (Beta)', exact: true });
    const state = window.getByTestId('code-mode-state');
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // On: no state line at all (human decision m-7348); the label reads "Code Mode (Beta)".
    await expect(state).toHaveCount(0);
    await expect(window.getByRole('dialog')).not.toContainText(/proven|Requested/);
    const box = await toggle.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(800);
    await shot(window, 'code-mode-setting-on');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(state).toHaveText('Off. New launches run with direct tools.');
    expect((await call<{ config: { codeMode: boolean } }>(window, 'settings.get', {})).config.codeMode).toBe(false);
    await shot(window, 'code-mode-setting-off');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(state).toHaveCount(0);
    expect((await call<{ config: { codeMode: boolean } }>(window, 'settings.get', {})).config.codeMode).toBe(true);

    // config.json off by hand, no store row: the window reopened shows the partial off at once.
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ codeMode: false }));
    await openSettings();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(state).toHaveText('Off, but not durable: deleting config.json would turn it back on.');
    await state.scrollIntoViewIfNeeded();
    await shot(window, 'code-mode-setting-off-not-durable');
  });
});
