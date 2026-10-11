import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Управление комнатой из сайдбара в живом окне: «Rename» и «Delete…» меню строки комнаты, «Make lead» меню участника.
 * Поле переименования открывает пункт контекстного меню, пока ловушка фокуса меню ещё стоит: юнит-тесты (jsdom) этого
 * не воспроизводят, а в окне поле оставалось без фокуса — тест держит, что фокус в поле и Enter сохраняет название.
 * Комнату создаёт хост (`rooms.create`, тихий старт); заглушка агента писем не читает.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

interface MapShape {
  rooms: { id: string; title: string; lead: string | null }[];
  sessions: { id: string }[];
  messages: { from: string; to: string[]; roomId: string | null; text: string }[];
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('управление комнатой из сайдбара', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-actions');
    project = await makeTempProject('room-actions');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function openRoom(): Promise<{ window: Page; workId: string; roomId: string; ids: string[] }> {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' } });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-actions', goal: '' });
    const ids: string[] = [];
    for (const label of ['planner', 'critic', 'executor']) {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null });
      ids.push(ref.sessionId);
    }
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: 'Second', members: ids, lead: ids[0], quiet: true });
    return { window, workId, roomId, ids };
  }

  const mapOf = async (workId: string): Promise<MapShape> =>
    JSON.parse(await readFile(path.join(project, '.parley', 'works', workId, 'map.json'), 'utf8')) as MapShape;

  test('Rename: поле в фокусе, Enter сохраняет; Make lead переносит ★ и пишет строку ленты; Delete… без флажка оставляет сессии', async () => {
    test.setTimeout(90_000);
    const { window, workId, roomId, ids } = await openRoom();
    const card = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`);
    const row = card.locator(`[data-room-row="${roomId}"]`);
    await expect(row).toHaveCount(1);

    await row.getByText('Second', { exact: true }).click({ button: 'right' });
    await window.locator('[data-room-action="rename"]').click();
    const field = window.getByRole('textbox', { name: 'Room name' });
    await expect(field).toBeFocused();
    await field.fill('Refund flow review');
    await field.press('Enter');
    await expect(row).toContainText('Refund flow review');
    expect((await mapOf(workId)).rooms[0]?.title).toBe('Refund flow review');

    await row.getByRole('button', { name: 'Show agents' }).click();
    const critic = row.locator(`[data-session-id="${ids[1]}"]`);
    await critic.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Make lead' }).click();
    await expect(critic).toContainText('★');
    await expect(row.locator(`[data-session-id="${ids[0]}"]`)).not.toContainText('★');
    await expect.poll(async () => (await mapOf(workId)).rooms[0]?.lead).toBe(ids[1]);
    expect((await mapOf(workId)).messages.map((message) => [message.from, message.to])).toEqual([
      ['system', ['human']],
      ['parley', [ids[1]]],
      ['parley', [ids[0]]],
    ]);
    // У ведущего пункта нет.
    await critic.click({ button: 'right' });
    await expect(window.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: 'Make lead' })).toHaveCount(0);
    await window.keyboard.press('Escape');

    await row.getByText('Refund flow review', { exact: true }).click({ button: 'right' });
    await window.locator('[data-room-action="delete"]').click();
    const dialog = window.getByRole('dialog', { name: 'Delete room "Refund flow review"?' });
    await expect(dialog.getByRole('checkbox', { name: 'Also delete its 3 sessions' })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(card.locator('[data-session-id]')).toHaveCount(3);
    const after = await mapOf(workId);
    expect(after.rooms).toEqual([]);
    // Лента комнаты ушла с ней; живым участникам — прямое письмо от parley.
    expect(after.messages.every((message) => message.roomId === null && message.from === 'parley')).toBe(true);
    expect(after.messages.map((message) => message.to[0]).sort()).toEqual([...ids].sort());
  });

  test('поле ввода комнаты: длинный текст вставкой — каретка и нижний отступ на виду, поле прокручено до дна (800×500)', async () => {
    test.setTimeout(90_000);
    const { window, workId, roomId } = await openRoom();
    const row = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator(`[data-room-row="${roomId}"]`);
    await row.getByText('Second', { exact: true }).click();
    const field = window.getByRole('textbox', { name: 'Message', exact: true });
    await expect(field).toBeVisible();
    await field.click();
    // Вставка обрабатывается самим полем (`insertPlainText` после preventDefault), буфер обмена человека тест не трогает.
    await field.evaluate((editor) => {
      const data = new DataTransfer();
      data.setData('text/plain', Array.from({ length: 30 }, (_, index) => `line ${index + 1} of pasted text`).join('\n'));
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const measured = await field.evaluate((editor) => {
      const box = editor.getBoundingClientRect();
      const range = window.getSelection()!.getRangeAt(0).cloneRange();
      const rects = range.getClientRects();
      const caret = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
      return {
        overflows: editor.scrollHeight > editor.clientHeight,
        caretTop: caret.top - box.top,
        caretBottom: caret.bottom - box.top,
        clientHeight: editor.clientHeight,
        fromBottom: editor.scrollHeight - editor.clientHeight - editor.scrollTop,
        padding: Number.parseFloat(getComputedStyle(editor).paddingBottom),
      };
    });
    expect(measured.overflows).toBe(true);
    expect(measured.caretTop).toBeGreaterThanOrEqual(0);
    expect(measured.caretBottom).toBeLessThanOrEqual(measured.clientHeight);
    // Поле прокручено до дна: нижний отступ виден, последняя строка не прижата к рамке.
    expect(measured.fromBottom).toBeLessThanOrEqual(2);
    expect(measured.clientHeight - measured.caretBottom).toBeGreaterThanOrEqual(measured.padding - 2);
  });

  test('Delete… с флажком «Also delete its N sessions» удаляет и сессии комнаты', async () => {
    test.setTimeout(90_000);
    const { window, workId, roomId } = await openRoom();
    const card = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`);
    const row = card.locator(`[data-room-row="${roomId}"]`);
    await row.getByText('Second', { exact: true }).click({ button: 'right' });
    await window.locator('[data-room-action="delete"]').click();
    const dialog = window.getByRole('dialog', { name: 'Delete room "Second"?' });
    await dialog.getByRole('checkbox', { name: 'Also delete its 3 sessions' }).check();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(card.locator('[data-session-id]')).toHaveCount(0);
    await expect.poll(async () => (await mapOf(workId)).sessions.length).toBe(0);
    expect((await mapOf(workId)).messages).toEqual([]);
  });
});
