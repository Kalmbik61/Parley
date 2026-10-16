import { z } from 'zod';
import type { SessionRef } from './types.js';

/**
 * Канал агента к встроенному браузеру окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1; этап B2):
 * MCP-сервер сессии → `POST /agent/browser` хоста → событие `browser.agentOp` окну с возможностью `browser-agent` →
 * main окна исполняет → метод `browser.agentResult`. Схему аргументов проверяет хост до окна, main окна — у себя: ни
 * одна сторона не верит другой. Этап B2 даёт скелет и одну операцию, `open`; этапы C и D дописывают остальные.
 *
 * Core держит свою копию операций и пределов (`core/src/mcp/browser-tools.ts`): протокол зависит от core, обратного
 * импорта нет. Совпадение сверяет тест хоста `agent/browser-contract.test.ts`.
 */

/** Возможность окна в `hello.features`: оно исполняет операции агента над своим браузером. */
export const BROWSER_AGENT_FEATURE = 'browser-agent';

/**
 * Операции канала — по инструменту `browser_<op>` на каждую. Список растёт по этапам (порядок — индекс плана):
 * C ставит свои четыре чтения перед `open`, D дописывает управление после.
 */
export const BROWSER_AGENT_OPS = ['tabs', 'console', 'network', 'screenshot', 'open'] as const;
export type BrowserAgentOp = (typeof BROWSER_AGENT_OPS)[number];

/** Возможность окна «исполняю операцию `<op>`» в `hello.features`: окно старой сборки заявляет `browser-agent`, но не знает новых операций. */
export const BROWSER_AGENT_OP_FEATURE = (op: BrowserAgentOp): string => `${BROWSER_AGENT_FEATURE}:${op}`;

/** Коды отказов (спека 5.1). B2 отдал шесть, C добавил `no_tab`, `tab_hidden`, `tab_not_loaded`; остальные коды спеки добавляет D. */
export const BROWSER_AGENT_ERROR_CODES = [
  'not_loopback',
  'access_denied',
  'window_not_connected',
  'timeout',
  'unsupported',
  'bad_request',
  'no_tab',
  'tab_hidden',
  'tab_not_loaded',
] as const;
export type BrowserAgentErrorCode = (typeof BROWSER_AGENT_ERROR_CODES)[number];

/**
 * Пределы канала (спека, раздел 8). `opMs` — срок ответа окна хосту; `openMs` — сколько main ждёт, пока окно поставит
 * вкладку и ответит (вкладка встаёт за кадр, дольше — окно перезагружается или не слушает); `requestBytes` — тело
 * запроса агента. Остальное — пределы чтения (этап C): `listStackFrames` — сколько своих кадров стека в записи консоли; `listEntryText` — текст записи консоли в кодовых точках; `listBytes` и
 * `listEntries` — размер и число записей списка; `detailBody` — тело запроса или ответа в деталях; `headerValue`, `headers` — длина значения и число заголовков на сторону в деталях; `listQuery` — сколько знаков адреса после `?` в списке сети; `screenshotLongSide`
 * и `fullPageViewports` — размер снимка; `panelPages` — предел страниц панели (источник правды — `PANEL_LIMITS.pages`
 * окна, равенство сверяет тест окна); `captureReadyMs` — сколько main ждёт, пока окно поставит `<webview>` в размер снимка
 * и подтвердит это; `captureRetries` — повторы снимка скрытой страницы после подтверждения; `screenshotBytes` — предел PNG снимка (больше — повтор в меньшем масштабе); `metricsMs` — срок, за который `tabs` ждёт размер вьюпорта страницы (дольше — `viewport: null`).
 */
export const AGENT_LIMITS = {
  opMs: 30_000,
  openMs: 10_000,
  requestBytes: 65_536,
  listBytes: 20_480,
  listEntries: 100,
  detailBody: 8192,
  headerValue: 256,
  headers: 40,
  listQuery: 80,
  listStackFrames: 5,
  listEntryText: 1024,
  screenshotLongSide: 1568,
  fullPageViewports: 3,
  panelPages: 5,
  captureReadyMs: 2000,
  captureRetries: 2,
  screenshotBytes: 3_500_000,
  metricsMs: 1500,
} as const;

