import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Чип «N shell» в тулбаре сессии (план shell-processes, этап D). Агента играет `stub-processes-agent.mjs`: пока в
 * `STUB_PROC_DIR` лежит файл `run`, у него есть дочерний `zsh` с `sleep`, у которого argv[0] подменён строкой
 * `fake --token=SECRET-PROBE`. Проверки: чип появляется и исчезает; список показывает `sleep`; ни текст окна, ни DOM
 * списка не содержат `SECRET-PROBE`. Снимок раскрытого списка — в `docs/audits/2026-11-09/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-processes-agent.mjs');
const shotPath = path.resolve(dirname, '../../../docs/audits/2026-11-09/session-processes-chip.png');
const SECRET = 'SECRET-PROBE';

let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('чип процессов в тулбаре сессии (план shell-processes, этап D)', () => {
  let home: string;
  let procDir: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('processes');
    project = await makeTempProject('processes');
    procDir = await makeTempProject('processes-flag');
  });

  test.afterEach(async () => {
    await rm(path.join(procDir, 'run'), { force: true });
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(procDir, { recursive: true, force: true });
  });

  test('чип появляется и исчезает, список показывает sleep, SECRET-PROBE нигде нет', async () => {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', STUB_PROC_DIR: procDir };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1200, height: 800 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-processes', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project, workId, provider: 'claude', label: 'процессы', task: '', parent: null,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${created.ref.sessionId}"]`).click();

    // Команды нет — чипа нет.
    await expect(window.getByTestId('chat-toolbar')).toBeVisible();
    await expect(window.getByTestId('chat-processes')).toHaveCount(0);

    // Команда запущена — чип появляется (zsh и sleep под ним).
    await mkdir(procDir, { recursive: true });
    await writeFile(path.join(procDir, 'run'), '');
    const chip = window.getByTestId('chat-processes');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveText(/^\d+ shell$/);

    await chip.click();
    const list = window.getByTestId('processes-list');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('processes-row').filter({ hasText: 'sleep' })).toHaveCount(1);

    // Ни текст окна, ни DOM списка, ни подсказки не содержат токена из подменённого argv[0].
    const bodyText = await window.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain(SECRET);
    expect(await list.evaluate((el) => el.outerHTML)).not.toContain(SECRET);
    expect(await window.evaluate((secret) => document.documentElement.outerHTML.includes(secret), SECRET)).toBe(false);

    // Список появляется с анимацией: снимок — когда непрозрачность дошла до 1.
    const popover = window.getByTestId('processes-popover');
    await expect.poll(() => popover.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    await mkdir(path.dirname(shotPath), { recursive: true });
    await window.screenshot({ path: shotPath });

    // Команда завершена — раскрытый список остаётся с пустым состоянием, закрытый чип исчезает.
    await rm(path.join(procDir, 'run'));
    await expect(window.getByTestId('processes-empty')).toBeVisible({ timeout: 15_000 });
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('chat-processes')).toHaveCount(0);
  });
});
