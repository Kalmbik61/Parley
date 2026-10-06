import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Голосовой ввод (спека 2026-10-06-voice-input-design.md, 8): микрофон — фейк Chromium (тон), службы main —
 * PARLEY_VOICE=fake. Путь целиком: тусклая кнопка → Settings → Voice → «скачать» модель → включить → запись в
 * поле комнаты → текст в поле и не отправлен; Esc отменяет; ⌘⇧M в поле — то же, что клик.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const VOICE_TEXT = 'hello from voice';
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function createSession(window: Page, workId: string, label: string): Promise<string> {
  const result = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider: 'claude',
    label,
    task: '',
    parent: null,
  });
  return result.ref.sessionId;
}

async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

test.describe('голосовой ввод', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('voice');
    project = await makeTempProject('voice');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('тусклая кнопка → Voice → модель → запись в поле комнаты; Esc отменяет; ⌘⇧M', async () => {
    test.setTimeout(120_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_VOICE: 'fake', PARLEY_VOICE_TEXT: VOICE_TEXT };
    const electronApp = await electron.launch({ args: [mainEntry, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));

    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'wake.pause', {});
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-voice', goal: '' });
    const lead = await createSession(window, workId, 'lead');
    const second = await createSession(window, workId, 'second');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: 'e2e-room', members: [lead, second], lead, quiet: true });
    // Цель фокуса принимает только окно, уже показавшее комнату в боковой панели.
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(window.locator(`[data-room-row="${roomId}"]`).first()).toBeVisible();
    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId });

    const editor = window.locator('[data-room-editor]');
    const mic = window.locator(`[data-testid="mic"][data-target^="room:"]`);
    await expect(mic).toHaveAttribute('data-state', 'setup');

    // 1. Тусклая кнопка ведёт в Settings → Voice; «скачать» Base и включить.
    await mic.getByRole('button').click();
    const base = window.locator('[data-voice-model="base"]');
    await base.getByRole('button', { name: 'Download' }).click();
    await expect(base.getByRole('button', { name: 'Delete' })).toBeVisible();
    await window.getByRole('switch', { name: 'Voice input' }).click();
    await window.keyboard.press('Escape');
    await expect(mic).toHaveAttribute('data-state', 'ready');

    // 2. Клик — запись, клик — текст в поле, письма нет.
    await mic.getByRole('button').click();
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.waitForTimeout(500);
    await mic.getByRole('button').click();
    await expect(editor).toHaveText(VOICE_TEXT);
    await expect(window.locator('[data-room-feed] [data-message-id]')).toHaveCount(0);

    // 3. Esc во время записи — отмена, поле прежнее.
    await mic.getByRole('button').click();
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.keyboard.press('Escape');
    await expect(mic).toHaveAttribute('data-state', 'ready');
    await expect(editor).toHaveText(VOICE_TEXT);

    // 4. ⌘⇧M в поле — запись и стоп; текст дописан через пробел.
    await editor.click();
    await window.keyboard.press('End');
    await window.keyboard.press('Meta+Shift+M');
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.waitForTimeout(500);
    await window.keyboard.press('Meta+Shift+M');
    await expect(editor).toHaveText(`${VOICE_TEXT} ${VOICE_TEXT}`);
  });
});
