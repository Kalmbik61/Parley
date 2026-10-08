/**
 * Протокол ленты вида «Chat» (план 2026-10-01, Task 2, решение 14): схемы элементов ленты и решений
 * окна. Типы живут в core (`packages/core/src/feed/types.ts`); схемы объявлены как `z.ZodType<…>` от
 * этих типов, поэтому расхождение схемы с core ловит typecheck.
 *
 * Элементы — строгие объекты: лишнее поле не проходит. Лента растёт только добавлением полей, и
 * каждое добавление поднимает `FEED_SCHEMA_VERSION`.
 *
 * Пределы строк повторяют константы core, а не импортируют их: протокол грузит рендерер окна, а
 * рантайм `@parley/core` тянет модули node. Равенство пределов сверяет `feed.test.ts`.
 */

import { z } from 'zod';
import type { FeedCardState, FeedDecision, FeedItem } from '@parley/core';

/** Версия схемы ленты: растёт с каждым добавленным полем элемента или решения. */
export const FEED_SCHEMA_VERSION = 2;

/** = `FEED_RESULT_LIMIT` core: символов сводки результата инструмента. */
export const FEED_RESULT_LIMIT = 64 * 1024;
/** = `FEED_INPUT_LIMIT` core: символов каждой строки во входе вызова и карточки. */
export const FEED_INPUT_LIMIT = 16 * 1024;
/** = `FEED_PATCH_LINES` core: строк диффа на один вызов. */
export const FEED_PATCH_LINES = 2_000;
/** = `FEED_AGENT_TEXT_LIMIT` core: символов задания и итога субагента. */
export const FEED_AGENT_TEXT_LIMIT = 16 * 1024;
/** = `FEED_TEXT_LIMIT` core: символов текста ответа модели. */
export const FEED_TEXT_LIMIT = 256 * 1024;
/** = `FEED_AGENT_CHILDREN` core: вложенных вызовов у карточки субагента. */
export const FEED_AGENT_CHILDREN = 100;
/**
 * = `FEED_MIN_VERSION` core: наименьшая версия `claude`, которой хост пишет HTTP-хуки ленты. Окно по
 * ней решает, доступен ли сессии вид «Chat» (решение 6), — core в рендерер не импортируется.
 */
export const FEED_MIN_VERSION = '2.1.286';
/** = `CODEX_FEED_MIN_VERSION` core: наименьшая версия `codex` для вида «Chat» (спека 2026-10-07, 5.4). */
export const CODEX_FEED_MIN_VERSION = '0.160.0';
/** Признак `hello.features` хоста, который строит ленту Codex из журнала. */
export const FEED_CODEX_FEATURE = 'feed-codex';
/** Может ли окно отвечать на одобрения сессии (`window`) или только терминал (`terminal`); спека 5.7. */
export const feedDecisions = z.enum(['window', 'terminal']);
export type FeedDecisions = z.infer<typeof feedDecisions>;

/** Текст отказа для модели в `feed.decide` (как заметка возврата `rooms.resolveProposal`). */
export const FEED_DECISION_MESSAGE_LIMIT = 4000;
/** Сколько вопросов может ответить одно решение `feed.decide`. */
export const FEED_DECISION_ANSWERS = 20;
/** Символов в ответе на один вопрос `feed.decide`. */
export const FEED_DECISION_ANSWER_LIMIT = 16 * 1024;

/** Все строки внутри значения (ключи не в счёт) не длиннее `limit`. */
function stringsWithin(value: unknown, limit: number): boolean {
  if (typeof value === 'string') return value.length <= limit;
  if (Array.isArray(value)) return value.every((item) => stringsWithin(item, limit));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every((item) => stringsWithin(item, limit));
  }
  return true;
}

/** Вход вызова или карточки: объект, каждая строка внутри — до `FEED_INPUT_LIMIT`. */
const toolInput = z
  .record(z.string(), z.unknown())
  .refine((input) => stringsWithin(input, FEED_INPUT_LIMIT));

export const feedCardState: z.ZodType<FeedCardState> = z.enum([
  'pending',
  'allowed',
  'denied',
  'answered',
  'elsewhere',
  'stale',
]);

const base = { id: z.string(), at: z.string() };

const prompt = z.strictObject({
  ...base,
  kind: z.literal('prompt'),
  text: z.string(),
  images: z.number().int().min(0),
});

const text = z.strictObject({
  ...base,
  kind: z.literal('text'),
  messageId: z.string().nullable(),
  text: z.string().max(FEED_TEXT_LIMIT),
  streaming: z.boolean(),
  truncated: z.boolean().exactOptional(),
});

const toolResponse = z.strictObject({
  text: z.string().max(FEED_RESULT_LIMIT),
  size: z.number().int().min(0),
  truncated: z.boolean(),
});

