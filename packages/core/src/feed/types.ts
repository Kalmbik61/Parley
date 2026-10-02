/**
 * Модель ленты вида «Chat» (план 2026-10-01, решения 3 и 13): что окно показывает вместо терминала.
 * Элементы — чистый JSON: хост держит их в кольце, окно и телефон получают снимком и дельтами
 * (решение 14), поэтому ни функций, ни `undefined` внутри значений нет — только необязательные поля.
 *
 * Тексты для человека здесь не живут: элемент несёт данные, подписи берёт окно из своих строк.
 */

/** Сколько символов результата инструмента лента хранит; дальше — «truncated, open the terminal». */
export const FEED_RESULT_LIMIT = 64 * 1024;

/** Предел строкового значения во входе вызова и карточки (`input`, `toolInput`); дальше — `truncated`. */
export const FEED_INPUT_LIMIT = 16 * 1024;

/** Сколько строк диффа лента хранит на один вызов; хвост отбрасывается, `patchTruncated`. */
export const FEED_PATCH_LINES = 2_000;

/** Предел задания и итога субагента (`FeedAgent.prompt`, `result`); дальше — `truncated`. */
export const FEED_AGENT_TEXT_LIMIT = 16 * 1024;

/** Предел текста ответа модели (`FeedText.text`); дальше — `truncated`. */
export const FEED_TEXT_LIMIT = 256 * 1024;

/**
 * Сколько вложенных вызовов держит карточка субагента (`FeedAgent.children`): старые уходят,
 * `toolCount` считает все. Вложенный вызов — строка-сводка, полный — в журнале субагента, поэтому и
 * строки его входа, и сводка результата короче, чем у вызова в общем потоке, а хунков диффа у него
 * нет. Иначе один элемент ленты рос бы на мегабайты и не влезал в строку протокола.
 */
export const FEED_AGENT_CHILDREN = 100;
/** Предел строкового значения во входе вложенного вызова субагента. */
export const FEED_CHILD_INPUT_LIMIT = 2 * 1024;
/** Предел сводки результата вложенного вызова субагента. */
export const FEED_CHILD_RESULT_LIMIT = 2 * 1024;

/** Вызов инструмента: идёт, закончился, упал, отклонён человеком (Esc, «Deny» или прерывание). */
export type FeedToolStatus = 'running' | 'done' | 'failed' | 'rejected';

/**
 * Карточка, которая ждёт человека. `allowed`/`denied` — решение разрешения или плана из окна,
 * `answered` — ответ на вопрос из окна, `elsewhere` — ответили в терминале или карточку сняли иначе,
 * `stale` — хук ждал дольше предела, отвечать теперь в терминале.
 */
export type FeedCardState = 'pending' | 'allowed' | 'denied' | 'answered' | 'elsewhere' | 'stale';

export type FeedAgentStatus = 'running' | 'done' | 'failed';

interface FeedItemBase {
  /** Уникален в ленте сессии; по нему окно применяет дельты. */
  id: string;
  /** Когда элемент появился: ISO-время события или записи журнала. */
  at: string;
}

/** Промпт человека. */
export interface FeedPrompt extends FeedItemBase {
  kind: 'prompt';
  text: string;
  /** Сколько картинок было в промпте (журнал); хуки картинок не отдают — 0. */
  images: number;
}

/** Текст ответа модели: растёт порциями `MessageDisplay`, закрывается `final` или `Stop`. */
export interface FeedText extends FeedItemBase {
  kind: 'text';
  /** `message_id` хука или `message.id` записи журнала; `null` — текст пришёл одним `Stop`. */
  messageId: string | null;
  text: string;
  streaming: boolean;
  /** Текст длиннее `FEED_TEXT_LIMIT` и обрезан. */
  truncated?: boolean;
}

/** Сводка результата инструмента: первые `FEED_RESULT_LIMIT` символов и полный размер. */
export interface FeedToolResponse {
  text: string;
  /** Полная длина сводки в символах, до усечения. */
  size: number;
  truncated: boolean;
}

/** Хунк `structuredPatch` правки: строки с префиксами ` `, `-`, `+`. */
export interface FeedPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Вызов инструмента. */
export interface FeedTool extends FeedItemBase {
  kind: 'tool';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** Строки входа длиннее `FEED_INPUT_LIMIT` обрезаны. */
  truncated?: boolean;
  status: FeedToolStatus;
  response?: FeedToolResponse;
  /** Хунки диффа `Edit`/`Write`; нет — правки не было или файл создан целиком. */
  patch?: FeedPatchHunk[];
  /** Дифф длиннее `FEED_PATCH_LINES` строк: хвост отброшен. */
  patchTruncated?: boolean;
  /** Вызов субагента — лежит внутри его карточки, а не в общем потоке. */
  agentId?: string;
  endedAt?: string;
}

/** Общее у карточек, ждущих человека. */
interface FeedCardBase extends FeedItemBase {
  /** Равен `id`: по нему окно шлёт `feed.decide`. */
  cardId: string;
  state: FeedCardState;
  /** Вызов, к которому относится карточка; `null` — `PreToolUse` не приходил, вызов ещё не известен. */
  toolUseId: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Строки входа длиннее `FEED_INPUT_LIMIT` обрезаны. */
  truncated?: boolean;
  /** Запрос пришёл из субагента. */
  agentId?: string;
  /** Когда карточка перестала ждать. */
  settledAt?: string;
}

