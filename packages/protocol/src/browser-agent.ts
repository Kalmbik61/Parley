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
export const BROWSER_AGENT_OPS = ['open'] as const;
export type BrowserAgentOp = (typeof BROWSER_AGENT_OPS)[number];

/** Коды отказов (спека 5.1). B2 отдаёт эти шесть; остальные коды спеки добавляют этапы C и D. */
export const BROWSER_AGENT_ERROR_CODES = [
  'not_loopback',
  'access_denied',
  'window_not_connected',
  'timeout',
  'unsupported',
  'bad_request',
] as const;
export type BrowserAgentErrorCode = (typeof BROWSER_AGENT_ERROR_CODES)[number];

/**
 * Пределы канала (спека, раздел 8). `opMs` — срок ответа окна хосту; `openMs` — сколько main ждёт, пока окно поставит
 * вкладку и ответит (вкладка встаёт за кадр, дольше — окно перезагружается или не слушает); `requestBytes` — тело
 * запроса агента.
 */
export const AGENT_LIMITS = {
  opMs: 30_000,
  openMs: 10_000,
  requestBytes: 65_536,
} as const;

/** Пределы ввода агента, которых нет в таблице спеки: длина адреса — та же, что у журнала вкладки (`DEVTOOLS_LIMITS.url`); `room` — id комнаты. */
export const AGENT_INPUT = { url: 4096, room: 64 } as const;

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

/** Схемы аргументов по операциям; хост проверяет до окна, main окна — у себя. */
export const browserAgentArgs = {
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
    error: z.strictObject({ code: z.enum(BROWSER_AGENT_ERROR_CODES), message: z.string().max(2000) }),
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
