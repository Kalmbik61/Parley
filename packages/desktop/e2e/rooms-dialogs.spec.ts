import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Диалоги «New session or room» и «New room» из двух сессий и перетаскивание в сайдбаре (кусок 7 плана «Organic», спека
 * окна 2026-09-29, 1.5, 1.6, 2.1, 2.5). Настоящий хост, вместо `claude` — заглушка агента (`PARLEY_CLAUDE_BIN`), окно
 * Electron: один агент — сессия и её терминал, два и больше — комната с ведущим (вкладка комнаты, строка развёрнута,
 * тихий старт: лента пуста, писем-приглашений нет); сессия на сессию — диалог 1.6 и комната с системной строкой
 * `Room created from @s03 and @s04`; сессия на строку комнаты — вступление (`@s05 joined the room`); на себя и в
 * свою комнату бросить нельзя — цель не подсвечивается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/**
 * Окно шлёт сессиям комнаты пустой ярлык, а хост сессии без ярлыка пустым его не оставляет: `addSession` ставит имя по
 * номеру (`defaultSessionName`, спека архива комнат, часть 2, 13) — `Ralph`, `Anatoly`…, после полного круга `Ralph 2`.
 * Поэтому строка сайдбара показывает `S05 Roman`, а не голый `S05` (правка по ревью куска 7, находка 1; спека 2.1).
 */
const DEFAULT_NAME = /^[A-Z][a-z]+( \d+)?$/;
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

interface RoomInMap {
  id: string;
  title: string;
  members: string[];
  lead: string | null;
}

interface MapView {
  sessions: Array<{ id: string; label: string; task: string }>;
  rooms: RoomInMap[];
  messages: Array<{ roomId: string | null; from: string; text: string }>;
}

/** Карта работы из снимка хоста — то, что окно рисует. */
async function mapOf(window: Page, workId: string): Promise<MapView> {
  const snapshot = await call<{ entries: Array<{ map: MapView & { work: { id: string } } }> }>(window, 'works.list', {});
  const entry = snapshot.entries.find((item) => item.map.work.id === workId);
  if (entry === undefined) throw new Error(`работы ${workId} нет в снимке`);
  return entry.map;
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

/** Тащит строку `from` к строке `to` и держит указатель там; отпустить — `mouse.up()` из вызывающего кода. */
async function dragOver(window: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('строки для броска не найдены');
  await window.mouse.move(a.x + 40, a.y + a.height / 2);
  await window.mouse.down();
  // Порог перетаскивания — 4 px; затем указатель идёт к цели и стоит на ней (droppable включается после старта).
  await window.mouse.move(a.x + 60, a.y + a.height / 2 + 6, { steps: 3 });
  await window.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 10 });
  await window.mouse.move(b.x + 62, b.y + b.height / 2, { steps: 2 });
}