/** Пределы ввода агента, которых нет в таблице спеки: длина адреса — та же, что у журнала вкладки (`DEVTOOLS_LIMITS.url`); `room` — id комнаты; `pattern` — фильтр консоли и сети; `requestId` — id запроса сети. */
export const AGENT_INPUT = { url: 4096, room: 64, pattern: 200, requestId: 200 } as const;

/** Умолчания необязательных аргументов чтений; MCP core (`browser-tools.ts`) пишет те же числа в схемы, сверяет `browser-agent-contract.test.ts`. */
export const AGENT_DEFAULTS = { limit: 50, level: 'error', failedOnly: true, fullPage: false } as const;

/** Размер снимка агента — те же пределы Custom, что у меню размеров окна (`DEVTOOLS_LIMITS`; сверяет тест окна). */
export const AGENT_VIEWPORT = { min: 200, maxWidth: 3840, maxHeight: 2400 } as const;

/**
 * Хозяин браузера, доступный сессии (спека 3.10): сама сессия или комната её работы. Форма та же, что у `BrowserOwner`
 * окна (`desktop/src/shared/layout-types.ts`); протокол от desktop не зависит, поэтому тип здесь свой.
 */
export type BrowserAgentOwner = { kind: 'session'; sessionId: string } | { kind: 'room'; roomId: string };

/**
 * Событие хоста окну. `label` — короткий номер сессии (`S02`) для тоста окна и журнала. `owners` — хозяева, которыми
 * сессия может пользоваться на момент операции (спека 3.7, 3.10): она сама и комнаты её работы, где она участник.
 */
export interface BrowserAgentOpEvent {
  opId: string;
  ref: SessionRef;
  label: string;
  owners: BrowserAgentOwner[];
  op: BrowserAgentOp;
  args: unknown;
}

export type BrowserAgentResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: BrowserAgentErrorCode; message: string } };

const tab = z.string().regex(/^t\d{1,4}$/);
const pattern = z.string().min(1).max(AGENT_INPUT.pattern);
const limit = z.number().int().min(1).max(AGENT_LIMITS.listEntries);
const side = (max: number) => z.number().int().min(AGENT_VIEWPORT.min).max(max);

/** Схемы аргументов по операциям; хост проверяет до окна, main окна — у себя. */
export const browserAgentArgs = {
  tabs: z.strictObject({}),
  console: z.strictObject({
    tab,
    level: z.enum(['error', 'warning', 'all']).optional(),
    pattern: pattern.optional(),
    limit: limit.optional(),
    after: z.number().int().min(0).optional(),
  }),
  network: z.strictObject({
    tab,
    failedOnly: z.boolean().optional(),
    urlPattern: pattern.optional(),
    limit: limit.optional(),
    requestId: z.string().min(1).max(AGENT_INPUT.requestId).optional(),
    after: z.string().min(1).max(AGENT_INPUT.requestId).optional(),
  }),
  screenshot: z.strictObject({
    tab,
    width: side(AGENT_VIEWPORT.maxWidth).optional(),
    height: side(AGENT_VIEWPORT.maxHeight).optional(),
    fullPage: z.boolean().optional(),
  }),
  // `own` и `room` вместе — отказ (спека 5.1): куда открыть, агент называет одним способом.
  open: z
    .strictObject({
      url: z.string().min(1).max(AGENT_INPUT.url),
      own: z.boolean().optional(),
      room: z.string().min(1).max(AGENT_INPUT.room).optional(),
    })
    .refine((args) => !(args.own === true && args.room !== undefined), { message: 'pass either own or room, not both' }),
} satisfies Record<BrowserAgentOp, z.ZodType>;

export type BrowserAgentArgs<O extends BrowserAgentOp> = z.infer<(typeof browserAgentArgs)[O]>;

/** Тело `POST /agent/browser`. */
export const browserAgentRequest = z.strictObject({ op: z.enum(BROWSER_AGENT_OPS), args: z.unknown().optional() });

const opId = z.string().min(1).max(64);

/** Параметры метода `browser.agentResult` (окно → хост). */
export const browserAgentResultParams = z.union([
  z.strictObject({ opId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    opId,
    ok: z.literal(false),
    // Код — любая строка: окно другой сборки может прислать код, которого хост не знает; хост приводит его к `unsupported`
    // (`browser.agentResult`), а не теряет ответ вместе с операцией. Длинное сообщение хост режет сам.
    error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(10_000) }),
  }),
]);

