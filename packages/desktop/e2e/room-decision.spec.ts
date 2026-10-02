import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { addRoom, addSession, HUMAN, setProposal, updateMap } from '@parley/core';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Решение ведущего от инструмента до ответа человека (кусок 8 плана «Organic», спека окна 2026-09-29, 1.10, 2.4, 3.3).
 *
 * Агент — заглушка `stub-echo-agent.mjs`: по строке `STUB_MCP <инструмент> <json>` в терминале она запускает НАСТОЯЩИЙ
 * `parley-mcp` тем же способом, каким его запускает Claude Code по конфигу работы (`--mcp-config`), и шлёт JSON-RPC
 * `tools/call`. Значит, проверка «только ведущий», запись решения в карту и замена с `rev + 1` — настоящие, а не
 * подложенные тестом (в `room-row.spec.ts` решение клал ядром сам тест). Строку в терминал агента тест отправляет так
 * же, как набрал бы человек, — уведомлением `pty.input` хоста.
 *
 * Первый тест — весь сценарий: карточка, подкраска, уведомления, замена, `Accept`, новое решение, возврат с заметкой
 * (письмо ведущему со строкой доставки: «Not picked up yet» с причиной хоста до `check_inbox`, «Picked up by» после) и
 * исправленное решение после него («revised», а не «collected positions»). Второй — «то же решение второй раз не
 * уведомляет»: ни после перезапуска окна (хост переживает окно, решение в карте ждёт), ни после переподключения к
 * хосту («Restart host»). Замену решения после каждого из событий он кладёт сам и видит по журналу, что уведомитель
 * жив и молчал именно из-за базы, а не потому, что сломан. Третий — клик по уведомлению macOS (запись журнала) ведёт
 * во вкладку комнаты: цель `FocusTarget { kind: 'room' }`. Четвёртый — стопка карточек в окне 800×500: не больше двух,
 * новая сверху, кнопки в окне, а тост sonner встаёт над ними, не на кнопки (раскладку считает только настоящий Chromium).
 *
 * Уведомления main пишет в журнал (`PARLEY_NOTIFICATIONS=log`, `playwright.config.ts`): настоящее всплыло бы на экране
 * человека. Окно в фокусе или без него тест задаёт событиями `focus` / `blur` — фокус ОС между окнами гуляет
 * (`attention.spec.ts`). Будильник хоста стоит на паузе: он печатал бы в терминал заглушки указатели на письма,
 * склеиваясь со строкой вызова, — а тест не про доставку писем.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
let project = '';

const PROPOSAL = 'Contract first, then code: @s02 writes the tests, I take the API.';
const PROPOSAL_REVISED = 'Contract first, then code: @s02 writes the tests and the review, I take the API.';
const PROPOSAL_SECOND = 'Roll out behind a flag: @s02 checks the refund edge cases.';
const PROPOSAL_REWORKED = 'Roll out behind a flag with a rollback step: @s02 checks the refund edge cases.';
const RETURN_NOTE = 'Add a rollback step';
const NOTE_TITLE = 'Decision waiting for you';

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

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

/** Клик по уведомлению без самого уведомления: main шлёт окну цель, как `createNotifier` по `click` (`attention.spec.ts`). */
async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

/** Агент зовёт инструмент `parley-mcp`: строка в его терминал, как набрал бы человек (заглушка разбирает `STUB_MCP`). */
async function agentCalls(window: Page, ref: Ref, tool: string, args: unknown): Promise<void> {
  await window.evaluate(
    ([target, line]) =>
      (globalThis as unknown as { parley: { notify: (method: string, params: unknown) => void } }).parley.notify('pty.input', {
        ref: target,
        data: line,
      }),
    [ref, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
  );
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
  closed: boolean;
}

/** Журнал уведомлений main (`PARLEY_NOTIFICATIONS=log`) — только о решениях. */
async function decisionNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  const all = await app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, body, silent, closed }) => ({
      title,
      body,
      silent,
      closed,
    })),
  );
  return all.filter((note) => note.title === NOTE_TITLE);
}