test.describe('диалоги комнат и перетаскивание (кусок 7)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('rooms-dialogs');
    project = await makeTempProject('rooms-dialogs');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<Page> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  test('⌘T: один агент — одна сессия и её терминал; «Add agent» — комната: вкладка, развёрнутая строка, ведущий, тихий старт', async () => {
    test.setTimeout(90_000);
    const window = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-rooms-dialogs', goal: '' });
    const first = await createSession(window, workId, 'seed');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    const key = `${project} ${workId}`;
    const card = window.locator(`[data-work-key="${key}"]:not([role="tab"])`);
    await card.locator('[data-work-title]').first().click();

    // Один агент: заголовок «New session», Start session — одна сессия без комнаты; её терминал открывается.
    await window.keyboard.press('Meta+T');
    const single = window.getByRole('dialog');
    await expect(single.getByRole('heading', { name: 'New session' })).toBeVisible();
    await expect(single.getByRole('radiogroup', { name: 'Agent 1' }).getByRole('radio', { checked: true })).toHaveText('Claude');
    await single.getByPlaceholder('Optional').fill('solo');
    await single.getByRole('button', { name: 'Start session' }).click();
    await expect(single).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => (await mapOf(window, workId)).sessions.length, { timeout: 15_000 }).toBe(2);
    const afterSingle = await mapOf(window, workId);
    expect(afterSingle.rooms).toEqual([]);
    const solo = afterSingle.sessions.find((session) => session.label === 'solo');
    expect(solo).toBeDefined();
    await expect(window.locator(`#titlebar-tabs [role="tab"][data-tab-id="terminal:${solo?.id ?? ''}"]`)).toHaveAttribute('data-active', 'true');

    // Два агента: заголовок «New room», ведущий — второй; вкладка комнаты, строка развёрнута, лента пуста.
    await window.keyboard.press('Meta+T');
    const roomDialog = window.getByRole('dialog');
    await roomDialog.getByRole('button', { name: 'Add agent' }).click();
    await expect(roomDialog.getByRole('heading', { name: 'New room' })).toBeVisible();
    await roomDialog.getByRole('button', { name: 'Make lead' }).click();
    await roomDialog.getByPlaceholder('What the agents will discuss').fill('e2e room');
    await roomDialog.getByRole('button', { name: 'Create room' }).click();
    await expect(roomDialog).toBeHidden({ timeout: 20_000 });

    await expect.poll(async () => (await mapOf(window, workId)).rooms.length, { timeout: 15_000 }).toBe(1);
    const map = await mapOf(window, workId);
    const created = map.rooms[0];
    expect(created?.title).toBe('e2e room');
    expect(created?.members).toHaveLength(2);
    expect(created?.lead).toBe(created?.members[1]);
    // Участники — новые сессии (не seed и не solo), без задачи; ярлык — имя по номеру, которое поставил хост; писем-приглашений
    // нет.
    for (const id of created?.members ?? []) {
      expect([first, solo?.id]).not.toContain(id);
      const member = map.sessions.find((session) => session.id === id);
      expect(member).toMatchObject({ task: '' });
      expect(member?.label).toMatch(DEFAULT_NAME);
    }
    expect(map.messages.filter((message) => message.roomId === created?.id)).toEqual([]);

    const tab = window.locator(`#titlebar-tabs [role="tab"][data-tab-id="room:${created?.id ?? ''}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    const row = card.locator(`[data-room-row="${created?.id ?? ''}"]`);
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('[data-session-id]')).toHaveCount(2);
    for (const id of created?.members ?? []) {
      const label = map.sessions.find((session) => session.id === id)?.label ?? '';
      await expect(row.locator(`[data-session-id="${id}"]`)).toContainText(`${id.replace('s-', 'S')} ${label}`);
    }
    await expect(row.locator('[data-lead]')).toHaveCount(1);
    await expect(row.locator(`[data-session-id="${created?.lead ?? ''}"] [data-lead]`)).toHaveCount(1);
  });

  test('перетаскивание: сессия на сессию — диалог 1.6 и комната; сессия на строку комнаты — вступление; на себя и в свою комнату нельзя', async () => {
    test.setTimeout(120_000);
    const window = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-rooms-drag', goal: '' });
    const s1 = await createSession(window, workId, 'one');
    const s2 = await createSession(window, workId, 'two');
    const s3 = await createSession(window, workId, 'three');
    const s4 = await createSession(window, workId, 'four');
    const s5 = await createSession(window, workId, 'five');
    const { roomId: existing } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'existing',
      members: [s1, s2],
      lead: s1,
      quiet: true,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    const key = `${project} ${workId}`;
    const card = window.locator(`[data-work-key="${key}"]:not([role="tab"])`);
    await card.locator('[data-work-title]').first().click();
    const sessionRow = (id: string): Locator => card.locator(`[data-session-id="${id}"]`);
    const roomRow = (id: string): Locator => card.locator(`[data-room-row="${id}"]`);
    await expect(roomRow(existing)).toBeVisible();

    // На себя — цель не подсвечивается: держим указатель над собой и смотрим на подсветку.
    await dragOver(window, sessionRow(s3), sessionRow(s3));
    await expect(window.locator('[data-drop-over]')).toHaveCount(0);
    await window.mouse.up();

    // Сессия на сессию: подсвечена цель, после броска — диалог 1.6, ведущая — та, на которую бросили.
    await dragOver(window, sessionRow(s3), sessionRow(s4));
    await expect(window.locator('[data-drop-over]')).toHaveCount(1);
    await expect(sessionRow(s4)).toHaveAttribute('data-drop-over', '');
    await window.mouse.up();
    const merge = window.getByRole('dialog');
    await expect(merge.getByRole('heading', { name: 'New room' })).toBeVisible();
    await expect(merge.getByText('S04 four and S03 three move into the room.')).toBeVisible();
    await expect(merge.getByRole('radiogroup', { name: 'Lead' }).getByRole('radio', { checked: true })).toContainText('S04 four');
    await merge.getByPlaceholder('What the agents will discuss').fill('merged');
    await merge.getByRole('button', { name: 'Create room' }).click();
    await expect(merge).toBeHidden({ timeout: 15_000 });

    await expect.poll(async () => (await mapOf(window, workId)).rooms.length, { timeout: 15_000 }).toBe(2);
    const merged = (await mapOf(window, workId)).rooms.find((room) => room.title === 'merged');
    expect(merged?.members).toEqual([s4, s3]);
    expect(merged?.lead).toBe(s4);
    const origin = (await mapOf(window, workId)).messages.filter((message) => message.roomId === merged?.id);
    expect(origin.map((message) => ({ from: message.from, text: message.text }))).toEqual([
      { from: 'system', text: `Room created from @${s3.replace('-', '')} and @${s4.replace('-', '')}` },
    ]);
    await expect(window.locator(`#titlebar-tabs [role="tab"][data-tab-id="room:${merged?.id ?? ''}"]`)).toHaveAttribute('data-active', 'true');

    // Сессия на строку комнаты: подсвечена, после броска — участник, системная строка, комната развёрнута.
    await window.mouse.move(700, 700);
    await dragOver(window, sessionRow(s5), roomRow(existing));
    await expect(roomRow(existing)).toHaveAttribute('data-drop-over', '');
    await window.mouse.up();
    await expect.poll(async () => (await mapOf(window, workId)).rooms.find((room) => room.id === existing)?.members, { timeout: 15_000 }).toContain(s5);
    const joined = (await mapOf(window, workId)).messages.filter((message) => message.roomId === existing);
    expect(joined.map((message) => message.text)).toContain(`@${s5.replace('-', '')} joined the room`);
    await expect(roomRow(existing)).toHaveAttribute('aria-expanded', 'true');
    await expect(roomRow(existing).locator(`[data-session-id="${s5}"]`)).toHaveCount(1);

    // В свою комнату нельзя: s5 теперь в existing — цель не подсвечивается.
    await window.mouse.move(700, 700);
    await dragOver(window, roomRow(existing).locator(`[data-session-id="${s5}"]`), roomRow(existing));
    await expect(window.locator('[data-drop-over]')).toHaveCount(0);
    await window.mouse.up();
    expect((await mapOf(window, workId)).rooms.find((room) => room.id === existing)?.members.filter((id) => id === s5)).toHaveLength(1);
  });
});
