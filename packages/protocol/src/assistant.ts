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
  /** Шаг необратим или прерывает работу (прервать, закрыть): окно выделяет строку. */
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

export const assistantMethodSchemas = {
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

export interface AssistantMethodResults {
  'assistant.ask': { ok: true };
  'assistant.cancel': { ok: true };
  'assistant.decide': { applied: boolean; error: string | null };
  'assistant.reset': { ok: true };
  'assistant.state': AssistantState;
  'assistant.configure': { ok: true };
  /** Что помощник отправил этой сессии в Chat — окно помечает такие сообщения (спека 7.4). */
  'assistant.sent': { items: Array<{ text: string; at: string }> };
}
