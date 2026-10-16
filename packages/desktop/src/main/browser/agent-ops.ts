/**
 * Операции агента над браузером окна в main (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1–5.2, 7; этап B2:
 * `open`). Событие хоста `browser.agentOp` приходит сюда (`host-connection.ts#answerBrowserAgentOps`), ответ уходит
 * методом `browser.agentResult`.
 *
 * Агент называет только адрес: работу вкладки задаёт хост по токену сессии (`ref` события), а не аргументы. Адрес должен
 * быть http(s) на loopback (`shared/loopback.ts`) и до окна доходит без учётных данных. Раскладка — дело окна:
 * место вкладки, предел страниц панели, повтор уже открытой страницы и тост решает рендерер (`renderer/browser/agent-open.ts`), main
 * просит его событием `browser:agent-open-tab`, ждёт ответ не дольше `AGENT_LIMITS.openMs` и переводит его в ответ агенту.
 * Страницы панелей main знает по реестру (`registerTab`, наполняет окно): по нему работает `tabs` (этап C), доступ к странице
 * решает хозяин из `owners` и пауза панели (`pageOf`). `open` страницу не трогает: ни гостя, ни CDP, ни ожидания загрузки.
 *
 * Чей браузер получает страницу, решает `ownerOf` по правилу спеки 5.1 и по `owners` события — хозяевам, которых хост
 * вложил по карте работы (3.7, 3.10); хозяин вне списка — `access_denied`. Выбранный хозяин уходит окну в `AgentOpenTab`.
 *
 * Вкладку агент называет коротким id (`t1`, `t2`…): у каждой работы свой счёт, id держится, пока жив main. Этапы C и D
 * опираются на те же id.
 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { AGENT_LIMITS, browserAgentArgs } from '@parley/protocol';
import type {
  BrowserAgentArgs,
  BrowserAgentConsoleEntry,
  BrowserAgentConsoleResult,
  BrowserAgentErrorCode,
  BrowserAgentNetworkResult,
  BrowserAgentOpEvent,
  BrowserAgentOpenResult,
  BrowserAgentOwner,
  BrowserAgentRequestDetail,
  BrowserAgentRequestSummary,
  BrowserAgentResult,
  BrowserAgentScreenshotResult,
  BrowserAgentTabInfo,
} from '@parley/protocol';
import { DEVTOOLS_LIMITS, isFailed, VIEWPORT_PRESETS, viewportSize } from '../../shared/browser-devtools.js';
import type { ConsoleEntry, DevtoolsSnapshot, NetworkEntry, StackFrame, ViewportPreset, ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity, AgentOpenTab, AgentOpenTabResult, AgentPageRegistration } from '../../shared/browser-types.js';
import type { BrowserOwner } from '../../shared/layout-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { redactBody, redactHeaders, redactUrl, redactUrlsInText, unmaskableJson } from '../../shared/redact.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';

export interface AgentOpsDeps {
  /** «Let agents use the browser» (`UiFile.browser.agentsAllowed`): читается на каждую операцию. */
  agentsAllowed(): Promise<boolean>;
  /** Просит окно открыть вкладку (`browser:agent-open-tab`); `false` — окно не готово слушать. */
  openTab(e: AgentOpenTab): boolean;
  /** Сколько ждать ответа окна; по умолчанию `AGENT_LIMITS.openMs`. Тестам — меньше. */
  openMs?: number;
  /** Гость-страница по id её WebContents; `null` — такого нет. */
  fromId(id: number): WebContents | null;
  inspector: Pick<Inspector, 'snapshot' | 'send' | 'responseBody'>;
  emulation: Pick<Emulation, 'current' | 'withTemporary'>;
  /** PNG снимка — в `drops/` (`main/drops.ts#saveImage`); `null` — не сохранился. */
  saveImage(png: Buffer): Promise<string | null>;
  /** Картинки в main — `nativeImage`, в тестах заглушка. */
  image: { size(png: Buffer): { width: number; height: number }; resize(png: Buffer, width: number, height: number): Buffer; stitch(parts: Buffer[]): Buffer };
  /** Агент действует на странице: окно-хозяин показывает это человеку. */
  activity(e: AgentActivity): void;
  /** Сколько ждать операцию на странице; по умолчанию `AGENT_LIMITS.opMs - 2_000`, чтобы очередь освобождалась раньше `timeout` хоста. */
  opTimeoutMs?: number;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
  /** Окно сообщает о странице панели, её закрытии или паузе панели (спека 3.7, 4.8). */
  registerTab(e: AgentPageRegistration): void;
  /** Окно перезагрузилось: реестр и паузы забыты до новой регистрации, id агента сохраняются. */
  reset(): void;
}

