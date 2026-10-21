import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Проба «застрявших сессий» на коде как есть (задача 0 плана 2026-10-12, спека 10 и 10.1, п. 1 и 3): шлёт ли окно
 * уведомление «needs you», когда Codex в комнате просит одобрения, а на виду вкладка комнаты, а не терминал Codex;
 * и в каком состоянии `AudioContext` скрытого окна — от этого зависит свой звук окна (спека 7.2).
 *
 * Ведущий — заглушка Claude (`stub-echo-agent.mjs`), участник — заглушка Codex (`stub-codex-agent.mjs`, подмена
 * бинаря — `PARLEY_CODEX_BIN`). Одобрение — строка `STUB_APPROVAL`: заглушка пишет OSC 9 `Approval requested` и
 * заголовок `[ ! ] Action Required`, как Codex. Уведомления main пишет в журнал (`PARLEY_NOTIFICATIONS=log`,
 * `attention.spec.ts`): настоящее всплыло бы на экране человека. Фокус окна тест задаёт событием `focus` рендерера —
 * фокус ОС между параллельными окнами гуляет.
 *
 * Тест остаётся в наборе: задача 7 меняет его ожидания (баннер беззвучный, звук играет окно, текст — причина).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubClaude = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function createSession(window: Page, workId: string, provider: 'claude' | 'codex', label: string): Promise<string> {
  const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider,
    label,
    task: '',
    parent: null,
  });
  return created.ref.sessionId;
}

/** Клик по уведомлению без самого уведомления: main шлёт окну цель, как `createNotifier` по `click` (`attention.spec.ts`). */
async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
}

/** Журнал уведомлений main (`PARLEY_NOTIFICATIONS=log`). */
async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, body, silent }) => ({
      title,
      body,
      silent,
    })),
  );
}

/** Отправка окна агенту вставкой и Enter — `pty.send`; отказ хоста приходит результатом, а не ошибкой (`codex.spec.ts`). */
async function sendSubmitted(window: Page, ref: unknown, text: string): Promise<boolean> {
  return (await call<{ submitted: boolean }>(window, 'pty.send', { ref, text, submit: true })).submitted;
}

test.describe('уведомление «needs you» у Codex в комнате (проба, задача 0)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('stuck-notify');
    project = await makeTempProject('stuck-notify');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('Codex просит одобрения при открытой вкладке комнаты — уведомление «needs you» в журнале, не беззвучное; AudioContext скрытого окна', async () => {
    test.setTimeout(90_000);
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubClaude,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_NOTIFICATIONS: 'log',
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    // Комната из ведущего (Claude) и участника (Codex), тихий старт: писем-приглашений нет, лента пуста.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-stuck', goal: '' });
    const lead = await createSession(window, workId, 'claude', 'lead');
    const codex = await createSession(window, workId, 'codex', 'codex');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'e2e-room',
      members: [lead, codex],
      lead,
      quiet: true,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    // Цель перехода ищется по снимку работ окна — ждём, пока в нём появится комната.
    await expect(window.locator(`[data-room-row="${roomId}"]`)).toHaveCount(1);

    // Активна вкладка комнаты, окно в фокусе: терминал Codex не открыт, а значит, не на виду.
    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId });
    await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${codex}"]`)).toHaveCount(0);
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));

    // Codex просит одобрения: хост отвечает на `pty.send`, только когда знает, что у агента на экране (заглушка прислала `Ready`).
    const codexRef = { projectPath: project, workId, sessionId: codex };
    await expect.poll(() => sendSubmitted(window, codexRef, 'STUB_APPROVAL'), { timeout: 15_000 }).toBe(true);
    // Окно видит «1 needs you»: сигнал дошёл до окна, дальше — дело уведомителя.
    await expect(window.getByRole('button', { name: '1 needs you' })).toBeVisible({ timeout: 5_000 });

    // Ярлык сессии в заголовке — `S02 codex` (`s-02` → `S02`).
    const title = `e2e-stuck · S${codex.slice(2)} codex — needs you`;
    await expect.poll(() => loggedNotes(electronApp), { timeout: 5_000 }).toContainEqual(expect.objectContaining({ title, silent: false }));
    expect((await loggedNotes(electronApp)).filter((note) => note.title === title)).toHaveLength(1);

    // Скрытое окно: звук «нужен ты» должно играть оно (спека 7.2), поэтому важно, не усыпил ли Chromium аудио без окна.
    // `hide()` на macOS не меняет `document.visibilityState` (он `hidden` только у свёрнутого окна) — скрытие проверяем в main.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
    const audio = await window.evaluate(async () => {
      const context = new AudioContext();
      const created = context.state;
      // `resume()` скрытого окна может не завершиться вовсе — ждём не дольше секунды.
      await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      const resumed = context.state;
      await context.close();
      return { created, resumed, pageVisibility: document.visibilityState };
    });
    console.log('AudioContext скрытого окна:', audio);
    test.info().annotations.push({ type: 'AudioContext скрытого окна', description: JSON.stringify(audio) });
    expect(['running', 'suspended']).toContain(audio.created);
  });
});
