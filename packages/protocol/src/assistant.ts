/**
 * Протокол помощника (спека 2026-10-14, 6.5): методы хода, карточки и разговора и снимок его состояния, который
 * хост рассылает событием `assistant.changed`.
 */

import { z } from 'zod';
import type { AssistantMood } from '@parley/core';

export type AssistantPhase = 'idle' | 'thinking' | 'tool' | 'answering' | 'awaiting-confirm' | 'error' | 'offline';

/** Что помощник смотрит сейчас — подпись острова строит окно (`Checking rooms…`, `Reading Auth…`). */
export interface AssistantDetail {
  tool: 'overview' | 'detail' | 'propose' | 'other';
  /** Имя комнаты или сессии у `detail`. */
  target: string | null;
}

export interface AssistantProposal {
  id: string;
  /** Имя адресата: комната («Auth») или сессия («S03 Ruslan»). */
  target: string;
  /** Работа и проект: «Parley · my_harnas». */
  where: string;
  /** Вид письма комнаты; у сессии — `null`. */
  kind: 'note' | 'question' | 'decision' | null;
  text: string;
}

export interface AssistantState {
  phase: AssistantPhase;
  detail: AssistantDetail | null;
  /** Последний вопрос человека. */
  question: string | null;
  /** Ответ, растёт по ходу. */
  answer: string;
  mood: AssistantMood;
  proposal: AssistantProposal | null;
  /** Исход последней карточки — для «Sent ✓»; новый ход сбрасывает. */
  outcome: 'sent' | 'cancelled' | null;
  /** Причина `error` и `offline`, по-английски. */
  error: string | null;
  /** Номер хода: окно отличает новый ход от продолжения старого. */
  turn: number;
}

const sessionRef = z.object({ projectPath: z.string(), workId: z.string(), sessionId: z.string() });

export const assistantMethodSchemas = {
  'assistant.ask': z.object({
    text: z.string().min(1).max(4000),
    /** `null` — первый готовый провайдер (`claude`, `glm`, `codex`). */
    provider: z.string().min(1).nullable(),
    /** `null` — модель по умолчанию провайдера. */
    model: z.string().min(1).nullable(),
    language: z.enum(['en', 'ru']),
  }),
  'assistant.cancel': z.object({}),
  'assistant.decide': z.object({ proposalId: z.string().min(1), decision: z.enum(['send', 'cancel']) }),
  'assistant.reset': z.object({}),
  'assistant.state': z.object({}),
  'assistant.sent': z.object({ ref: sessionRef }),
} as const;

export interface AssistantMethodResults {
  'assistant.ask': { ok: true };
  'assistant.cancel': { ok: true };
  'assistant.decide': { applied: boolean; error: string | null };
  'assistant.reset': { ok: true };
  'assistant.state': AssistantState;
  /** Что помощник отправил этой сессии в Chat — окно помечает такие сообщения (спека 7.4). */
  'assistant.sent': { items: Array<{ text: string; at: string }> };
}
