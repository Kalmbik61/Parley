import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * «Restart host» из палитры посреди работы (раунд main-r2, п. 2 — ревью 6.3-B, Important 2).
 * После перезапуска хоста процесс агента мёртв (lifecycle sleeping): вкладка терминала обязана
 * сказать «S01 isn't running» с кнопкой Resume, а не молчать пустым экраном; ввод в неё не
 * пропадает молча; после Resume новый вывод виден в той же вкладке без переключений.
 * Агент — эхо-заглушка, настоящий `claude` не запускается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

type Harnas = { harnas: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Harnas).harnas.call(m, p), [method, params] as const) as Promise<T>;
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

test.describe('перезапуск хоста из палитры (раунд main-r2, п. 2)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('restart');
    project = await makeTempProject('restart-host');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('Restart host → «S01 isn\'t running», ввод — тост; Resume → новый вывод в той же вкладке', async () => {
    test.setTimeout(90_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-restart', goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'restart',
      task: '',
      parent: null,
    });
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    await expect.poll(() => screenText(window)).toContain('stub-echo готов');
    const input = window.locator('.xterm-helper-textarea').first();
    await input.click();
    await input.type('before\r');
    await expect.poll(() => screenText(window)).toContain('echo: before');

    await window.keyboard.press('Meta+J');
    await window.keyboard.type('Restart host');
    await window.keyboard.press('Enter');
    await window.getByRole('button', { name: 'Restart', exact: true }).click();

    // Хост вернулся, агент мёртв: вкладка говорит об этом, а не молчит.
    const notRunning = window.getByTestId('terminal-not-running');
    await expect(notRunning).toBeVisible({ timeout: 30_000 });
    await expect(notRunning).toContainText("S01 isn't running");

    // Ввод в неживую вкладку — тост с тем же текстом, а не тишина. Полоса сдвинула экран вниз —
    // поле ввода xterm фокусируется напрямую, а не кликом по его старому месту.
    await input.focus();
    await window.keyboard.type('lost');
    await expect(window.locator('[data-sonner-toast]').filter({ hasText: "S01 isn't running" })).toBeVisible();

    await notRunning.getByRole('button', { name: 'Resume' }).click();
    await expect(notRunning).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => screenText(window), { timeout: 30_000 }).toContain('stub-echo готов');
    await input.focus();
    await window.keyboard.type('after\r');
    await expect.poll(() => screenText(window)).toContain('echo: after');
    // Та же вкладка сессии осталась выбранной — без переключений.
    await expect(window.locator(`[role="tab"][aria-selected="true"][data-tab-id="terminal:${ref.sessionId}"]`)).toHaveCount(1);
  });
});