/** Запрос разрешения (`PermissionRequest`). */
export interface FeedPermissionCard extends FeedCardBase {
  kind: 'permission';
  /** `permission_suggestions` как есть: из них окно строит «Allow and don't ask again». */
  suggestions: unknown[];
  /** Решение из окна: «не спрашивать больше» и текст для модели при отказе. */
  always?: boolean;
  message?: string;
  /** Пришёл `Notification` `permission_prompt`: CLI сам напомнил человеку про диалог. */
  notified: boolean;
}

export interface FeedQuestionOption {
  label: string;
  description: string | null;
}

export interface FeedQuestion {
  question: string;
  header: string | null;
  options: FeedQuestionOption[];
  multiSelect: boolean;
}

/** Вопрос агента (`AskUserQuestion`). */
export interface FeedQuestionCard extends FeedCardBase {
  kind: 'question';
  questions: FeedQuestion[];
  /** Ответ — из окна или из `PostToolUse`, если ответили в терминале. */
  answers?: Record<string, string>;
}

/** Одобрение плана (`ExitPlanMode`). */
export interface FeedPlanCard extends FeedCardBase {
  kind: 'plan';
  plan: string;
  planFilePath: string | null;
  choice?: 'auto-accept' | 'manual';
}

export type FeedCard = FeedPermissionCard | FeedQuestionCard | FeedPlanCard;

/** Субагент (решение 13): вызов `Agent` и всё, что субагент сделал. */
export interface FeedAgent extends FeedItemBase {
  kind: 'agent';
  /** Вызов `Agent` у родителя. */
  toolUseId: string;
  /** `agent_id` субагента; `null` — ещё не привязан (`SubagentStart` не приходил). */
  agentId: string | null;
  agentType: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  /** Фоновый: `PostToolUse(Agent)` пришёл сразу со `status: async_launched`. */
  background: boolean;
  status: FeedAgentStatus;
  endedAt?: string;
  durationMs?: number;
  /** Сколько вызовов инструментов сделал субагент — и тех, что из `children` уже ушли. */
  toolCount: number;
  /**
   * Вложенные вызовы — только у живой ленты; в журнале родителя их нет. Не больше
   * `FEED_AGENT_CHILDREN` последних, вход и сводка короткие, без хунков.
   */
  children: FeedTool[];
  /** Итоговый текст субагента. */
  result?: string;
  /** Журнал субагента (`agent_transcript_path`). */
  transcriptPath?: string;
  /** Задание или итог длиннее `FEED_AGENT_TEXT_LIMIT` и обрезаны. */
  truncated?: boolean;
}

/** Что случилось в сессии помимо разговора. */
export type FeedNoticeData =
  | { type: 'session-start'; source: string | null; model: string | null }
  | { type: 'session-end'; reason: string | null }
  | { type: 'compact'; phase: 'pre' | 'post'; trigger: string | null }
  | { type: 'model-switch'; from: string | null; to: string | null; source: string | null }
  | {
      type: 'agent-reported';
      /** `id` карточки `agent` в ленте; `null` — карточки нет (сессию подняли после запуска агента). */
      agentItemId: string | null;
      agentId: string | null;
      status: string | null;
      summary: string | null;
    };

export interface FeedNotice extends FeedItemBase {
  kind: 'notice';
  notice: FeedNoticeData;
}

/** Ход оборвался ошибкой API (`StopFailure`, в журнале — `isApiErrorMessage`). */
export interface FeedError extends FeedItemBase {
  kind: 'error';
  error: string;
  message: string | null;
}

/** Конец хода. */
export interface FeedTurn extends FeedItemBase {
  kind: 'turn';
  /** Длительность хода; `null` — начала хода лента не видела. */
  durationMs: number | null;
}

export type FeedItem =
  | FeedPrompt
  | FeedText
  | FeedTool
  | FeedPermissionCard
  | FeedQuestionCard
  | FeedPlanCard
  | FeedAgent
  | FeedNotice
  | FeedError
  | FeedTurn;

/** Решение человека из окна (`feed.decide`). */
export type FeedDecision =
  | { kind: 'permission'; behavior: 'allow' | 'deny'; always?: true; message?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'plan'; choice: 'auto-accept' | 'manual' };

/**
 * Порции одного растущего текста по `index`: `MessageDisplay` приходят не по порядку (на стенде
 * порция 3 с `final` опередила порцию 2). Порции без дыр склеены в `head`, опередившие ждут в `ahead`.
 */
export interface FeedStream {
  /** Склеенные порции `0..count-1`. */
  head: string;
  count: number;
  /** Порции, пришедшие раньше предыдущих: `index` → текст. */
  ahead: Readonly<Record<string, string>>;
  /** `index` порции с `final: true`; `null` — её ещё не было. */
  finalIndex: number | null;
}

/**
 * Состояние редьюсера ленты одной сессии. Наружу (в окно и на телефон) отдаётся только `items`;
 * остальное — внутреннее редьюсера. Кольцо держит хост: `items` он вправе обрезать сам.
 */
export interface FeedState {
  items: readonly FeedItem[];
  /** Счётчик для `id` элементов, у которых нет своего ключа. */
  seq: number;
  /** Начало идущего хода; `null` — ход не идёт. */
  turnStartedAt: string | null;
  /** Порции растущих текстов по `messageId`; закрытый текст отсюда уходит. В окно не едет. */
  streams: Readonly<Record<string, FeedStream>>;
}

/** Результат шага редьюсера: новое состояние и элементы, которые появились или изменились. */
export interface FeedUpdate {
  state: FeedState;
  changes: FeedItem[];
}
