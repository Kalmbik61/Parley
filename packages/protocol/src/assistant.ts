/**
 * Протокол помощника (спека 2026-10-14, 6.5): методы хода, карточки и разговора и снимок его состояния, который
 * хост рассылает событием `assistant.changed`.
 */

import { z } from 'zod';
import type { AssistantMood, FeedDecision } from '@parley/core';

/** Признак клиента в `hello.features`: окно умеет рисовать карточку `actions` и её отчёт. Старый хост его не знает. */
export const ASSISTANT_ACTIONS_FEATURE = 'assistant-actions';

export type AssistantPhase = 'idle' | 'thinking' | 'tool' | 'answering' | 'awaiting-confirm' | 'error' | 'offline';

/** Что помощник смотрит сейчас — подпись острова строит окно (`Checking rooms…`, `Reading Auth…`). */
export interface AssistantDetail {
  tool: 'overview' | 'detail' | 'propose' | 'other';
  /** Имя комнаты или сессии у `detail`. */
  target: string | null;
}

/** Карточка ленты агента (разрешение, вопрос, план), по которой помощник предлагает решение. */
export interface ProposalCardView {
  cardId: string;
  kind: 'permission' | 'question' | 'plan';
  /** Короткая суть карточки: что агент просит или спрашивает. */
  summary: string;
  /** Подробности (команда, варианты, текст плана); `null` — нечего добавить. */
  detail: string | null;
}

/** Предложение ведущего комнаты, по которому помощник предлагает решение (принять или вернуть). */
export interface RoomProposalView {
  proposalId: string;
  rev: number;
  kind: 'decision' | 'completion';
  /** Кто предложил (имя ведущего, «S03 Ruslan»). */
  from: string;
  text: string;
  planId?: string;
  planRev?: number;
}

/** Глагол шага плана карточки `actions`. */
export type ActionVerb =
  | 'create_work'
  | 'create_session'
  | 'wake'
  | 'interrupt'
  | 'sleep'
  | 'close'
  | 'create_room'
  | 'add_to_room'
  | 'message';

/** Шаг плана так, как его видит человек на карточке. */
export interface ActionStepView {
  verb: ActionVerb;
  /** Строка шага: «Wake S05 Vera». */
  line: string;
  /** Текст под шагом (задача агента, письмо); `null` — нечего показать. */
  text: string | null;
  /** `true` только у `close`: окно и Telegram выделяют строку и добавляют «closes for good». */
  danger: boolean;
}

