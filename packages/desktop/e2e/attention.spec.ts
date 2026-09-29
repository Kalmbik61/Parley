import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Внимание в строке статуса (кусок 4.2, спека 7.3, 7.6): сессия, ждущая разрешения, даёт
 * сегмент «1 needs you», а клик по нему открывает вкладку её терминала в её работе.
 *
 * Переход по уведомлению и «просмотрено» (кусок 4.3, спека 7.2, 7.4): цель приходит событием
 * `app:focus-target`, как от клика по уведомлению. Фокус окна для «просмотрено» ведут события
 * `focus`/`blur` рендерера (4.2) — их тест шлёт сам, фокус ОС между параллельными окнами гуляет.
 * Уведомления main пишет в журнал (`HARNAS_NOTIFICATIONS=log`, `playwright.config.ts`):
 * настоящее всплыло бы на экране человека.
 *
 * Внимание двигается настоящими событиями хуков, как в `cards.spec.ts`: stub-агент хуков не зовёт.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code. */
async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.harnas', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

test.describe('внимание в строке статуса (кусок 4.2)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('attention');
    project = await makeTempProject('attention');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('сессия ждёт разрешения — «1 needs you»; клик открывает вкладку её терминала', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-attention', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'один',
      task: '',
      parent: null,
    });
    const sessionId = created.ref.sessionId;
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(window.locator('[data-attention-segment]')).toHaveCount(0);

    await hookEvent(workId, sessionId, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    const segment = window.getByRole('button', { name: '1 needs you' });
    await expect(segment).toBeVisible({ timeout: 5_000 });

    await segment.click();
    const tab = window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    // Сессия всё ещё ждёт — вкладка с отметкой и значком вопроса (спека 7.3).
    await expect(tab).toHaveAttribute('data-unread', 'true');
    await expect(tab.locator('[data-state="blocked"]')).toHaveCount(1);
  });
});

/** Ключ работы окна — `lib/tree-order.ts#workKey`. */
const keyOf = (workId: string): string => `${project} ${workId}`;

/** Клик по уведомлению без самого уведомления: main шлёт окну цель, как `createNotifier` по `click`. */
async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

/** Фокус ввода — в скрытом поле xterm терминала этой сессии в контейнере этой работы. */
async function terminalFocused(window: Page, workKey: string, sessionId: string): Promise<boolean> {
  return window.evaluate(
    ([key, id]) => {
      const active = document.activeElement;
      return (
        active !== null &&
        active.classList.contains('xterm-helper-textarea') &&
        active.closest(`[data-work-container="${key}"] [data-tab-id="terminal:${id}"]`) !== null
      );
    },
    [workKey, sessionId] as const,
  );
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
}

async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __harnasNotifications?: LoggedNote[] }).__harnasNotifications ?? []).map(({ title, body, silent }) => ({
      title,
      body,
      silent,
    })),
  );
}

