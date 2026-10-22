import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';
import { seedTrust } from './trust-seed.js';

/**
 * Комната с застрявшими участниками (спека застрявших сессий 2026-10-12, раздел 9 «E2E» и раздел 8; задача 11 плана,
 * задача 7 плана подписок): ведущий S01 — заглушка Claude, S02 — заглушка Codex, S03 — заглушка Claude. Окно 800×500,
 * названия работы, комнаты и ярлыки сессий нарочно длинные. Рычаги часов: порог доклада `PARLEY_STUCK_REPORT_MS`,
 * срок возврата без времени сброса `PARLEY_LIMIT_RETRY_MS`, запас `PARLEY_LIMIT_RETURN_GRACE_MS`.
 *
 * 1. Одобрение. Codex просит одобрения (`STUB_APPROVAL`, OSC 9 `Approval requested: ls -la`): метка `approval` у участника
 *    и в строке сайдбара, уведомление с причиной (`Waiting for your approval: ls -la`, беззвучный баннер, звенит окно),
 *    по порогу — строка ленты и письмо Parley ведущему. Ведущий читает всё это инструментами настоящего `parley-mcp`
 *    (`STUB_MCP`): `check_inbox` приносит письмо, `get_map` — `stuck` у `s-02`, `wait_for` кончается `state: "stuck"`.
 * 2. Лимит Claude без времени. Хук `StopFailure` (`rate_limit`) у S03 — метка `limit`, строка ленты, письмо ведущему
 *    без абзаца про другие аккаунты (аккаунтов нет); сообщение человека `@s03 …` под собой несёт «Not picked up yet by
 *    S03 (usage limit)»; по сроку возврата хост печатает в терминал S03 «Your usage limit has reset. Read your inbox
 *    first…»; ход начался (`UserPromptSubmit`) — строка «is back (the usage limit has reset)» и письмо «back».
 * 3. Лимит Codex. `STUB_LIMIT` (`task_complete` с `usage_limit_exceeded` в журнале треда): метка `limit · <час>`,
 *    уведомление «Codex usage limit reached» (тег `limit:codex`), строка ленты.
 * 4. Вид 800×500. Метки `approval` (у ведущего, рядом со ★) и `limit` в полосе участников и в строках сайдбара целы
 *    и не выходят за правый край карточки и строки, в светлой и тёмной теме.
 *
 * Уведомления main пишет в журнал (`PARLEY_NOTIFICATIONS=log`, `playwright.config.ts`), фокус окна тест задаёт событиями
 * `focus`/`blur` рендерера — фокус ОС между параллельными окнами гуляет (`attention.spec.ts`, `stuck-notify.spec.ts`).
 * Окно баннера «нужно действие» выжидает секунду (`NEED_SETTLE_MS`). `E2E_DPR=2` запускает окно с
 * `--force-device-scale-factor=2` (как у прочих визуальных спеков). Снимки — в `test-results/stuck-sessions/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubClaude = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const shots = path.resolve(dirname, '../test-results/stuck-sessions');
const dpr = process.env.E2E_DPR === '2' ? '2' : '1';

const WORK_TITLE = 'Payments ledger migration and the invoice export rework for the autumn release';
const ROOM_TITLE = 'Refund flow review: ledger, invoices and the export job in one room';
const LABEL_LEAD = 'Release coordinator for the payments ledger work';
const LABEL_CODEX = 'Codex reviewer of the invoice export job';
const LABEL_CLAUDE = 'Claude implementer of the refund edge cases';
/** Текст ошибки Claude Code без времени сброса — хост вернёт сессию по `PARLEY_LIMIT_RETRY_MS`. */
const SESSION_LIMIT = "You've hit your session limit";

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

let project = '';
let home = '';

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

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
}

/** Клик по уведомлению без самого уведомления: main шлёт окну цель, как `createNotifier` по `click` (`attention.spec.ts`). */
async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