/** Ответ `Page.getLayoutMetrics`: нужные поля. */
export interface LayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
  cssContentSize: { x: number; y: number; width: number; height: number };
}

/** Отказ операции с кодом протокола; текст читает агент. */
export class AgentOpError extends Error {
  readonly code: BrowserAgentErrorCode;

  constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Записей в ответе по умолчанию — то же число, что `default` в схемах инструментов MCP. */
const DEFAULT_LIST = 50;

/** Новейшие записи в пределах `limit` и `AGENT_LIMITS.listBytes` (по JSON), старые — первыми. Одна длинная запись проходит. */
function newest<T>(items: readonly T[], limit: number): T[] {
  const picked: T[] = [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const item = items[index] as T;
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > AGENT_LIMITS.listBytes && picked.length > 0) break;
    picked.push(item);
  }
  return picked.reverse();
}

/** Срок операции в main: очередь страницы не ждёт зависшую команду CDP дольше хоста. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentOpError('timeout', message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const frameText = (frame: StackFrame): string => `${frame.fn === '' ? '(anonymous)' : frame.fn} (${redactUrl(frame.url)}:${frame.line}:${frame.column})`;

function toAgentConsole(entry: ConsoleEntry): BrowserAgentConsoleEntry {
  return {
    level: entry.level,
    origin: entry.origin,
    text: redactUrlsInText(entry.text),
    source: entry.location === null ? null : `${redactUrl(entry.location.url)}:${entry.location.line}:${entry.location.column}`,
    stack: entry.stack.map(frameText),
    count: entry.count,
    at: new Date(entry.ts).toISOString(),
  };
}

function summaryOf(entry: NetworkEntry): BrowserAgentRequestSummary {
  return { id: entry.id, method: entry.method, url: redactUrl(entry.url), kind: entry.kind, status: entry.status, statusText: entry.statusText, failure: entry.failure, durationMs: entry.durationMs, mimeType: entry.mimeType };
}

const headerValue = (headers: ReadonlyArray<[string, string]>, name: string): string | null => headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

/**
 * Тело для агента (спека 6): маска — до обрезки, `redactBody` режет уже замаскированное. JSON, который нельзя разобрать
 * целиком (обрезан источником или битый), не отдаётся совсем — маска его не видит (Фокус ревью этапа C, п. 2); вместо
 * тела — заметка. `mimeType` запроса — его Content-Type целиком (у multipart в нём граница).
 */
function bodyForAgent(text: string | null, mimeType: string | null, which: 'request' | 'response', notes: string[]): string | null {
  if (text === null || text === '') return null;
  if (unmaskableJson(text, mimeType)) {
    notes.push(`The ${which} body is JSON that cannot be parsed in full (cut by the capture limit or malformed), so it is not shown: it cannot be masked.`);
    return null;
  }
  return redactBody(text, mimeType, AGENT_LIMITS.detailBody);
}

/** Размер снимка агента: совпал с пресетом в любой ориентации — пресет, иначе Custom; DPR 1 — PNG в CSS-пикселях. */
export function captureSpec(width: number, height: number): ViewportSpec {
  for (const [preset, size] of Object.entries(VIEWPORT_PRESETS) as Array<[ViewportPreset, { width: number; height: number }]>) {
    if (size.width === width && size.height === height) return { preset, rotated: false, dpr: 1 };
    if (size.width === height && size.height === width) return { preset, rotated: true, dpr: 1 };
  }
  return { width, height, mobile: false, dpr: 1 };
}

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Длина заголовка страницы в `tabs`. */
const TITLE_LIMIT = 200;

/** Пояснение агенту, когда окно о работе ничего не сообщало: пустой список здесь не значит «страниц нет». */
const UNKNOWN_WORK_NOTE =
  "Parley's window has not reported any browser pages for this workspace. If the human has not opened this workspace in Parley's window yet, its pages are not known; a page you open with browser_open will appear here.";