// ---- Формы ответов окна. Их читает MCP-сервер core своей копией формы (core/src/mcp/browser-tools.ts). ----

/**
 * `open`: вкладка работы, которую назвал агент. `url` — адрес, который прислал сам агент (без учётных данных); адреса
 * страницы, которую показывает вкладка, агент не получает. `reused` — вкладка работы с этой страницей уже была, новая не
 * открыта. `notes` — пояснения Parley.
 */
export interface BrowserAgentOpenResult {
  tab: string;
  /** Чей браузер получил страницу (правило выбора — спека 5.1). */
  owner: BrowserAgentOwner;
  url: string;
  reused: boolean;
  notes: string[];
}

/** Страница панели в ответе `tabs`: URL — с маской секретов, заголовок — до 200 символов. */
export interface BrowserAgentTabInfo {
  id: string;
  /** Чья панель: сам чат агента или комната (спека 5.1). */
  owner: BrowserAgentOwner;
  url: string;
  title: string;
  /** CSS-размер вьюпорта; `emulated` — размер задан эмуляцией; `null` — страница не загружена или размер не узнать. */
  viewport: { width: number; height: number; emulated: boolean } | null;
  loaded: boolean;
  visible: boolean;
  loopback: boolean;
}
export interface BrowserAgentTabsResult {
  tabs: BrowserAgentTabInfo[];
  /** Пояснения Parley; пока список пуст, а окно о работе ничего не знает, — почему (задача 10). */
  notes: string[];
}

export interface BrowserAgentConsoleEntry {
  /** Номер записи в журнале страницы: значение `after` для следующего чтения. */
  id: number;
  level: 'error' | 'warning' | 'info' | 'debug';
  origin: 'console' | 'exception' | 'network' | 'browser';
  text: string;
  /** `url:строка:столбец` источника с маской URL; `null` — источника нет. */
  source: string | null;
  /** Кадры стека: `fn (url:строка:столбец)`. */
  stack: string[];
  /** Сколько раз повторилось сообщение (у свёртки похожих — сумма по группе). */
  count: number;
  /** Свёртка похожих (тексты различаются числами): размер группы; поля нет — запись одна. Остаётся новейшая. */
  similar?: number;
  /** ISO-время записи. */
  at: string;
}
export interface BrowserAgentConsoleResult {
  tab: string;
  url: string;
  /** Новейшие подходящие записи в пределах `listEntries` и `listBytes`, старые — первыми. */
  entries: BrowserAgentConsoleEntry[];
  /** Сколько записей текущей страницы подошло под фильтр (до свёртки похожих). */
  matched: number;
  /** Наибольший id среди подходящих записей — значение `after` для следующего чтения; `null` — подходящих нет. */
  next: number | null;
}

export interface BrowserAgentRequestSummary {
  id: string;
  method: string;
  url: string;
  kind: string;
  status: number | null;
  statusText: string;
  failure: { reason: 'net' | 'cors' | 'blocked' | 'canceled'; text: string } | null;
  durationMs: number | null;
  mimeType: string | null;
}
export interface BrowserAgentRequestDetail extends BrowserAgentRequestSummary {
  remoteAddress: string | null;
  fromCache: boolean;
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  /** Тела после маски, не длиннее `AGENT_LIMITS.detailBody`; `null` — тела нет или его нельзя отдать (причина — в `notes`). */
  requestBody: string | null;
  responseBody: string | null;
  notes: string[];
}
export type BrowserAgentNetworkResult =
  | {
      tab: string;
      url: string;
      requests: BrowserAgentRequestSummary[];
      matched: number;
      /** Пояснения Parley: например, названный `after` уже вытеснен из журнала. */
      notes: string[];
      /** id последнего запроса в списке — значение `after` для следующего чтения; `null` — список пуст. */
      next: string | null;
    }
  | { tab: string; url: string; request: BrowserAgentRequestDetail };

export interface BrowserAgentScreenshotResult {
  tab: string;
  url: string;
  /** PNG в `~/.parley/desktop/drops`. */
  path: string;
  /** Пиксели PNG. */
  width: number;
  height: number;
  /** CSS-размер снятой области. */
  viewport: { width: number; height: number };
  fullPage: boolean;
  emulated: boolean;
  /** Пояснения Parley: например, `fullPage` шире предела обрезан. Нет поля — пояснений нет. */
  notes?: string[];
}