/** Текст экрана терминала: строки DOM-рендера подряд — перенесённая строка склеивается (`terminal-send.spec.ts`). */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

interface MapView {
  rooms: Array<{ id: string; proposal: { id: string; rev: number; text: string } | null }>;
  messages: Array<{ id: string; roomId: string | null; from: string; to: string[]; kind: string; text: string }>;
}

async function workMap(window: Page, workId: string): Promise<MapView> {
  const { entries } = await call<{ entries: Array<{ projectPath: string; map: MapView & { work: { id: string } } }> }>(window, 'works.list', {});
  const entry = entries.find((item) => item.projectPath === project && item.map.work.id === workId);
  if (entry === undefined) throw new Error('работы нет в снимке');
  return entry.map;
}

test.describe('решение ведущего: настоящий parley-mcp, карточка, уведомления, ответ человека (кусок 8)', () => {
  let home: string;
  let app: ElectronApplication | null = null;
  let homeBefore: string | undefined;

  test.beforeEach(async () => {
    home = await makeTempHome('room-decision');
    project = await makeTempProject('room-decision');
    // Ядро, которым второй тест кладёт замену решения в карту, читает дом из окружения этого процесса.
    homeBefore = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = home;
  });

  test.afterEach(async () => {
    if (homeBefore === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = homeBefore;
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_NOTIFICATIONS: 'log' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    return { electronApp, window };
  }

  /** Комната из двух сессий, ведущий — первая. Тихий старт: письма-приглашений нет, лента пуста. */
  async function setupRoom(window: Page): Promise<{ workId: string; key: string; lead: string; second: string; roomId: string; leadRef: Ref }> {
    // Пустой дом: работ нет, окно показывает заставку.
    await expect(window.getByTestId('landing')).toBeVisible();
    // Будильник хоста печатал бы в терминал заглушки указатели на письма, склеиваясь со строкой вызова.
    await call(window, 'wake.pause', {});
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-decision', goal: '' });
    const lead = await createSession(window, workId, 'lead');
    const second = await createSession(window, workId, 'second');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'e2e-room',
      members: [lead, second],
      lead,
      quiet: true,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    return { workId, key: `${project} ${workId}`, lead, second, roomId, leadRef: { projectPath: project, workId, sessionId: lead } };
  }

  test('propose_decision → карточка, подкраска, уведомление; повтор — rev + 1 и «revised»; Accept; новое решение в окне; возврат с заметкой и строка доставки письма', async () => {
    test.setTimeout(120_000);
    const { electronApp, window } = await launch();
    const { workId, key, lead, second, roomId, leadRef } = await setupRoom(window);

    const row = window.locator(`[data-work-key="${key}"]:not([role="tab"]) [data-room-row="${roomId}"]`);
    const roomTab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    const secondTab = window.locator(`[role="tab"][data-tab-id="terminal:${second}"]`);
    const card = window.locator('[data-decision-card]');
    const feed = window.locator('[data-room-feed]');
    await expect(row).toHaveCount(1);

    // Вкладка комнаты открыта, но на виду терминал второго агента: подкраска вкладки видна, а цель уведомления — нет.
    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId });
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    await sendFocusTarget(electronApp, { kind: 'session', ref: { projectPath: project, workId, sessionId: second } });
    await expect(secondTab).toHaveAttribute('data-active', 'true');
    await expect(roomTab).toHaveAttribute('data-active', 'false');
    await expect(roomTab).not.toHaveClass(/bg-accent-200/);

    // 1. Ведущий приносит решение. Окно без фокуса — уведомление macOS (журнал main).
    await window.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await agentCalls(window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL });
    // Решение легло в карту через настоящий MCP-сервер: строка комнаты и вкладка подкрашены, у строки слово `decision`.
    await expect(row).toContainText('decision', { timeout: 20_000 });
    await expect(row).toHaveClass(/bg-accent-200/);
    await expect(roomTab).toHaveClass(/bg-accent-200/);
    await expect
      .poll(() => decisionNotes(electronApp), { timeout: 5_000 })
      .toEqual([{ title: NOTE_TITLE, body: 'e2e-room · S01 collected positions', silent: false, closed: false }]);
    // Окно без фокуса — карточки в окне нет.
    await expect(window.locator('[data-window-note]')).toHaveCount(0);

    await roomTab.click();
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-proposal-id', 'p-01');
    await expect(card).toHaveAttribute('data-proposal-rev', '0');
    await expect(card).toContainText('Contract first, then code');

    // 2. Повтор до ответа заменяет текст: тот же id, rev + 1; карточка одна, уведомление «revised» заменило прежнее по тегу.
    await agentCalls(window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL_REVISED });
    await expect(card).toHaveAttribute('data-proposal-rev', '1', { timeout: 20_000 });
    await expect(card).toHaveAttribute('data-proposal-id', 'p-01');
    await expect(card).toContainText('and the review');
    await expect(card).toHaveCount(1);
    await expect
      .poll(() => decisionNotes(electronApp), { timeout: 5_000 })
      .toEqual([
        { title: NOTE_TITLE, body: 'e2e-room · S01 collected positions', silent: false, closed: true },
        { title: NOTE_TITLE, body: 'e2e-room · S01 revised the decision', silent: false, closed: false },
      ]);

    // 3. Accept: решение — сообщение `decision` от ведущего в ленте и в блоке Decisions, строка «You accepted the decision», карточки нет.
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(card).toHaveCount(0);
    await expect(feed.locator('[data-decisions]')).toContainText('and the review');
    const decision = feed.locator('[data-message-id]', { hasText: 'and the review' });
    await expect(decision).toHaveCount(1);
    await expect(decision).toContainText('S01 lead');
    await expect(decision.getByText('decision', { exact: true })).toHaveCount(1);
    await expect(feed.getByText('You accepted the decision')).toHaveCount(1);
    await expect(row).not.toHaveClass(/bg-accent-200/);
    await expect(roomTab).not.toHaveClass(/bg-accent-200/);
    const accepted = await workMap(window, workId);
    expect(accepted.rooms.find((item) => item.id === roomId)?.proposal).toBeNull();
    expect(accepted.messages.filter((message) => message.kind === 'decision' && message.roomId === roomId).map((message) => [message.from, message.text])).toEqual([
      [lead, PROPOSAL_REVISED],
    ]);
    // Accept ничего нового не уведомляет.
    expect(await decisionNotes(electronApp)).toHaveLength(2);

    // 4. Новое решение при окне в фокусе и вкладке комнаты не на виду — карточка в самом окне, журнал macOS не растёт.
    await secondTab.click();
    await expect(secondTab).toHaveAttribute('data-active', 'true');
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await agentCalls(window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL_SECOND });
    const note = window.locator('[data-window-note]');
    await expect(note).toHaveCount(1, { timeout: 20_000 });
    await expect(note).toContainText(NOTE_TITLE);
    await expect(note).toContainText('e2e-room · S01 collected positions');
    await expect(roomTab).toHaveClass(/bg-accent-200/);
    expect(await decisionNotes(electronApp)).toHaveLength(2);

    // Open открывает вкладку комнаты: карточка окна уходит, в ленте — новое решение (новый id).
    await note.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(note).toHaveCount(0);
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    await expect(card).toHaveAttribute('data-proposal-id', 'p-02');
    await expect(card).toHaveAttribute('data-proposal-rev', '0');

    // 5. Return for rework с заметкой → письмо ведущему `Returned for rework: …`, карточки нет.
    await card.getByRole('button', { name: 'Return for rework' }).click();
    await card.getByPlaceholder('What should the lead change?').fill(RETURN_NOTE);
    await card.getByRole('button', { name: 'Send to lead' }).click();
    await expect(card).toHaveCount(0);
    const letter = feed.locator('[data-message-id]', { hasText: `Returned for rework: ${RETURN_NOTE}` });
    await expect(letter).toHaveCount(1);
    await expect(letter).toContainText('You');
    await expect(letter).toContainText('→ S01 lead');
    // Строка доставки под письмом: ведущий его ещё не забрал, и хост говорит почему — будильник на паузе (`metrics.mailWaiting`).
    await expect(letter.locator('[data-message-waiting]')).toHaveText('▤ Not picked up yet by S01 (auto-wake paused)', { timeout: 20_000 });
    await expect(letter.locator('[data-message-picked]')).toHaveCount(0);
    const returned = await workMap(window, workId);
    expect(returned.rooms.find((item) => item.id === roomId)?.proposal).toBeNull();
    expect(
      returned.messages
        .filter((message) => message.from === 'human' && message.text.startsWith('Returned for rework'))
        .map((message) => [message.roomId, message.to, message.text]),
    ).toEqual([[roomId, [lead], `Returned for rework: ${RETURN_NOTE}`]]);
    expect(await decisionNotes(electronApp)).toHaveLength(2);

    // Письмо дошло до агента: ведущий читает входящие через тот же настоящий MCP-сервер.
    await agentCalls(window, leadRef, 'check_inbox', {});
    // `check_inbox` ставит отметку `readBy`: строка доставки меняется на «Picked up by S01» (время отметки — в подсказке), ждущих нет.
    const delivered = letter.locator('[data-message-picked]');
    await expect(delivered).toHaveText('✓ Picked up by S01', { timeout: 20_000 });
    await expect(delivered).toHaveAttribute('title', /^S01 \d{2}:\d{2}:\d{2}$/);
    await expect(letter.locator('[data-message-waiting]')).toHaveCount(0);
    await sendFocusTarget(electronApp, { kind: 'session', ref: leadRef });
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain(`Returned for rework: ${RETURN_NOTE}`);

    // 6. Ведущий переделал и предлагает снова: решение новое (новый id), но после возврата уведомление говорит «revised»
    // (спека 1.10), а не «collected positions». Окно в фокусе, на виду терминал ведущего — карточка в окне.
    await agentCalls(window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL_REWORKED });
    await expect(note).toHaveCount(1, { timeout: 20_000 });
    await expect(note).toContainText(NOTE_TITLE);
    await expect(note).toContainText('e2e-room · S01 revised the decision');
    await expect(note).not.toContainText('collected positions');
    expect((await workMap(window, workId)).rooms.find((item) => item.id === roomId)?.proposal).toMatchObject({ id: 'p-03', rev: 0 });
    expect(await decisionNotes(electronApp)).toHaveLength(2);
  });

  test('решение, что уже ждёт, не уведомляет заново — ни после перезапуска окна, ни после переподключения к хосту', async () => {
    test.setTimeout(150_000);
    const first = await launch();
    const { workId, key, lead, roomId, leadRef } = await setupRoom(first.window);
    await first.window.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await agentCalls(first.window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL });
    const rowOf = (window: Page) => window.locator(`[data-work-key="${key}"]:not([role="tab"]) [data-room-row="${roomId}"]`);
    await expect(rowOf(first.window)).toContainText('decision', { timeout: 20_000 });
    await expect.poll(() => decisionNotes(first.electronApp), { timeout: 5_000 }).toHaveLength(1);

    // Перезапуск окна: хост и агенты живут дальше, решение в карте ждёт. Первый снимок нового окна — база.
    await quitApp(first.electronApp);
    const second = await launch();
    await expect(second.window.getByTestId('app-shell')).toBeVisible();
    await expect(rowOf(second.window)).toContainText('decision', { timeout: 20_000 });
    await second.window.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await second.window.waitForTimeout(2_000);
    expect(await decisionNotes(second.electronApp)).toEqual([]);
    await expect(second.window.locator('[data-window-note]')).toHaveCount(0);
    // Уведомитель жив: замена того же решения (агент в хосте не перезапускался) — единственное уведомление.
    await agentCalls(second.window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL_REVISED });
    await expect
      .poll(() => decisionNotes(second.electronApp), { timeout: 10_000 })
      .toEqual([{ title: NOTE_TITLE, body: 'e2e-room · S01 revised the decision', silent: false, closed: false }]);

    // Переподключение к хосту: «Restart host» — окно то же, связь новая, подписки заводятся заново, первый снимок — база.
    await second.window.evaluate(() => (globalThis as unknown as { parley: { app: { restartHost: () => Promise<void> } } }).parley.app.restartHost());
    await expect(rowOf(second.window)).toContainText('decision', { timeout: 30_000 });
    await second.window.waitForTimeout(2_000);
    expect(await decisionNotes(second.electronApp)).toHaveLength(1);
    // Снова живой уведомитель: агенты после перезапуска хоста спят, замену кладёт в карту ядро, как положил бы `propose_decision`.
    await updateMap(project, workId, (map) => {
      setProposal(map, roomId, lead, PROPOSAL_SECOND);
    });
    await expect
      .poll(() => decisionNotes(second.electronApp), { timeout: 10_000 })
      .toEqual([
        { title: NOTE_TITLE, body: 'e2e-room · S01 revised the decision', silent: false, closed: true },
        { title: NOTE_TITLE, body: 'e2e-room · S01 revised the decision', silent: false, closed: false },
      ]);
  });

  test('клик по уведомлению macOS о решении открывает вкладку комнаты с карточкой', async () => {
    test.setTimeout(90_000);
    const { electronApp, window } = await launch();
    const { workId, second, roomId, leadRef } = await setupRoom(window);
    const roomTab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    // На виду терминал второго агента, вкладки комнаты в раскладке ещё нет.
    await sendFocusTarget(electronApp, { kind: 'session', ref: { projectPath: project, workId, sessionId: second } });
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${second}"]`)).toHaveAttribute('data-active', 'true');
    await expect(roomTab).toHaveCount(0);

    await window.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await agentCalls(window, leadRef, 'propose_decision', { room: roomId, text: PROPOSAL });
    await expect.poll(() => decisionNotes(electronApp), { timeout: 20_000 }).toHaveLength(1);

    // Клик по записи журнала делает то же, что клик по настоящему уведомлению: main поднимает окно и шлёт ему цель.
    await electronApp.evaluate(() => {
      const log = (globalThis as { __parleyNotifications?: Array<{ title: string; click(): void }> }).__parleyNotifications ?? [];
      log.filter((entry) => entry.title === 'Decision waiting for you').at(-1)?.click();
    });
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    await expect(window.locator('[data-decision-card]')).toHaveAttribute('data-proposal-id', 'p-01');
    await expect(window.locator('[data-decision-card]')).toContainText('Contract first, then code');
  });

  test('стопка карточек в окне 800×500: не больше двух, новая сверху, кнопки в окне; тост встаёт над ними, а не на кнопки', async () => {
    test.setTimeout(90_000);
    const { electronApp, window } = await launch();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    // Три комнаты с длинными названиями (самая высокая карточка — 6–7 строк текста) кладёт тест ядром: сессии не
    // запускаются, процессов агентов нет; решения ляжут по одному — каждое отдельным снимком, а не базой.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-notes-stack', goal: '' });
    const rooms: Array<{ id: string; lead: string }> = [];
    await updateMap(project, workId, (map) => {
      rooms.length = 0;
      for (const letter of ['R', 'Q', 'T']) {
        const lead = addSession(map, { provider: 'claude', label: `lead-${letter}`, task: '' }).id;
        const member = addSession(map, { provider: 'claude', label: `member-${letter}`, task: '' }).id;
        const room = addRoom(map, { title: `Room-${letter.repeat(110)}`, creator: HUMAN, members: [lead, member], lead });
        rooms.push({ id: room.id, lead });
      }
    });
    await expect(window.locator('[data-room-row]')).toHaveCount(3, { timeout: 20_000 });

    // Окно в фокусе, ни одна вкладка комнаты не открыта: решения показываются карточками в окне.
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    const cards = window.locator('[data-window-note]');
    for (const room of rooms) {
      await updateMap(project, workId, (map) => {
        setProposal(map, room.id, room.lead, 'Roll out behind a flag: the refund edge cases first.');
      });
      // По одному: каждое решение — свой снимок карты и своя карточка.
      await expect(window.locator(`[data-window-note$=":${room.id}"]`)).toHaveCount(1, { timeout: 20_000 });
    }

    // Не больше двух: самая старая (первая комната) ушла; новая — сверху.
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('data-window-note', new RegExp(`:${rooms[2]?.id}$`));
    await expect(cards.nth(1)).toHaveAttribute('data-window-note', new RegExp(`:${rooms[1]?.id}$`));

    const inside = async (locator: ReturnType<Page['locator']>): Promise<boolean> => {
      const box = await locator.boundingBox();
      return box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= 800 && box.y + box.height <= 500;
    };
    // Обе карточки целиком и их кнопки — в окне 800×500 (три такие карточки выходили за верх).
    for (const index of [0, 1]) {
      const card = cards.nth(index);
      expect(await inside(card), `карточка ${index}`).toBe(true);
      expect(await inside(card.getByRole('button', { name: 'Open', exact: true })), `Open ${index}`).toBe(true);
      expect(await inside(card.getByRole('button', { name: 'Later', exact: true })), `Later ${index}`).toBe(true);
    }

    // Тост в том же углу: закрытие вкладки мышью. Вкладка комнаты первой (её карточку уже вытеснили) — не цель карточек.
    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId: rooms[0]?.id });
    const tab = window.locator(`[role="tab"][data-tab-id="room:${rooms[0]?.id}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    await tab.click({ button: 'middle' });
    const toast = window.locator('[data-sonner-toast]').filter({ hasText: 'Tab closed' });
    await expect(toast).toBeVisible();
    await expect(cards).toHaveCount(2);

    // Тост целиком в окне и не задевает ни одной карточки: он стоит над стопкой. Высоту стопки тостам отдаёт
    // `ResizeObserver`, поэтому раскладка устаканивается за кадр-другой — ждём её, а не сравниваем сразу.
    const overlaps = async (): Promise<boolean> => {
      const toastBox = await toast.boundingBox();
      if (toastBox === null) return true;
      for (const index of [0, 1]) {
        const box = await cards.nth(index).boundingBox();
        if (box === null) return true;
        const apart = toastBox.x + toastBox.width <= box.x || box.x + box.width <= toastBox.x || toastBox.y + toastBox.height <= box.y || box.y + box.height <= toastBox.y;
        if (!apart) return true;
      }
      return false;
    };
    await expect.poll(overlaps, { timeout: 5_000 }).toBe(false);
    expect(await inside(toast), 'тост в окне').toBe(true);
    // Переменная жива, пока столбец стоит, и снята вместе с ним: «Later» на обеих карточках.
    const inset = (): Promise<string> => window.evaluate(() => document.documentElement.style.getPropertyValue('--toast-inset-bottom'));
    expect(await inset()).toMatch(/^\d+(\.\d+)?px$/);
    await cards.nth(0).getByRole('button', { name: 'Later', exact: true }).click();
    await cards.nth(0).getByRole('button', { name: 'Later', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect.poll(inset).toBe('');
  });
});