test.describe('переход по уведомлению и «просмотрено» (кусок 4.3)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('attention');
    project = await makeTempProject('attention');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom', HARNAS_NOTIFICATIONS: 'log' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return { electronApp, window };
  }

  async function createSession(window: Page, workId: string, label: string): Promise<string> {
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label,
      task: '',
      parent: null,
    });
    return created.ref.sessionId;
  }

  test('тест 6: app:focus-target делает вторую работу активной, фокус ввода — в терминале её сессии', async () => {
    const { electronApp, window } = await launch();
    const first = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-first', goal: '' });
    await createSession(window, first.workId, 'planner');
    const second = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-second', goal: '' });
    const sessionId = await createSession(window, second.workId, 'executor');
    // Цель ищется по снимку работ окна — ждём, пока в нём появится сессия второй работы.
    await expect(window.locator(`[data-work-key="${keyOf(second.workId)}"]:not([role="tab"]) [data-session-id="${sessionId}"]`)).toHaveCount(1);

    await sendFocusTarget(electronApp, { kind: 'session', ref: { projectPath: project, workId: second.workId, sessionId } });

    const tab = window.locator(`[role="tab"][data-work-key="${keyOf(second.workId)}"][data-tab-id="terminal:${sessionId}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    await expect(window.locator(`[data-work-container="${keyOf(second.workId)}"]`)).toBeVisible();
    await expect.poll(() => terminalFocused(window, keyOf(second.workId), sessionId), { timeout: 5_000 }).toBe(true);
  });

  test('тест 7: «не просмотрено» не гаснет без фокуса окна и гаснет за 3 с после фокуса', async () => {
    const { electronApp, window } = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-seen', goal: '' });
    const sessionId = await createSession(window, workId, 'one');
    await expect(window.locator(`[data-work-key="${keyOf(workId)}"]:not([role="tab"]) [data-session-id="${sessionId}"]`)).toHaveCount(1);
    // Вкладка сессии не открыта — терминал не виден.
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`)).toHaveCount(0);

    await hookEvent(workId, sessionId, { hook_event_name: 'UserPromptSubmit' });
    await hookEvent(workId, sessionId, { hook_event_name: 'Stop' });
    const title = window.locator(`[data-work-key="${keyOf(workId)}"]:not([role="tab"]) [data-work-title]`);
    await expect(title).toHaveClass(/font-bold/, { timeout: 5_000 });

    // Окно без фокуса: трекер 4.2 читает флаг из событий окна рендерера.
    await window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sendFocusTarget(electronApp, { kind: 'session', ref: { projectPath: project, workId, sessionId } });
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`)).toHaveAttribute('data-active', 'true');
    await window.waitForTimeout(2_000);
    await expect(title).toHaveClass(/font-bold/);

    await electronApp.evaluate(({ app: electron, BrowserWindow }) => {
      electron.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    // Под Playwright `document.hasFocus()` бывает ложным — фокус эмулируется событием окна.
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(title).not.toHaveClass(/font-bold/, { timeout: 3_000 });
  });

  test('ход закончен при невидимой вкладке — уведомление в журнале; его клик ведёт в терминал сессии', async () => {
    const { electronApp, window } = await launch();
    const first = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-first', goal: '' });
    await createSession(window, first.workId, 'planner');
    const second = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-notify', goal: '' });
    const sessionId = await createSession(window, second.workId, 'one');
    await expect(window.locator(`[data-work-key="${keyOf(second.workId)}"]:not([role="tab"]) [data-session-id="${sessionId}"]`)).toHaveCount(1);

    await hookEvent(second.workId, sessionId, { hook_event_name: 'UserPromptSubmit' });
    // Сначала окно видит working: первое значение сессии — база без уведомления (спека 7.4).
    await expect(
      window.locator(`[data-work-key="${keyOf(second.workId)}"]:not([role="tab"]) [data-session-id="${sessionId}"] [data-state="working"]`),
    ).toHaveCount(1, { timeout: 5_000 });
    await hookEvent(second.workId, sessionId, { hook_event_name: 'Stop' });

    const expected = { title: 'e2e-notify · S01 one — finished', body: '', silent: false };
    await expect.poll(() => loggedNotes(electronApp), { timeout: 5_000 }).toContainEqual(expected);
    // Уведомление одно, пачки нет.
    expect((await loggedNotes(electronApp)).filter((note) => note.title === expected.title)).toHaveLength(1);

    await electronApp.evaluate(() => {
      const log = (globalThis as { __harnasNotifications?: Array<{ title: string; click(): void }> }).__harnasNotifications ?? [];
      log.filter((note) => note.title.startsWith('e2e-notify')).at(-1)?.click();
    });
    await expect(
      window.locator(`[role="tab"][data-work-key="${keyOf(second.workId)}"][data-tab-id="terminal:${sessionId}"]`),
    ).toHaveAttribute('data-active', 'true');
    await expect.poll(() => terminalFocused(window, keyOf(second.workId), sessionId), { timeout: 5_000 }).toBe(true);
  });
});