/** Фокус окна задаёт тест: ОС между параллельными окнами его перекидывает. */
async function setWindowFocus(window: Page, focused: boolean): Promise<void> {
  await window.evaluate((name) => globalThis.dispatchEvent(new Event(name)), focused ? 'focus' : 'blur');
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
}

/** Журнал уведомлений main (`PARLEY_NOTIFICATIONS=log`). */
async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, body, silent }) => ({ title, body, silent })),
  );
}

/** Отправка окна агенту вставкой и Enter — `pty.send`; отказ хоста («ещё не Ready») приходит результатом, а не ошибкой. */
async function sendSubmitted(window: Page, ref: Ref, text: string): Promise<boolean> {
  return (await call<{ submitted: boolean }>(window, 'pty.send', { ref, text, submit: true })).submitted;
}

/** Строка в терминал заглушки сырым вводом, как набрал бы человек (`pty.input`): ответа не ждёт. */
async function typeLine(window: Page, ref: Ref, line: string): Promise<void> {
  await window.evaluate(
    ([target, data]) => (globalThis as unknown as { parley: { notify: (method: string, params: unknown) => void } }).parley.notify('pty.input', { ref: target, data }),
    [ref, `${line}\r`] as const,
  );
}

/** Событие хука от имени сессии: строка `STUB_HOOK` (заглушка пишет её в журнал `events/` и шлёт хосту HTTP-хуком). */
async function fireHook(window: Page, ref: Ref, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  await typeLine(window, ref, `STUB_HOOK ${JSON.stringify({ hook_event_name: event, ...fields })}`);
}

interface McpEntry {
  session: string | null;
  tool: string;
  isError: boolean;
  text: string;
}

/** Результаты вызовов инструментов `parley-mcp` заглушками Claude (`STUB_MCP_LOG`), по порядку. */
async function mcpEntries(): Promise<McpEntry[]> {
  const text = await readFile(path.join(home, 'mcp.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      return line === '' ? [] : [JSON.parse(line) as McpEntry];
    } catch {
      return []; // Последняя строка ещё пишется.
    }
  });
}

/** Агент зовёт инструмент `parley-mcp` (как `room-decision.spec.ts`); ответ — текст результата из журнала заглушки. */
async function agentCalls(window: Page, ref: Ref, tool: string, args: unknown): Promise<string> {
  const mine = async (): Promise<McpEntry[]> => (await mcpEntries()).filter((entry) => entry.session === ref.sessionId && entry.tool === tool);
  const before = (await mine()).length;
  await typeLine(window, ref, `STUB_MCP ${tool} ${JSON.stringify(args)}`);
  // Первый вызов поднимает сам MCP-сервер — до нескольких секунд под нагрузкой.
  await expect.poll(async () => (await mine()).length, { message: `ответ ${tool}`, timeout: 30_000 }).toBeGreaterThan(before);
  const entry = (await mine())[before] as McpEntry;
  expect(entry.isError, `${tool}: ${entry.text}`).toBe(false);
  return entry.text;
}

/** Все строки JSON-значения подряд: письма и поля ответа инструмента читаются без привязки к форме ответа. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** Заглушка Claude поднялась и читает ввод: она пишет в журнал `events/` строку `StubReady`, и сразу за ней вешает чтение stdin. */
async function claudeStubUp(workId: string, sessionId: string): Promise<boolean> {
  const journal = path.join(project, '.parley', 'works', workId, 'events', `${sessionId}.jsonl`);
  return (await readFile(journal, 'utf8').catch(() => '')).includes('StubReady');
}

/** Текст экрана терминала: строки DOM-рендера подряд — перенесённая строка склеивается (`terminal-send.spec.ts`). */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

async function pickTheme(window: Page, theme: 'light' | 'dark'): Promise<void> {
  await window.keyboard.press('Meta+J');
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(`Theme: ${theme}`);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(`Theme: ${theme}`);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
  if (theme === 'dark') await expect(window.locator('html')).toHaveClass(/\bdark\b/);
  else await expect(window.locator('html')).not.toHaveClass(/\bdark\b/);
}

