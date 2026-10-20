import { z } from 'zod';
import type { SessionRef } from './types.js';

/**
 * Этапы C и D: чтение и управление; JS агента, куки и хранилище, файлы — решение владельца 2026-10-20.
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
export const BROWSER_AGENT_OPS = [
  'tabs',
  'console',
  'network',
  'screenshot',
  'open',
  'navigate',
  'snapshot',
  'action',
  'wait_for',
  'resize',
  'evaluate',
  'cookies',
  'storage',
  'downloads',
] as const;
export type BrowserAgentOp = (typeof BROWSER_AGENT_OPS)[number];

/** Возможность окна «исполняю операцию `<op>`» в `hello.features`: окно старой сборки заявляет `browser-agent`, но не знает новых операций. */
export const BROWSER_AGENT_OP_FEATURE = (op: BrowserAgentOp): string => `${BROWSER_AGENT_FEATURE}:${op}`;

/**
 * Коды отказов (спека 5.1). B2 отдал шесть, C добавил `no_tab`, `tab_hidden`, `tab_not_loaded`, D — `human_busy` и `stale_ref`.
 * `not_loopback` оставлен для окон до D: окно D его не отдаёт.
 */
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
  'human_busy',
  'stale_ref',
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
  // ---- этап D ----
  /** Ожидание загрузки `open`, `navigate` и действия с переходом. */
  loadMs: 15_000,
  /** Предел `wait_for`. */
  waitMs: 10_000,
  /** Текст `type`, выражение и функция `evaluate`, значение `storage set`. */
  text: 10_000,
  /** Ответ `snapshot`. */
  snapshotBytes: 51_200,
  /** Окно операции агента после её конца; столько же держится значок. */
  guardTailMs: 2_000,
  /** Сколько ждать начала перехода после действия. */
  settleMs: 300,
  /** Шаг опроса `wait_for` (полное дерево доступности), регистрации страницы `open` и размера `resize`. */
  pollMs: 500,
  /** Сколько ждать, пока окно поставит размер от агента. */
  resizeMs: 2_000,
  /** Точка клика (спека 4.8). */
  clickDotMs: 600,
  /** Подсказка значка — последние операции. */
  badgeOps: 5,
  /** Ввод агента ждёт столько тишины клавиатуры человека (считает main). */
  typingIdleMs: 1_000,
  /** Сколько ждать тишины клавиатуры и ответа окна на просьбу о фокусе. */
  focusMs: 10_000,
  /** Предел скрипта агента (один главный таймер). */
  evalMs: 10_000,
  /** Ответ `evaluate`. */
  evalBytes: 20_480,
  /** Значение `storage get`. */
  storageValue: 8192,
  /** Файлов в одной загрузке. */
  uploadFiles: 10,
  /** Файл загрузки. */
  uploadBytes: 104_857_600,
  /** Файл скачивания. */
  downloadBytes: 209_715_200,
  /** Скачиваний сессии в списке. */
  downloads: 20,
  /** Срок хранения скачанного, суток. */
  downloadDays: 7,
} as const;

/**
 * Пределы ввода агента, которых нет в таблице спеки: длина адреса — та же, что у журнала вкладки (`DEVTOOLS_LIMITS.url`); `room` — id комнаты;
 * `pattern` — фильтр консоли и сети; `requestId` — id запроса сети; `key` — имя клавиши; `scroll` — прокрутка; `option` — значение `select`;
 * `path` — путь файла загрузки; `cookieName`, `cookieValue` — имя и значение куки; `storageKey` — ключ хранилища.
 */
export const AGENT_INPUT = {
  url: 4096,
  room: 64,
  pattern: 200,
  requestId: 200,
  key: 32,
  scroll: 10_000,
  option: 1024,
  path: 4096,
  cookieName: 256,
  cookieValue: 4096,
  storageKey: 1024,
} as const;

/** Умолчания необязательных аргументов чтений; MCP core (`browser-tools.ts`) пишет те же числа в схемы, сверяет `browser-agent-contract.test.ts`. */
export const AGENT_DEFAULTS = { limit: 50, level: 'error', failedOnly: true, fullPage: false, interactiveOnly: false, values: false } as const;