/** Как идёт выполнение плана карточки `actions`; хост шлёт его в `AssistantState.report`. */
export interface ActionsReport {
  proposalId: string;
  status: 'running' | 'done' | 'stopped';
  steps: Array<{ line: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' }>;
  /** Номер упавшего шага с 1; у running и done — null. */
  failedStep: number | null;
  reason: string | null;
  /** Пометки сделанных шагов: «Alice waits for you to trust the folder». */
  notes: string[];
}

/** Строка итога отчёта для острова и Telegram: ход, готово или остановка. */
export function reportLine(report: ActionsReport): string {
  const total = report.steps.length;
  switch (report.status) {
    case 'done':
      return 'Done';
    case 'stopped':
      // По договору у stopped номер и причина есть; запасные значения — только чтобы строка не вышла с «null».
      return `Stopped at step ${report.failedStep ?? total} of ${total}: ${report.reason ?? 'unknown reason'}`;
    case 'running': {
      let current = report.steps.findIndex((step) => step.status === 'running');
      if (current < 0) current = report.steps.findIndex((step) => step.status === 'waiting');
      return `Running step ${current < 0 ? total : current + 1} of ${total}`;
    }
  }
}

/**
 * Общие поля любого вида карточки. Решение плана: `target`, `where` и `text` несут все четыре вида, чтобы старое окно,
 * не знающее новых `action`, показало любую карточку как обычное письмо (адресат, работа, текст), а не сломалось.
 */
interface ProposalBase {
  id: string;
  /** Имя адресата: комната («Auth») или сессия («S03 Ruslan»); у `room` — название новой комнаты. */
  target: string;
  /** Работа и проект: «Parley · my_harnas». */
  where: string;
  /** Что увидит человек: текст письма, задача комнаты или описание решения. */
  text: string;
}

/**
 * Карточка подтверждения. Вид определяет `action`; у письма он необязателен и равен `'message'`: старый хост поля не
 * шлёт, новый шлёт всегда, так что окно читает отсутствие `action` как письмо.
 */
export type AssistantProposal =
  | (ProposalBase & {
      /** Письмо в комнату или сессию. Без поля — тоже письмо (старый хост). */
      action?: 'message';
      /** Вид письма комнаты; у сессии — `null`. */
      kind: 'note' | 'question' | 'decision' | null;
      /**
       * Кому из участников комнаты письмо (имена, «S03 Ruslan»): уйдёт с `to` и токенами `@s03`. Пусто — задача всем; у
       * сессии всегда пусто. Старый хост поля не шлёт.
       */
      mentions?: string[];
      /** Цель спит: подтверждение поднимет сессию (`resume`) этим текстом первым ходом. У комнат и запущенных сессий — `false`. */
      wake: boolean;
    })
  | (ProposalBase & {
      /** Создать комнату. */
      action: 'room';
      title: string;
      /** Имена участников (сессии). */
      members: string[];
      /** Имя ведущего; одно из `members`. */
      lead: string;
      /** Первая задача комнаты; `null` — без задачи. */
      task: string | null;
    })
  | (ProposalBase & {
      /** Решить карточку ленты агента (разрешение, вопрос, план). */
      action: 'decision';
      card: ProposalCardView;
      /** Решение, которое уйдёт в `feed.decide` после подтверждения. */
      decision: FeedDecision;
    })
  | (ProposalBase & {
      /** План из шагов: создать, разбудить, прервать, усыпить, закрыть, написать. Выполняется только кнопкой карточки. */
      action: 'actions';
      steps: ActionStepView[];
    })
  | (ProposalBase & {
      /** Решить предложение ведущего комнаты. */
      action: 'room-decision';
      proposal: RoomProposalView;
      /** `accept` — принять; `return` — вернуть на доработку. */
      choice: 'accept' | 'return';
      /** Пояснение человека при `return`; `null` — без пояснения. */
      note: string | null;
    });

/** Откуда пришёл ход: человек спросил на острове, сработало напоминание или пришло сообщение из Telegram. Старый хост не шлёт (= `island`). */
export type AssistantOrigin = 'island' | 'reminder' | 'telegram';

export interface AssistantState {
  phase: AssistantPhase;
  detail: AssistantDetail | null;
  /** Последний вопрос человека. */
  question: string | null;
  /** Ответ, растёт по ходу; метки `[[mood]]` хост срезает все. */
  answer: string;
  /** Эмоция первой фразы ответа. */
  mood: AssistantMood;
  /** Эмоции по предложениям (#9 §6.7 L3): `at` — позиция в `answer`, с которой начинается предложение. Старый хост не шлёт. */
  moods?: Array<{ at: number; mood: AssistantMood }>;
  proposal: AssistantProposal | null;
  /** Исход последней карточки — для «Sent ✓»; `done` — действие выполнено (комната создана, решение принято); новый ход сбрасывает. */
  outcome: 'sent' | 'done' | 'cancelled' | null;
  /** Причина `error` и `offline`, по-английски. */
  error: string | null;
  /** Номер хода: окно отличает новый ход от продолжения старого. */
  turn: number;
  /** `askId` вопроса, на который идёт этот ход: окно по нему узнаёт, что хост вопрос принял. Старый хост не шлёт. */
  askId?: string | null;
  /** Id процесса хоста: сменился, пока вопрос был в пути, — хост перезапустился, и вопрос не дошёл. Старый хост не шлёт. */
  instance?: string;
  /** Откуда пришёл ход. Старый хост не шлёт — окно считает `island`. */
  origin?: AssistantOrigin;
  /** Отчёт о выполнении карточки `actions`; `null` — плана нет. Старый хост не шлёт. */
  report?: ActionsReport | null;
}

const sessionRef = z.object({ projectPath: z.string(), workId: z.string(), sessionId: z.string() });

// Схемы источника и связи job живут в `remote/job-schemas.ts`: входу `@parley/protocol/remote` нельзя выходить за свой
// каталог, а телефон проверяет те же формы. Здесь они переэкспортируются под прежними именами.
export { assistantJobOriginSchema, assistantJobCorrelationSchema } from './remote/job-schemas.js';
export type { AssistantJobOrigin, AssistantJobCorrelation } from './remote/job-schemas.js';

/** Откуда решена карточка: окно, кнопка Telegram или телефон. */
export const assistantDecidedViaSchema = z.enum(['island', 'telegram', 'mobile']);
export type AssistantDecidedVia = z.infer<typeof assistantDecidedViaSchema>;

/**
 * Request голосового поручения (спека «Голос↔Ассистент», §4, T2): хост-сторона запись «человек поручил, Live делегировал».
 * Методы только локальные (остров): в remote-списках их нет, `jobs.submit` телефона по-прежнему ставит `mobile`.
 * `originKey` хост выводит из исходных `voiceSessionId` + `delegationId`: клиент при восстановлении шлёт прежние id.
 */
const requestId = z.string().min(1).max(128);
const requestConsumer = z.string().min(1).max(64);
export const assistantRequestMethodSchemas = {
  'requests.submit': z.strictObject({
    /** Разговор острова, а не голосовая сессия. */
    conversationId: z.string().min(1).max(128),
    voiceSessionId: z.string().min(1).max(128),
    delegationId: z.string().min(1).max(128),
    /** Без поля хост берёт `delegationId`: связь job требует turnId. */
    turnId: z.string().min(1).max(128).optional(),
    text: z.string().min(1).max(4000),
    /** Последние реплики и открытые Request; хост хранит как есть (не больше 16 КБ в JSON). */
    context: z.record(z.string(), z.unknown()).optional(),
    transcriptPartial: z.boolean().optional(),
  }),
  'requests.list': z.strictObject({ conversationId: z.string().min(1).max(128), consumer: requestConsumer }),
  /** Потребитель получил итог: `revision` — ревизия финального состояния job, как в `jobs.ackInline`. */
  'requests.ack': z.strictObject({ requestId, consumer: requestConsumer, revision: z.number().int().nonnegative() }),
} as const;

export const assistantMethodSchemas = {
  ...assistantRequestMethodSchemas,
  'assistant.ask': z.object({
    text: z.string().min(1).max(4000),
    /** `null` — первый готовый провайдер (`claude`, `glm`, `codex`). */
    provider: z.string().min(1).nullable(),
    /** `null` — модель по умолчанию провайдера. */
    model: z.string().min(1).nullable(),
    language: z.string().regex(/^[a-z]{2,3}$/),
    /** Id вопроса от окна; хост вернёт его в `AssistantState.askId`. Старое окно не шлёт. */
    askId: z.string().min(1).max(128).optional(),
  }),
  'assistant.cancel': z.object({}),
  'assistant.decide': z.object({
    proposalId: z.string().min(1),
    decision: z.enum(['send', 'cancel']),
    /** `actions` — решение по карточке с планом; без поля хост такой план не выполнит. Старый хост поле молча отбросит. */
    action: z.literal('actions').optional(),
  }),
  /** «Запросить заново»: новая карточка на месте просроченной (новый id). */
  'assistant.reissue': z.object({ proposalId: z.string().min(1) }),
  /**
   * Решение по карточке ядра с телефона (`decidedVia: 'mobile'`): `revision` — та, что клиент видел в `assistant.card.changed`;
   * устаревшая отвергается без действия. Карточка может быть без job (письмо с острова).
   */
  'cards.decide': z.strictObject({
    cardId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    choice: z.enum(['send', 'cancel']),
  }),
  /** Экран показал финал job: единственный эффект — флаг `deliveredInline`, push по этому событию не нужен. */
  'jobs.ackInline': z.strictObject({ jobId: z.string().min(1), revision: z.number().int().nonnegative() }),
  'assistant.reset': z.object({}),
  'assistant.state': z.object({}),
  'assistant.sent': z.object({ ref: sessionRef }),
  /** Настройки помощника для каналов без окна (Telegram): окно шлёт их при каждом изменении. */
  'assistant.configure': z.object({
    enabled: z.boolean(),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    language: z.string().regex(/^[a-z]{2,3}$/),
    /** Абсолютный путь к файлу модели Whisper; `null` — голос не распознаётся. */
    voiceModel: z.string().min(1).nullable(),
    /** Род, в котором помощник говорит о себе, — по выбранному голосу (#9 §6.8). Без поля — `female`. */
    voiceGender: z.enum(['female', 'male', 'neutral']).optional(),
    /** Провайдер по умолчанию для новых агентов помощника; `null` — первый готовый. Старый хост поле молча отбросит. */
    defaultProvider: z.string().min(1).nullable().optional(),
  }),
} as const;

/** Параметры `assistant.configure`. */
export type AssistantSettings = z.infer<(typeof assistantMethodSchemas)['assistant.configure']>;

/** Событие `assistant.job.changed`: job помощника сменил состояние; `revision` растёт только вверх. */
export interface AssistantJobChanged {
  jobId: string;
  state: 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';
  revision: number;
}

/** Событие `assistant.card.changed`: карточка ядра сменила состояние; `revision` растёт только вверх. */
export interface AssistantCardChanged {
  cardId: string;
  kind: string;
  /** `needs_confirmation` — активная карточка (и после возврата в активные); остальное терминально. */
  state: 'needs_confirmation' | 'decided' | 'expired' | 'superseded';
  revision: number;
  expiresAt: number;
  decidedVia: AssistantDecidedVia | null;
  /** Исход решённой карточки (`sent`, `done`, `cancelled`, `stopped`, `failed`, `unknown`); пока не решена — `null`. */
  outcome: string | null;
}

/** Исход `cards.decide`: `already_handled` — карточку уже решили или её ревизия устарела; `expired` — срок вышел. */
export type CardDecideResult =
  | { applied: true; error: string | null; reason: 'applied' }
  | { applied: false; error: string; reason: 'already_handled' | 'expired' | 'not_found' | 'failed' };

/**
 * Итог job (`JobResult`, план голоса T1): `cards` и `toolRefs` записал хост, не модель. В `toolRefs` нет аргументов
 * вызовов, в `cards` — только id и вид карточки.
 */
export interface AssistantRequestJobResult {
  answer: string;
  capturedAt: number;
  cards: Array<{ cardId: string; kind: string }>;
  toolRefs: Array<{ tool: string; ok: boolean; at: number }>;
}

/** Состояние job в Request: проекция без логов и argv. `result` — итог прогона; `null`, пока его нет (или он не снимался). */
export interface AssistantRequestJob {
  jobId: string;
  state: 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  resultSummary: string | null;
  result: AssistantRequestJobResult | null;
}

/** Request на хосте. `version` отдельна от `job.revision`; `delivery` — ревизия job, доставленная потребителю. */
export interface AssistantRequestView {
  requestId: string;
  originKey: string;
  conversationId: string;
  seq: number;
  version: number;
  text: string;
  context: Record<string, unknown> | null;
  jobId: string;
  supersededBy: string | null;
  transcriptPartial: boolean;
  delivery: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  job: AssistantRequestJob;
}

export type AssistantRequestAck = { ok: boolean; reason: 'acked' | 'already_acked' | 'stale' | 'not_found' | 'not_terminal' };

export interface AssistantMethodResults {
  'requests.submit': { request: AssistantRequestView; created: boolean };
  'requests.list': { requests: AssistantRequestView[] };
  'requests.ack': AssistantRequestAck;
  'assistant.ask': { ok: true };
  'assistant.cancel': { ok: true };
  'assistant.decide': { applied: boolean; error: string | null };
  'assistant.reissue': { applied: boolean; error: string | null; proposalId: string | null };
  'cards.decide': CardDecideResult;
  'jobs.ackInline': { ok: boolean; deliveredInline: boolean; reason: 'acked' | 'already_acked' | 'stale' | 'not_found' };
  'assistant.reset': { ok: true };
  'assistant.state': AssistantState;
  'assistant.configure': { ok: true };
  /** Что помощник отправил этой сессии в Chat — окно помечает такие сообщения (спека 7.4). */
  'assistant.sent': { items: Array<{ text: string; at: string }> };
}