/**
 * Метка целиком и в рамке: её правый край не правее правого края `container` (карточка участника, строка сайдбара),
 * а сам текст не обрезан многоточием (`scrollWidth` не больше `clientWidth`).
 */
async function expectWordFits(word: Locator, container: Locator): Promise<void> {
  const wordBox = await word.boundingBox();
  const containerBox = await container.boundingBox();
  if (wordBox === null || containerBox === null) throw new Error('у метки или её контейнера нет рамки — они не показаны');
  expect(wordBox.width).toBeGreaterThan(0);
  expect(wordBox.x + wordBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 0.5);
  expect(wordBox.x).toBeGreaterThanOrEqual(containerBox.x - 0.5);
  const clipped = await word.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(clipped, 'метка обрезана многоточием').toBeLessThanOrEqual(0);
}

interface Opened {
  app: ElectronApplication;
  window: Page;
  workId: string;
  roomId: string;
  /** S01 — ведущий (Claude), S02 — Codex, S03 — Claude. */
  lead: Ref;
  codex: Ref;
  claude: Ref;
  /** Строка комнаты в сайдбаре, развёрнутая: в ней строки трёх участников. */
  roomRow: Locator;
  errors: string[];
}

test.describe('комната с застрявшими участниками в окне 800×500 (спека застрявших, раздел 9)', () => {
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('stuck-sessions');
    project = await makeTempProject('stuck-sessions');
    await mkdir(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /**
   * Окно, работа с тремя сессиями и комната из них (ведущий — S01, тихий старт: писем-приглашений нет, лента пуста).
   * Проба версий включена: хост даёт Claude Code адрес HTTP-хуков только при известной версии CLI, а без него заглушка
   * строку `STUB_HOOK` не разбирает. Все три заглушки живы, вкладка комнаты открыта, окно сужено до 800×500.
   */
  async function open(extraEnv: Record<string, string> = {}): Promise<Opened> {
    const codexRoot = path.join(home, 'codex-sessions');
    await mkdir(codexRoot, { recursive: true });
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubClaude,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_NOTIFICATIONS: 'log',
      // Журнал треда Codex: хост находит лимит по `task_complete` с ошибкой, заглушка пишет его туда же (STUB_LIMIT).
      PARLEY_CODEX_SESSIONS_DIR: codexRoot,
      STUB_CODEX_SESSIONS: codexRoot,
      STUB_CODEX_VERSION: '0.160.0',
      // Заглушка Claude в режиме вставки: указатель и возврат после лимита хост печатает вставкой.
      STUB_BRACKETED: '1',
      STUB_MCP_LOG: path.join(home, 'mcp.jsonl'),
      // Рычаги часов: доклад об одобрении через секунду, возврат после лимита без времени сброса через две.
      PARLEY_STUCK_REPORT_MS: '1000',
      PARLEY_LIMIT_RETRY_MS: '2000',
      PARLEY_LIMIT_RETURN_GRACE_MS: '500',
      ...extraEnv,
    };
    // Сессия Codex в проекте без согласия удерживалась бы до решения человека (спека 2026-10-21, 4.2).
    await seedTrust(home, project);
    const app = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
    running = app;
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const leadId = await createSession(window, workId, 'claude', LABEL_LEAD);
    const codexId = await createSession(window, workId, 'codex', LABEL_CODEX);
    const claudeId = await createSession(window, workId, 'claude', LABEL_CLAUDE);
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: ROOM_TITLE,
      members: [leadId, codexId, claudeId],
      lead: leadId,
      quiet: true,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    const refOf = (sessionId: string): Ref => ({ projectPath: project, workId, sessionId });
    await expect.poll(() => claudeStubUp(workId, leadId), { message: 'заглушка S01', timeout: 30_000 }).toBe(true);
    await expect.poll(() => claudeStubUp(workId, claudeId), { message: 'заглушка S03', timeout: 30_000 }).toBe(true);

    // Вкладка комнаты на виду, окно в фокусе; потом окно сужается — метки считаются уже в 800×500.
    const roomRow = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"]) [data-room-row="${roomId}"]`);
    await expect(roomRow).toHaveCount(1);
    await sendFocusTarget(app, { kind: 'room', projectPath: project, workId, roomId });
    await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');
    await resize(app, 800, 500);
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);
    await setWindowFocus(window, true);
    if ((await roomRow.getAttribute('aria-expanded')) !== 'true') await roomRow.getByRole('button', { name: 'Show agents' }).click();
    await expect(roomRow.locator('[data-session-id]')).toHaveCount(3);
    return { app, window, workId, roomId, lead: refOf(leadId), codex: refOf(codexId), claude: refOf(claudeId), roomRow, errors };
  }

  const card = (opened: Opened, ref: Ref): Locator => opened.window.locator(`[data-participant="${ref.sessionId}"]`);
  const row = (opened: Opened, ref: Ref): Locator => opened.roomRow.locator(`[data-session-id="${ref.sessionId}"]`);
  const feed = (opened: Opened): Locator => opened.window.locator('[data-room-feed]');

  test('одобрение: метка, уведомление с причиной, строка ленты, письмо ведущему; get_map, wait_for и check_inbox ведущего', async () => {
    test.setTimeout(120_000);
    const opened = await open();
    const { app, window, lead, codex } = opened;

    // Codex просит одобрения: хост отвечает на `pty.send`, только когда знает, что у агента на экране (заглушка прислала `Ready`).
    await expect.poll(() => sendSubmitted(window, codex, 'STUB_APPROVAL'), { timeout: 30_000 }).toBe(true);

    // Метка вместо слова состояния — у участника в полосе комнаты и в строке сайдбара; в подсказке — что ждёт и команда.
    const word = card(opened, codex).getByText('approval', { exact: true });
    await expect(word).toBeVisible({ timeout: 10_000 });
    await expect(word).toHaveAttribute('title', 'Waiting for approval: ls -la');
    await expect(row(opened, codex).getByText('approval', { exact: true })).toBeVisible();

    // Уведомление окна: причина, а не задача сессии; сессия в комнате — хвост `· room <название>`; баннер беззвучный,
    // звенит окно. Пока цель (терминал Codex) не на виду, а вкладка комнаты активна.
    await expect
      .poll(async () => (await loggedNotes(app)).filter((note) => note.body.includes('Waiting for your approval: ls -la')), { timeout: 10_000 })
      .toHaveLength(1);
    const [note] = (await loggedNotes(app)).filter((item) => item.body.includes('Waiting for your approval: ls -la'));
    expect(note?.silent).toBe(true);
    expect(note?.title).toMatch(/ — needs you$/);
    expect(note?.body).toContain(`· room ${ROOM_TITLE}`);
    expect(await window.evaluate(() => (globalThis as { __parleyChimes?: number }).__parleyChimes ?? 0)).toBeGreaterThanOrEqual(1);

    // По порогу (секунда): строка ленты для человека.
    await expect(feed(opened)).toContainText('is waiting for your approval in its terminal: ls -la', { timeout: 10_000 });

    // Ведущий читает письмо Parley: вид, команда и просьба не решать за застрявшего.
    const inbox = await agentCalls(window, lead, 'check_inbox', {});
    const letters = strings(JSON.parse(inbox)).filter((text) => text.includes('is waiting for the human in its terminal'));
    expect(letters).toHaveLength(1);
    expect(letters[0]).toContain('(approval: ls -la)');
    expect(letters[0]).toContain('Do not hand its part to anyone');

    // Карта: `stuck` у s-02 (вид и команда), у остальных — нет.
    const { map } = JSON.parse(await agentCalls(window, lead, 'get_map', {})) as {
      map: { sessions: Array<{ id: string; stuck: { kind: string; detail: string | null } | null }> };
    };
    const stuckOf = (id: string): { kind: string; detail: string | null } | null => map.sessions.find((session) => session.id === id)?.stuck ?? null;
    expect(stuckOf(codex.sessionId)).toMatchObject({ kind: 'approval', detail: 'ls -la' });
    expect(stuckOf(lead.sessionId)).toBeNull();

    // `wait_for` на застрявшего кончается сразу и подсказывает не ждать его снова.
    const waited = JSON.parse(await agentCalls(window, lead, 'wait_for', { target: codex.sessionId, timeoutSec: 5 })) as { state: string; hint: string };
    expect(waited.state).toBe('stuck');
    expect(waited.hint).toContain('Do not wait_for it again');
    expect(opened.errors).toEqual([]);
  });

  test('лимит Claude без времени: метка, письмо ведущему без чужих аккаунтов, «Not picked up yet», возврат после срока и «is back»', async () => {
    test.setTimeout(120_000);
    // Срок возврата 8 с, а не 2: окну нужно успеть показать метку и строку доставки до того, как хост напечатает возврат.
    const opened = await open({ PARLEY_LIMIT_RETRY_MS: '8000' });
    const { window, roomId, lead, claude } = opened;

    // Ход начат и оборван лимитом подписки: `StopFailure` без времени сброса.
    await fireHook(window, claude, 'UserPromptSubmit', { prompt: 'Cover the refund edge cases' });
    await fireHook(window, claude, 'StopFailure', { error: 'rate_limit', last_assistant_message: SESSION_LIMIT });
    await expect(card(opened, claude).getByText('limit', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(row(opened, claude).getByText('limit', { exact: true })).toBeVisible();
    await expect(card(opened, claude).getByText('limit', { exact: true })).toHaveAttribute('title', `Usage limit reached: ${SESSION_LIMIT}`);

    // Строка ленты: лимит доложен сразу, время сброса неизвестно; S03 не ведущий — подсказки про «Make lead» нет.
    await expect(feed(opened)).toContainText('hit its Claude Code usage limit; the reset time is unknown', { timeout: 10_000 });
    await expect(feed(opened)).not.toContainText('leads this room');

    // Человек пишет застрявшему: письмо удержано, под сообщением причина из `need`.
    await call(window, 'rooms.send', {
      projectPath: project,
      workId: opened.workId,
      roomId,
      to: [claude.sessionId],
      text: '@s03 pick up the refund edge cases once you are back',
      kind: 'note',
    });
    await expect(feed(opened).locator('[data-message-waiting]')).toContainText('Not picked up yet by S03 (usage limit)', { timeout: 10_000 });

    // Письмо ведущему: кто, до когда, что делать; других аккаунтов Claude Code в Parley нет — абзаца о них нет.
    const inbox = strings(JSON.parse(await agentCalls(window, lead, 'check_inbox', {})));
    const limitLetters = inbox.filter((text) => text.includes('usage limit; the reset time is unknown'));
    expect(limitLetters).toHaveLength(1);
    expect(limitLetters[0]).toContain('@s03 hit its Claude Code usage limit');
    expect(limitLetters[0]).toContain('write one message to @human');
    expect(inbox.join('\n')).not.toContain('Other Claude Code accounts');

    // Срок возврата: хост печатает в терминал S03 просьбу продолжить (и указатель на письмо человека).
    await sendFocusTarget(opened.app, { kind: 'session', ref: claude });
    // Хуки уже пришли — вкладка сессии открывается чатом; экран заглушки виден в виде Terminal.
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect.poll(() => screenText(window), { message: 'возврат в терминале S03', timeout: 30_000 }).toContain(
      'Your usage limit has reset. Read your inbox first, then continue the task the limit interrupted.',
    );

    // Агент прочёл просьбу и начал ход: эпизод кончился — «is back» в ленте комнаты, письмо «back» ведущему, метки нет.
    await fireHook(window, claude, 'UserPromptSubmit', { prompt: 'Your usage limit has reset.' });
    await sendFocusTarget(opened.app, { kind: 'room', projectPath: project, workId: opened.workId, roomId });
    await expect(feed(opened)).toContainText('is back (the usage limit has reset)', { timeout: 15_000 });
    await expect(card(opened, claude).getByText('limit', { exact: true })).toHaveCount(0);
    const back = strings(JSON.parse(await agentCalls(window, lead, 'check_inbox', {})));
    expect(back.some((text) => text.includes('@s03 is back (the usage limit has reset). Messages that waited are being delivered.'))).toBe(true);
    expect(opened.errors).toEqual([]);
  });

  test('лимит Codex: метка с часом сброса, уведомление «Codex usage limit reached», строка ленты', async () => {
    test.setTimeout(120_000);
    const opened = await open();
    const { app, window, codex } = opened;
    // Лимит решает комната, поэтому её вкладка на виду погасила бы баннер: окно без фокуса, как у человека за другой программой.
    await setWindowFocus(window, false);

    // Время сброса — в тексте ошибки, как его пишет Codex; ближайшие 23:59 по часам машины.
    await expect
      .poll(() => sendSubmitted(window, codex, "STUB_LIMIT You've hit your usage limit. Upgrade to Pro, or try again at 11:59 PM."), { timeout: 30_000 })
      .toBe(true);
    const word = card(opened, codex).getByText(/^limit/);
    await expect(word).toHaveText(/^limit · (?:[A-Z][a-z]{2} \d{1,2}, )?23:59$/, { timeout: 30_000 });
    await expect(row(opened, codex).getByText(/^limit · /)).toBeVisible();

    // Одно уведомление на провайдера: тег `limit:codex`, заголовок — аккаунт, тело — кто ждёт и до какого часа.
    await expect
      .poll(async () => (await loggedNotes(app)).filter((note) => note.title === 'Codex usage limit reached'), { timeout: 10_000 })
      .toHaveLength(1);
    const [note] = (await loggedNotes(app)).filter((item) => item.title === 'Codex usage limit reached');
    expect(note?.silent).toBe(true);
    expect(note?.body).toMatch(/^S02 waits until (?:[A-Z][a-z]{2} \d{1,2}, )?23:59$/);

    await expect(feed(opened)).toContainText(/hit its Codex usage limit; it resets at (?:[A-Z][a-z]{2} \d{1,2}, )?23:59/, { timeout: 10_000 });
    expect(opened.errors).toEqual([]);
  });

  test('вид 800×500: метки approval (у ведущего со ★), limit · час и limit целы и не выходят за край карточки и строки — в обеих темах', async () => {
    test.setTimeout(150_000);
    const opened = await open();
    const { window, lead, codex, claude } = opened;

    // Ведущий просит разрешения: журнал хука `Notification` с видом `permission_prompt` и длинной командой.
    await fireHook(window, lead, 'Notification', {
      notification_type: 'permission_prompt',
      message: 'npm install --save-dev @testing-library/react @testing-library/user-event @playwright/test',
    });
    // Codex упёрся в лимит с часом сброса (самая длинная метка), Claude — в лимит без времени.
    await expect.poll(() => sendSubmitted(window, codex, "STUB_LIMIT You've hit your usage limit. Try again at 11:59 PM."), { timeout: 30_000 }).toBe(true);
    await fireHook(window, claude, 'StopFailure', { error: 'rate_limit', last_assistant_message: SESSION_LIMIT });

    const words = [
      { ref: lead, text: /^approval$/ },
      { ref: codex, text: /^limit · / },
      { ref: claude, text: /^limit$/ },
    ];
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      for (const { ref, text } of words) {
        const cardWord = card(opened, ref).getByText(text);
        await expect(cardWord).toBeVisible({ timeout: 30_000 });
        await expectWordFits(cardWord, card(opened, ref));
        const rowWord = row(opened, ref).getByText(text);
        await expect(rowWord).toBeVisible();
        await expectWordFits(rowWord, row(opened, ref));
        // Строка не выходит и за карточку работы в сайдбаре.
        await expectWordFits(rowWord, window.locator(`[data-work-key="${project} ${opened.workId}"]:not([role="tab"])`));
      }
      await window.waitForTimeout(300);
      await window.screenshot({ path: path.join(shots, `labels-800x500-dpr${dpr}-${theme}.png`) });
    }
    expect(opened.errors).toEqual([]);
  });
});