const patchHunk = z.strictObject({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

const tool = z.strictObject({
  ...base,
  kind: z.literal('tool'),
  toolUseId: z.string(),
  name: z.string(),
  input: toolInput,
  truncated: z.boolean().exactOptional(),
  status: z.enum(['running', 'done', 'failed', 'rejected']),
  response: toolResponse.exactOptional(),
  patch: z
    .array(patchHunk)
    .refine((hunks) => hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) <= FEED_PATCH_LINES)
    .exactOptional(),
  patchTruncated: z.boolean().exactOptional(),
  agentId: z.string().exactOptional(),
  endedAt: z.string().exactOptional(),
});

const cardBase = {
  ...base,
  cardId: z.string(),
  state: feedCardState,
  toolUseId: z.string().nullable(),
  toolName: z.string(),
  toolInput,
  truncated: z.boolean().exactOptional(),
  agentId: z.string().exactOptional(),
  settledAt: z.string().exactOptional(),
};

const permission = z.strictObject({
  ...cardBase,
  kind: z.literal('permission'),
  suggestions: z.array(z.unknown()),
  always: z.boolean().exactOptional(),
  message: z.string().max(FEED_DECISION_MESSAGE_LIMIT).exactOptional(),
  notified: z.boolean(),
});

// Вопросы и план core берёт из уже усечённого входа карточки — тот же предел.
const inputText = z.string().max(FEED_INPUT_LIMIT);

const question = z.strictObject({
  ...cardBase,
  kind: z.literal('question'),
  questions: z.array(
    z.strictObject({
      question: inputText,
      header: inputText.nullable(),
      options: z.array(z.strictObject({ label: inputText, description: inputText.nullable() })),
      multiSelect: z.boolean(),
    }),
  ),
  // Ответ из терминала (`PostToolUse`) core не усекает, поэтому пределов `feed.decide` здесь нет.
  answers: z.record(z.string(), z.string()).exactOptional(),
});

const plan = z.strictObject({
  ...cardBase,
  kind: z.literal('plan'),
  plan: inputText,
  planFilePath: inputText.nullable(),
  choice: z.enum(['auto-accept', 'manual']).exactOptional(),
});

const agentText = z.string().max(FEED_AGENT_TEXT_LIMIT);

const agent = z.strictObject({
  ...base,
  kind: z.literal('agent'),
  toolUseId: z.string(),
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
  description: z.string().nullable(),
  prompt: agentText.nullable(),
  model: z.string().nullable(),
  background: z.boolean(),
  status: z.enum(['running', 'done', 'failed']),
  endedAt: z.string().exactOptional(),
  durationMs: z.number().min(0).exactOptional(),
  toolCount: z.number().int().min(0),
  children: z.array(tool).max(FEED_AGENT_CHILDREN),
  result: agentText.exactOptional(),
  transcriptPath: z.string().exactOptional(),
  truncated: z.boolean().exactOptional(),
});

const noticeData = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-start'),
    source: z.string().nullable(),
    model: z.string().nullable(),
  }),
  z.strictObject({ type: z.literal('session-end'), reason: z.string().nullable() }),
  z.strictObject({
    type: z.literal('compact'),
    phase: z.enum(['pre', 'post']),
    trigger: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('model-switch'),
    from: z.string().nullable(),
    to: z.string().nullable(),
    source: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('agent-reported'),
    agentItemId: z.string().nullable(),
    agentId: z.string().nullable(),
    status: z.string().nullable(),
    summary: z.string().nullable(),
  }),
]);

const notice = z.strictObject({ ...base, kind: z.literal('notice'), notice: noticeData });

const error = z.strictObject({
  ...base,
  kind: z.literal('error'),
  error: z.string(),
  message: z.string().nullable(),
  retry: z.strictObject({
    delayMs: z.number().finite().min(0),
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    resolved: z.literal(true).exactOptional(),
  }).refine((retry) => retry.attempt <= retry.maxAttempts).exactOptional(),
});

const turn = z.strictObject({
  ...base,
  kind: z.literal('turn'),
  durationMs: z.number().min(0).nullable(),
  /** Ход оборван человеком (Esc): записью журнала, без `Stop`. */
  interrupted: z.literal(true).exactOptional(),
});

/** Элемент ленты (`FeedItem` core). */
export const feedItem: z.ZodType<FeedItem> = z.discriminatedUnion('kind', [
  prompt,
  text,
  tool,
  permission,
  question,
  plan,
  agent,
  notice,
  error,
  turn,
]);

/** Решение человека из окна (`FeedDecision` core) — параметр `feed.decide`. */
export const feedDecision: z.ZodType<FeedDecision> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    behavior: z.enum(['allow', 'deny']),
    always: z.literal(true).exactOptional(),
    message: z.string().max(FEED_DECISION_MESSAGE_LIMIT).exactOptional(),
  }),
  z.object({
    kind: z.literal('question'),
    answers: z
      .record(z.string().max(FEED_INPUT_LIMIT), z.string().max(FEED_DECISION_ANSWER_LIMIT))
      .refine((answers) => Object.keys(answers).length <= FEED_DECISION_ANSWERS),
  }),
  z.object({ kind: z.literal('plan'), choice: z.enum(['auto-accept', 'manual']) }),
]);