/** Адрес, который агент может открыть: http(s) на loopback, без учётных данных; иначе `null`. Фрагмент (#…) остаётся: им бывают маршруты SPA. */
export function loopbackHref(raw: string): string | null {
  if (!isLoopbackUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * Хозяин для `open` (спека 5.1): с `room` — браузер этой комнаты, если она в `owners`; с `own` — браузер чата сессии;
 * без обоих — браузер комнаты, когда сессия участник ровно одной, иначе браузер чата. `own` вместе с `room` схема
 * протокола отвергает раньше, здесь это тоже `bad_request`: проверка у каждой стороны своя.
 */
export function ownerOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): BrowserOwner {
  if (args.own === true && args.room !== undefined) throw new AgentOpError('bad_request', 'Pass either own or room, not both.');
  const rooms = request.owners.flatMap((owner) => (owner.kind === 'room' ? [owner.roomId] : []));
  const own = { kind: 'session', sessionId: request.ref.sessionId } as const;
  if (!request.owners.some((owner) => owner.kind === 'session' && owner.sessionId === own.sessionId)) {
    throw new AgentOpError('access_denied', 'This session has no browser of its own right now.');
  }
  if (args.room !== undefined) {
    if (!rooms.includes(args.room)) {
      throw new AgentOpError('access_denied', `You are not a member of room ${args.room}, so you cannot use its browser. Use own: true for the browser of your own chat.`);
    }
    return { kind: 'room', roomId: args.room };
  }
  if (args.own === true) return own;
  const [only] = rooms;
  return rooms.length === 1 && only !== undefined ? { kind: 'room', roomId: only } : own;
}

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  const openMs = deps.openMs ?? AGENT_LIMITS.openMs;
  /** Ждущие ответа окна: id просьбы → продолжение. */
  const pendingOpens = new Map<string, (result: AgentOpenTabResult | 'no_window' | 'timeout') => void>();
  /** id агента по работе и вкладке; счёт — свой у каждой работы. */
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();

  function agentIdFor(workKey: string, tabId: string): string {
    const key = `${workKey}\n${tabId}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const next = (counters.get(workKey) ?? 0) + 1;
    counters.set(workKey, next);
    const id = `t${next}`;
    ids.set(key, id);
    return id;
  }

  interface PageRecord {
    agentId: string;
    webContentsId: number | null;
    workKey: string;
    owner: BrowserOwner;
    pageId: string;
    visible: boolean;
    lastUrl: string;
    lastTitle: string;
  }
  /** Страницы панелей: ключ — работа и страница (`bp-…` уникален на окно, но счёт `agentIdFor` — на работу). */
  const pages = new Map<string, PageRecord>();
  /** Приостановленные панели: работа и хозяин. */
  const paused = new Set<string>();
  const pageKey = (workKey: string, pageId: string): string => `${workKey}\n${pageId}`;
  const ownerId = (owner: BrowserAgentOwner | BrowserOwner): string => (owner.kind === 'session' ? `session:${owner.sessionId}` : `room:${owner.roomId}`);
  const panelKey = (workKey: string, owner: BrowserOwner): string => `${workKey}\n${ownerId(owner)}`;
  const entitled = (request: BrowserAgentOpEvent, record: PageRecord): boolean => request.owners.some((owner) => ownerId(owner) === ownerId(record.owner));
  const isPaused = (record: PageRecord): boolean => paused.has(panelKey(record.workKey, record.owner));

  function live(record: PageRecord): WebContents | null {
    if (record.webContentsId === null) return null;
    const contents = deps.fromId(record.webContentsId);
    return contents === null || contents.isDestroyed() ? null : contents;
  }

  /** Страница своей работы по id агента и проверки доступа (спека 5.2); дальше проверки состояния — задачи 11–12. */
  function pageOf(request: BrowserAgentOpEvent, agentId: string): PageRecord {
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const record = [...pages.values()].find((candidate) => candidate.workKey === workKey && candidate.agentId === agentId);
    if (record === undefined) throw new AgentOpError('no_tab', `There is no page ${agentId} in your browsers: call browser_tabs.`);
    if (!entitled(request, record)) throw new AgentOpError('access_denied', `You have no access to page ${agentId}: it belongs to a browser panel that is not your chat's or your rooms'.`);
    if (isPaused(record)) throw new AgentOpError('access_denied', 'The human paused agents in this browser panel (paused by the human).');
    return record;
  }

  async function viewportOf(id: number): Promise<BrowserAgentTabInfo['viewport']> {
    const spec = deps.emulation.current(id);
    if (spec !== null) {
      const { width, height } = viewportSize(spec);
      return { width, height, emulated: true };
    }
    try {
      const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
      return { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight), emulated: false };
    } catch {
      return null;
    }
  }

  async function listTabs(request: BrowserAgentOpEvent): Promise<{ tabs: BrowserAgentTabInfo[]; notes: string[] }> {
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const mine = [...pages.values()]
      .filter((record) => record.workKey === workKey && entitled(request, record) && !isPaused(record))
      .sort((a, b) => Number(a.agentId.slice(1)) - Number(b.agentId.slice(1)));
    const tabs: BrowserAgentTabInfo[] = [];
    for (const record of mine) {
      const contents = live(record);
      const loaded = contents !== null && !contents.isCrashed();
      if (contents !== null) {
        record.lastUrl = contents.getURL();
        record.lastTitle = contents.getTitle();
      }
      tabs.push({
        id: record.agentId,
        owner: record.owner,
        url: redactUrl(record.lastUrl),
        title: record.lastTitle.slice(0, TITLE_LIMIT),
        viewport: loaded && record.webContentsId !== null ? await viewportOf(record.webContentsId) : null,
        loaded,
        // Невыгруженную, но невидимую страницу человек не видит; незагруженную — тем более.
        visible: loaded && record.visible,
        loopback: isLoopbackUrl(record.lastUrl),
      });
    }
    // Работа известна реестру, если о ней приходила хоть одна запись (страница или пауза); иначе пустой список — не «страниц нет».
    const known = [...pages.values()].some((record) => record.workKey === workKey) || [...paused].some((key) => key.startsWith(`${workKey}\n`));
    return { tabs, notes: tabs.length === 0 && !known ? [UNKNOWN_WORK_NOTE] : [] };
  }

  const opTimeoutMs = deps.opTimeoutMs ?? AGENT_LIMITS.opMs - 2_000;
  /** Хвост очереди каждой страницы: операции к одной странице — строго по одной (спека 3.7). */
  const queues = new Map<string, Promise<void>>();

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = next.then(() => undefined, () => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  /** Страница по id агента: доступ (`pageOf`), состояние гостя, loopback; затем операция в очереди страницы. */
  async function onPage<T>(request: BrowserAgentOpEvent, agentId: string, run: (contents: WebContents, record: PageRecord) => Promise<T>): Promise<T> {
    const record = pageOf(request, agentId);
    const contents = live(record);
    if (contents === null) throw new AgentOpError('tab_not_loaded', `Page ${agentId} is not loaded: its panel or workspace is not open in the window.`);
    if (contents.isCrashed()) throw new AgentOpError('tab_not_loaded', `The page ${agentId} crashed.`);
    if (!isLoopbackUrl(contents.getURL())) throw new AgentOpError('not_loopback', `Page ${agentId} is not on localhost.`);
    return enqueue(pageKey(record.workKey, record.pageId), async () => {
      deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'start' });
      try {
        return await withTimeout(run(contents, record), opTimeoutMs, `The ${request.op} operation took longer than ${Math.round(opTimeoutMs / 1000)} s.`);
      } finally {
        deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'end' });
      }
    });
  }

  function captured(id: number): DevtoolsSnapshot {
    const snapshot = deps.inspector.snapshot(id);
    if (snapshot === null || snapshot.capture === 'unavailable') {
      throw new AgentOpError('unsupported', 'Console and network capture is unavailable for this page: ask the human to reload it.');
    }
    return snapshot;
  }

  function consoleOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'console'>): BrowserAgentConsoleResult {
    const snapshot = captured(contents.id);
    const level = args.level ?? 'error';
    const pattern = args.pattern?.toLowerCase();
    const matching = snapshot.console.filter(
      (entry) =>
        entry.epoch === snapshot.epoch &&
        (level === 'all' || entry.level === 'error' || (level === 'warning' && entry.level === 'warning')) &&
        (pattern === undefined || entry.text.toLowerCase().includes(pattern)),
    );
    return { tab: record.agentId, url: redactUrl(contents.getURL()), entries: newest(matching.map(toAgentConsole), args.limit ?? DEFAULT_LIST), matched: matching.length };
  }

  async function detailOf(id: number, entry: NetworkEntry): Promise<BrowserAgentRequestDetail> {
    const notes: string[] = [];
    if (entry.hasPostData && entry.postData === null) notes.push('The request body was not captured.');
    const requestBody = bodyForAgent(entry.postData, headerValue(entry.requestHeaders, 'content-type'), 'request', notes);
    // Тело целиком, до предела панели: маска разбирает весь JSON, режется уже результат.
    const response = await deps.inspector.responseBody(id, entry.id, DEVTOOLS_LIMITS.panelBody).catch(() => null);
    let responseBody: string | null = null;
    if (response !== null) {
      if (response.base64) notes.push('The response body is binary and is not shown.');
      else responseBody = bodyForAgent(response.text, entry.mimeType, 'response', notes);
    }
    return { ...summaryOf(entry), remoteAddress: entry.remoteAddress, fromCache: entry.fromCache, requestHeaders: redactHeaders(entry.requestHeaders), responseHeaders: redactHeaders(entry.responseHeaders), requestBody, responseBody, notes };
  }

  async function networkOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'network'>): Promise<BrowserAgentNetworkResult> {
    const snapshot = captured(contents.id);
    const url = redactUrl(contents.getURL());
    if (args.requestId !== undefined) {
      const entry = snapshot.network.find((candidate) => candidate.id === args.requestId);
      if (entry === undefined) throw new AgentOpError('bad_request', `There is no request ${args.requestId} in the log of page ${record.agentId}: list the requests first.`);
      return { tab: record.agentId, url, request: await detailOf(contents.id, entry) };
    }
    const pattern = args.urlPattern?.toLowerCase();
    // Фильтр смотрит на адрес с маской: подобрать им значение секрета нельзя.
    const matching = snapshot.network.filter(
      (entry) =>
        entry.epoch === snapshot.epoch &&
        (args.failedOnly !== false ? isFailed(entry) : true) &&
        (pattern === undefined || redactUrl(entry.url).toLowerCase().includes(pattern)),
    );
    return { tab: record.agentId, url, requests: newest(matching.map(summaryOf), args.limit ?? DEFAULT_LIST), matched: matching.length };
  }

  /** Длинная сторона PNG — не больше `AGENT_LIMITS.screenshotLongSide` (предел картинки, которую модель читает целиком). */
  function fitLongSide(png: Buffer): Buffer {
    const size = deps.image.size(png);
    const long = Math.max(size.width, size.height);
    if (long <= AGENT_LIMITS.screenshotLongSide) return png;
    const scale = AGENT_LIMITS.screenshotLongSide / long;
    return deps.image.resize(png, Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
  }

  async function screenshotOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'screenshot'>): Promise<BrowserAgentScreenshotResult> {
    const id = contents.id;
    const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
    const current = { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight) };
    const spec = args.width === undefined && args.height === undefined ? null : captureSpec(args.width ?? current.width, args.height ?? current.height);
    const view = spec === null ? current : (({ width, height }) => ({ width, height }))(viewportSize(spec));

    const shoot = async (clip?: { x: number; y: number; width: number; height: number; scale: number }): Promise<Buffer> => {
      const params = clip === undefined ? { format: 'png' } : { format: 'png', clip, captureBeyondViewport: true };
      const shot = await deps.inspector.send<{ data: string }>(id, 'Page.captureScreenshot', params);
      return Buffer.from(shot.data, 'base64');
    };

    const capture = async (): Promise<{ png: Buffer; viewport: { width: number; height: number } }> => {
      if (args.fullPage !== true) return { png: await shoot(), viewport: view };
      // Высота страницы — уже при нужном размере (под временной эмуляцией вёрстка другая).
      const page = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
      const total = Math.max(view.height, Math.ceil(page.cssContentSize.height));
      if (total > view.height * AGENT_LIMITS.fullPageViewports) {
        throw new AgentOpError(
          'bad_request',
          `The page is ${total} px tall, more than ${AGENT_LIMITS.fullPageViewports} viewport heights (${view.height} px): take viewport screenshots of parts of the page instead.`,
        );
      }
      const width = Math.max(view.width, Math.ceil(page.cssContentSize.width));
      const strips: Buffer[] = [];
      // Полоса выше поверхности вида рисуется повтором (спайк 0.7): режем по высоте вьюпорта и склеиваем.
      for (let y = 0; y < total; y += view.height) strips.push(await shoot({ x: 0, y, width, height: Math.min(view.height, total - y), scale: 1 }));
      return { png: strips.length === 1 ? (strips[0] as Buffer) : deps.image.stitch(strips), viewport: { width, height: total } };
    };

    // Невидимой странице поверхность переводят в opacity: 0 (спайк 0.2); смене размера нужна ещё и подпись «Agent capture W×H».
    if (spec !== null || !record.visible) deps.activity({ webContentsId: id, session: request.label, op: request.op, phase: 'start', capture: view });
    const taken = spec === null ? await capture() : await deps.emulation.withTemporary(id, spec, capture);
    const png = fitLongSide(taken.png);
    const size = deps.image.size(png);
    const saved = await deps.saveImage(png);
    if (saved === null) throw new AgentOpError('unsupported', 'The screenshot could not be saved to Parley drops.');
    return {
      tab: record.agentId,
      url: redactUrl(contents.getURL()),
      path: saved,
      width: size.width,
      height: size.height,
      viewport: taken.viewport,
      fullPage: args.fullPage === true,
      emulated: spec !== null || deps.emulation.current(id) !== null,
    };
  }

  function askWindow(event: AgentOpenTab): Promise<AgentOpenTabResult | 'no_window' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (result: AgentOpenTabResult | 'no_window' | 'timeout'): void => {
        clearTimeout(timer);
        pendingOpens.delete(event.requestId);
        resolve(result);
      };
      const timer = setTimeout(() => done('timeout'), openMs);
      pendingOpens.set(event.requestId, done);
      let sent = false;
      try {
        sent = deps.openTab(event);
      } catch {
        // Окно закрыто посреди вызова — как будто его нет.
      }
      if (!sent) done('no_window');
    });
  }

  async function openOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): Promise<BrowserAgentOpenResult> {
    const url = loopbackHref(args.url);
    if (url === null) {
      throw new AgentOpError('not_loopback', 'Only http(s) pages on localhost can be opened: pass an absolute URL such as http://localhost:5173/.');
    }
    const owner = ownerOf(request, args);
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const answer = await askWindow({ requestId: randomUUID(), workKey, url, sessionId: request.ref.sessionId, session: request.label, owner });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not place the tab within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      throw answer.error === 'limit'
        ? new AgentOpError('bad_request', `This browser panel already has ${AGENT_LIMITS.panelPages} pages, the most Parley allows. Ask the human to close one.`)
        : new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    return { tab: agentIdFor(workKey, answer.tabId), owner, url, reused: answer.reused, notes: answer.mounted ? [] : [NOT_MOUNTED_NOTE] };
  }

  return {
    async run(request) {
      const schema = ARGS[request.op];
      if (schema === undefined) {
        return failure('unsupported', `This window does not know the operation ${String(request.op)}: ask the human to restart Parley.`);
      }
      const parsed = schema.safeParse(request.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.map(String).join('.');
        return failure('bad_request', `Invalid arguments for ${request.op}: ${where} — ${issue?.message ?? 'invalid'}.`);
      }
      if (!(await deps.agentsAllowed())) {
        return failure('access_denied', 'The human turned off agent access to the browser (Settings → Browser → Let agents use the browser).');
      }
      try {
        switch (request.op) {
          case 'open':
            return ok(await openOf(request, parsed.data as BrowserAgentArgs<'open'>));
          case 'tabs':
            return ok(await listTabs(request));
          case 'console': {
            const args = parsed.data as BrowserAgentArgs<'console'>;
            return ok(await onPage(request, args.tab, async (contents, record) => consoleOf(contents, record, args)));
          }
          case 'network': {
            const args = parsed.data as BrowserAgentArgs<'network'>;
            return ok(await onPage(request, args.tab, (contents, record) => networkOf(contents, record, args)));
          }
          case 'screenshot': {
            const args = parsed.data as BrowserAgentArgs<'screenshot'>;
            return ok(await onPage(request, args.tab, (contents, record) => screenshotOf(contents, record, request, args)));
          }
        }
      } catch (error) {
        if (error instanceof AgentOpError) return failure(error.code, error.message);
        return failure('unsupported', error instanceof Error ? error.message : String(error));
      }
    },
    openTabResult(requestId, result) {
      pendingOpens.get(requestId)?.(result);
    },
    registerTab(e) {
      if ('gone' in e) {
        pages.delete(pageKey(e.workKey, e.pageId));
        return;
      }
      if ('paused' in e) {
        if (e.paused) paused.add(panelKey(e.workKey, e.owner));
        else paused.delete(panelKey(e.workKey, e.owner));
        return;
      }
      const key = pageKey(e.workKey, e.pageId);
      const previous = pages.get(key);
      const contents = e.webContentsId === null ? null : deps.fromId(e.webContentsId);
      pages.set(key, {
        agentId: agentIdFor(e.workKey, e.pageId),
        webContentsId: e.webContentsId,
        workKey: e.workKey,
        owner: e.owner,
        pageId: e.pageId,
        visible: e.visible,
        lastUrl: contents?.getURL() ?? previous?.lastUrl ?? '',
        lastTitle: contents?.getTitle() ?? previous?.lastTitle ?? '',
      });
    },
    reset() {
      pages.clear();
      paused.clear();
    },
  };
}