/** Размер снимка агента — те же пределы Custom, что у меню размеров окна (`DEVTOOLS_LIMITS`; сверяет тест окна). */
export const AGENT_VIEWPORT = { min: 200, maxWidth: 3840, maxHeight: 2400 } as const;

/** Пресеты `browser_resize` — имена меню размеров окна (`VIEWPORT_PRESETS`; сверяет тест окна `shared/agent-limits.test.ts`). */
export const AGENT_VIEWPORT_PRESETS = ['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop'] as const;

/** Действия `browser_action` (спека 5.1). */
export const AGENT_ACTIONS = ['click', 'double_click', 'hover', 'type', 'press', 'scroll', 'select', 'check', 'uncheck', 'drag', 'upload'] as const;
export type BrowserAgentAction = (typeof AGENT_ACTIONS)[number];

/** Модификаторы клавиш и кликов агента. */
export const AGENT_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
export type BrowserAgentModifier = (typeof AGENT_MODIFIERS)[number];

/** Действия `browser_cookies` и `browser_storage`. */
export const AGENT_COOKIE_ACTIONS = ['list', 'set', 'delete'] as const;
export const AGENT_STORAGE_ACTIONS = ['list', 'get', 'set', 'delete', 'clear'] as const;

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
const ref = z.string().regex(/^e\d{1,6}$/);
const url = z.string().min(1).max(AGENT_INPUT.url);
const absolutePath = z.string().min(1).max(AGENT_INPUT.path).regex(/^\//);
const coordinate = (max: number) => z.number().min(0).max(max);
/** Ровно одно из значений задано. */
const exactlyOne = (values: readonly unknown[]): boolean => values.filter((value) => value !== undefined).length === 1;
/** Действия с целью на странице: ref или точка. */
const TARGET_ACTIONS: ReadonlySet<string> = new Set(['click', 'double_click', 'hover', 'drag']);

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
  screenshot: z
    .strictObject({
      tab,
      width: side(AGENT_VIEWPORT.maxWidth).optional(),
      height: side(AGENT_VIEWPORT.maxHeight).optional(),
      fullPage: z.boolean().optional(),
      ref: ref.optional(),
    })
    .refine((args) => !(args.ref !== undefined && args.fullPage === true), { message: 'Pass ref or fullPage, not both.' }),
  // `own` и `room` вместе — отказ (спека 5.1): куда открыть, агент называет одним способом.
  open: z
    .strictObject({
      url: z.string().min(1).max(AGENT_INPUT.url),
      own: z.boolean().optional(),
      room: z.string().min(1).max(AGENT_INPUT.room).optional(),
    })
    .refine((args) => !(args.own === true && args.room !== undefined), { message: 'pass either own or room, not both' }),
  navigate: z
    .strictObject({
      tab,
      url: url.optional(),
      back: z.literal(true).optional(),
      forward: z.literal(true).optional(),
      reload: z.literal(true).optional(),
      hard: z.boolean().optional(),
    })
    .refine((args) => exactlyOne([args.url, args.back, args.forward, args.reload]), { message: 'Pass exactly one of url, back, forward or reload.' })
    .refine((args) => args.hard === undefined || args.reload === true, { message: 'hard goes only with reload.' }),
  snapshot: z.strictObject({ tab, interactiveOnly: z.boolean().optional() }),
  action: z
    .strictObject({
      tab,
      action: z.enum(AGENT_ACTIONS),
      ref: ref.optional(),
      x: coordinate(AGENT_VIEWPORT.maxWidth).optional(),
      y: coordinate(AGENT_VIEWPORT.maxHeight).optional(),
      text: z.string().min(1).max(AGENT_LIMITS.text).optional(),
      key: z.string().min(1).max(AGENT_INPUT.key).optional(),
      modifiers: z.array(z.enum(AGENT_MODIFIERS)).max(AGENT_MODIFIERS.length).optional(),
      submit: z.boolean().optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      amount: z.number().int().min(1).max(AGENT_INPUT.scroll).optional(),
      value: z.string().min(1).max(AGENT_INPUT.option).optional(),
      toRef: ref.optional(),
      toX: coordinate(AGENT_VIEWPORT.maxWidth).optional(),
      toY: coordinate(AGENT_VIEWPORT.maxHeight).optional(),
      files: z.array(absolutePath).min(1).max(AGENT_LIMITS.uploadFiles).optional(),
    })
    .refine((args) => (args.x === undefined) === (args.y === undefined), { message: 'Pass x and y together.' })
    .refine((args) => (args.toX === undefined) === (args.toY === undefined), { message: 'Pass toX and toY together.' })
    .refine((args) => !(args.ref !== undefined && args.x !== undefined), { message: 'Pass ref or x and y, not both.' })
    .refine((args) => !TARGET_ACTIONS.has(args.action) || args.ref !== undefined || args.x !== undefined, {
      message: 'click, double_click, hover and drag need ref, or x and y.',
    })
    .refine((args) => args.action !== 'drag' || args.toRef !== undefined || args.toX !== undefined, { message: 'drag needs toRef, or toX and toY.' })
    .refine((args) => args.action !== 'type' || args.text !== undefined, { message: 'type needs text.' })
    .refine((args) => args.action !== 'press' || args.key !== undefined, { message: 'press needs key.' })
    .refine((args) => args.action !== 'scroll' || args.direction !== undefined, { message: 'scroll needs direction.' })
    .refine((args) => args.action !== 'select' || (args.ref !== undefined && args.value !== undefined), { message: 'select needs ref and value.' })
    .refine((args) => !['check', 'uncheck', 'upload'].includes(args.action) || args.ref !== undefined, { message: 'check, uncheck and upload need ref.' })
    .refine((args) => args.action !== 'upload' || args.files !== undefined, { message: 'upload needs files.' })
    .refine((args) => args.files === undefined || args.action === 'upload', { message: 'files go only with upload.' }),
  wait_for: z
    .strictObject({
      tab,
      text: pattern.optional(),
      gone: pattern.optional(),
      ms: z.number().int().min(1).max(AGENT_LIMITS.waitMs).optional(),
    })
    .refine((args) => exactlyOne([args.text, args.gone, args.ms]), { message: 'Pass exactly one of text, gone or ms.' }),
  resize: z
    .strictObject({
      tab,
      preset: z.enum(AGENT_VIEWPORT_PRESETS).optional(),
      rotated: z.boolean().optional(),
      width: side(AGENT_VIEWPORT.maxWidth).optional(),
      height: side(AGENT_VIEWPORT.maxHeight).optional(),
      fit: z.literal(true).optional(),
    })
    .refine((args) => (args.width === undefined) === (args.height === undefined), { message: 'Pass width and height together.' })
    .refine((args) => exactlyOne([args.preset, args.width, args.fit]), { message: 'Pass exactly one of preset, width and height, or fit.' })
    .refine((args) => args.rotated === undefined || args.preset !== undefined, { message: 'rotated goes only with preset.' }),
  evaluate: z
    .strictObject({
      tab,
      expression: z.string().min(1).max(AGENT_LIMITS.text).optional(),
      function: z.string().min(1).max(AGENT_LIMITS.text).optional(),
      ref: ref.optional(),
    })
    .refine((args) => exactlyOne([args.expression, args.function]), { message: 'Pass exactly one of expression or function.' })
    .refine((args) => args.ref === undefined || args.function !== undefined, { message: 'ref goes only with function.' }),
  // Адреса и домена нет: куки берутся только у страницы агента (адрес — `contents.getURL()` в main).
  cookies: z
    .strictObject({
      tab,
      action: z.enum(AGENT_COOKIE_ACTIONS),
      name: z.string().min(1).max(AGENT_INPUT.cookieName).optional(),
      value: z.string().max(AGENT_INPUT.cookieValue).optional(),
      path: z.string().max(AGENT_INPUT.url).regex(/^\//).optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(['lax', 'strict', 'no_restriction']).optional(),
      expires: z.number().int().min(0).optional(),
      values: z.boolean().optional(),
    })
    .refine((args) => args.action !== 'set' || (args.name !== undefined && args.value !== undefined), { message: 'set needs name and value.' })
    .refine((args) => args.action !== 'delete' || args.name !== undefined, { message: 'delete needs name.' })
    .refine((args) => args.values === undefined || args.action === 'list', { message: 'values goes only with list.' })
    .refine(
      (args) => args.action === 'set' || [args.path, args.secure, args.httpOnly, args.sameSite, args.expires].every((v) => v === undefined),
      { message: 'path, secure, httpOnly, sameSite and expires go only with set.' },
    ),
  storage: z
    .strictObject({
      tab,
      area: z.enum(['local', 'session']),
      action: z.enum(AGENT_STORAGE_ACTIONS),
      key: z.string().min(1).max(AGENT_INPUT.storageKey).optional(),
      value: z.string().max(AGENT_LIMITS.text).optional(),
    })
    .refine((args) => !['get', 'set', 'delete'].includes(args.action) || args.key !== undefined, { message: 'get, set and delete need key.' })
    .refine((args) => args.action !== 'set' || args.value !== undefined, { message: 'set needs value.' })
    .refine((args) => !['list', 'clear'].includes(args.action) || (args.key === undefined && args.value === undefined), {
      message: 'list and clear take no key or value.',
    })
    .refine((args) => args.value === undefined || args.action === 'set', { message: 'value goes only with set.' }),
  downloads: z.strictObject({}),
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
  /** Страница загружена к концу ожидания (`AGENT_LIMITS.loadMs`). Нет — окно до этапа D, оно загрузки не ждёт (core так и пишет агенту). */
  loaded?: boolean;
  title?: string;
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

export interface BrowserAgentNavigateResult {
  tab: string;
  url: string;
  title: string;
  loaded: boolean;
  notes: string[];
}

export interface BrowserAgentSnapshotResult {
  tab: string;
  url: string;
  /** Дерево доступности строками `[ref=e12] button "Save"`; данные страницы — ограду ставит MCP-сервер. */
  text: string;
  /** Сколько ссылок `eN` в тексте. */
  refs: number;
  /** Текст обрезан пределом `AGENT_LIMITS.snapshotBytes`. */
  truncated: boolean;
}

export interface BrowserAgentActionResult {
  tab: string;
  /** Адрес после действия (с маской). */
  url: string;
  /** Что сделано — текст Parley, без данных страницы. */
  done: string;
  /** Действие вызвало переход главного фрейма (дождан до `AGENT_LIMITS.loadMs`). */
  navigated: boolean;
  notes: string[];
}

export interface BrowserAgentWaitResult {
  tab: string;
  url: string;
  /** `timeout` — не ошибка: страница не изменилась так, как ждали. */
  outcome: 'found' | 'gone' | 'waited' | 'timeout';
  ms: number;
}

export interface BrowserAgentResizeResult {
  tab: string;
  url: string;
  viewport: { width: number; height: number; emulated: boolean } | null;
}

export interface BrowserAgentEvaluateResult {
  tab: string;
  url: string;
  outcome: 'value' | 'exception';
  /** JSON значения или текст исключения. */
  text: string;
  type: string;
  truncated: boolean;
}

export interface BrowserAgentCookie {
  name: string;
  /** Только при `values: true`; у httpOnly — всегда `<httpOnly: hidden>` (решение владельца 6). */
  value?: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expires: string | null;
  size: number;
}
export type BrowserAgentCookiesResult =
  | { tab: string; url: string; cookies: BrowserAgentCookie[]; notes: string[] }
  | { tab: string; url: string; done: string };

export type BrowserAgentStorageResult =
  | { tab: string; origin: string; area: 'local' | 'session'; entries: Array<{ key: string; value: string; size: number }>; total: number; notes: string[] }
  | { tab: string; origin: string; area: 'local' | 'session'; key: string; value: string | null; truncated: boolean }
  | { tab: string; origin: string; area: 'local' | 'session'; done: string };

export interface BrowserAgentDownload {
  id: string;
  tab: string | null;
  name: string;
  path: string;
  url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number | null;
  startedAt: string;
  note?: string;
}
export interface BrowserAgentDownloadsResult {
  dir: string;
  downloads: BrowserAgentDownload[];
  notes: string[];
}
