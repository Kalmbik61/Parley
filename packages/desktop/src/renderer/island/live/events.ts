/**
 * События GPT-Live канала данных `oai-events` (чистый TS): разбор в типизированные события, дедупликация по `event_id`
 * и сборка исходящих `thinking.append` / `commentary.append`. Формы сверены с живыми журналами T0
 * (`docs/research/2026-11-04-gpt-live-transport-spike.md` §1, §2d, §2e). Тексты, аудио и ключ не логируются.
 *
 * Канал данных и sideband на хосте получают одни и те же события с одним `event_id`, поэтому дедуплицировать нужно по
 * `event_id` и здесь тоже (на случай повторной доставки по каналу).
 */

/** Эмоции Decisions (V2): ровно пять значений вопроса `expression`; `error` приходит только от нашей стороны. */
export const LIVE_EMOTIONS = ['calm', 'joy', 'sad', 'surprise', 'anger'] as const;
export type LiveEmotion = (typeof LIVE_EMOTIONS)[number];

export type LiveEvent =
  | { type: 'sessionStarted'; expiresAt: number | null }
  /** `offsetMs` — на одной шкале с `startMs`/`endMs` транскрипта (мс от старта сессии). */
  | { type: 'delegationCreated'; delegationId: string; offsetMs: number }
  /** Фрагмент по 200 мс; границы фрагмента не равны границам слов, склеивать без добавления пробелов. */
  | { type: 'inputTranscript'; text: string; startMs: number; endMs: number }
  | { type: 'outputTranscript'; text: string; startMs: number; endMs: number }
  /** Подтверждение доставки `append`: приходит через 0,6–0,9 с и не означает звук. */
  | { type: 'appended'; kind: 'thinking' | 'commentary'; clientEventId: string | null }
  | { type: 'usage'; seconds: number }
  /**
   * Решение Decisions GPT-Live об эмоции (`decision.event` → `decision.completed`, вопрос `expression`).
   * `sourceEventId` — `event_id` фрагмента транскрипта, вызвавшего решение; `inputTokens` — расход Decisions (0, если не указан).
   */
  | { type: 'emotion'; value: LiveEmotion; confidence: number; sourceEventId: string | null; inputTokens: number }
  /** Решение пришло, но значения нет в списке или ответа `expression` нет: лицо не трогаем, считаем в телеметрии. */
  | { type: 'decisionRejected'; inputTokens: number }
  | { type: 'sessionClosed'; reason: string }
  | { type: 'error'; code: string; message: string };

export interface ParsedLiveEvent {
  /** `null` — у события нет `event_id`: дедупликации не подлежит. */
  eventId: string | null;
  event: LiveEvent;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const ERROR_TEXT_LIMIT = 200;

/** Разбирает одно сообщение канала данных (строку JSON или уже разобранный объект); неизвестное и битое — `null`. */
export function parseLiveEvent(raw: unknown): ParsedLiveEvent | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const type = text(value['type']);
  if (type === null) return null;
  const eventId = text(value['event_id']);
  const wrap = (event: LiveEvent): ParsedLiveEvent => ({ eventId, event });

  switch (type) {
    case 'session.started': {
      const session = isRecord(value['session']) ? value['session'] : null;
      return wrap({ type: 'sessionStarted', expiresAt: session === null ? null : finite(session['expires_at']) });
    }
    case 'session.delegation.created': {
      const delegation = isRecord(value['delegation']) ? value['delegation'] : null;
      const id = delegation === null ? null : text(delegation['id']);
      const offsetMs = finite(value['offset_ms']);
      if (id === null || id === '' || offsetMs === null) return null;
      return wrap({ type: 'delegationCreated', delegationId: id, offsetMs });
    }
    case 'session.input_transcript.delta':
    case 'session.output_transcript.delta': {
      const delta = text(value['delta']);
      const startMs = finite(value['start_ms']);
      const endMs = finite(value['end_ms']);
      if (delta === null || startMs === null || endMs === null) return null;
      return wrap({ type: type === 'session.input_transcript.delta' ? 'inputTranscript' : 'outputTranscript', text: delta, startMs, endMs });
    }
    case 'session.thinking.appended':
    case 'session.commentary.appended':
      return wrap({ type: 'appended', kind: type === 'session.thinking.appended' ? 'thinking' : 'commentary', clientEventId: text(value['client_event_id']) });
    case 'session.usage.updated': {
      const usage = isRecord(value['usage']) ? value['usage'] : null;
      const seconds = usage === null ? null : finite(usage['seconds']);
      return seconds === null ? null : wrap({ type: 'usage', seconds });
    }
    case 'decision.event':
      return parseDecision(value, wrap);
    case 'session.closed':
      return wrap({ type: 'sessionClosed', reason: text(value['reason']) ?? 'unknown' });
    case 'error':
    case 'session.error': {
      const error = isRecord(value['error']) ? value['error'] : value;
      return wrap({
        type: 'error',
        code: (text(error['code']) ?? 'error').slice(0, ERROR_TEXT_LIMIT),
        message: (text(error['message']) ?? 'Live error').slice(0, ERROR_TEXT_LIMIT),
      });
    }
    default:
      return null;
  }
}

const isEmotion = (value: unknown): value is LiveEmotion => typeof value === 'string' && (LIVE_EMOTIONS as readonly string[]).includes(value);

/**
 * `decision.event` с вложенным `event.type === 'decision.completed'` (форма: записка V0 §3). Ответ вопроса `expression` —
 * `event.decision.answers[].choice`, уверенность — `confidence`, расход — `event.decision.usage.input_tokens`.
 * Другой вложенный тип или нет `event.decision` — `null`: голос от этого не страдает, лицо остаётся спокойным.
 */
function parseDecision(value: Record<string, unknown>, wrap: (event: LiveEvent) => ParsedLiveEvent): ParsedLiveEvent | null {
  const inner = isRecord(value['event']) ? value['event'] : null;
  if (inner === null || inner['type'] !== 'decision.completed') return null;
  const decision = isRecord(inner['decision']) ? inner['decision'] : null;
  if (decision === null) return null;
  const usage = isRecord(decision['usage']) ? decision['usage'] : null;
  const tokens = usage === null ? null : finite(usage['input_tokens']);
  const inputTokens = tokens === null ? 0 : Math.max(0, Math.round(tokens));
  const answers = Array.isArray(decision['answers']) ? decision['answers'] : [];
  const answer = answers.find((item): item is Record<string, unknown> => isRecord(item) && item['name'] === 'expression');
  const choice = answer?.['choice'];
  const confidence = answer === undefined ? null : finite(answer['confidence']);
  if (!isEmotion(choice) || confidence === null) return wrap({ type: 'decisionRejected', inputTokens });
  return wrap({ type: 'emotion', value: choice, confidence, sourceEventId: text(value['source_event_id']), inputTokens });
}

export interface SourceOffsets {
  /** Запоминает конец фрагмента исходящего транскрипта (мс от старта сессии) под его `event_id`. */
  remember(eventId: string | null, endMs: number): void;
  /** Конец исходного фрагмента решения; `null` — фрагмент неизвестен (забыт или `source_event_id` нет). */
  endOf(eventId: string | null): number | null;
}

/** Окно ограничено: фрагменты по 200 мс, решение приходит через доли секунды, поэтому хватает короткой памяти. */
export function createSourceOffsets(capacity = 512): SourceOffsets {
  const ends = new Map<string, number>();
  return {
    remember(eventId, endMs) {
      if (eventId === null) return;
      ends.set(eventId, endMs);
      if (ends.size > capacity) {
        const oldest = ends.keys().next().value;
        if (oldest !== undefined) ends.delete(oldest);
      }
    },
    endOf: (eventId) => (eventId === null ? null : (ends.get(eventId) ?? null)),
  };
}

export interface EventDeduper {
  /** `true` — событие новое; повтор того же `event_id` — `false`. Событие без `event_id` всегда новое. */
  accept(eventId: string | null): boolean;
}

/** Помнит последние `capacity` идентификаторов; сессия живёт до 30 минут, поэтому окно ограничено. */
export function createEventDeduper(capacity = 2048): EventDeduper {
  const seen = new Set<string>();
  return {
    accept(eventId) {
      if (eventId === null) return true;
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      if (seen.size > capacity) {
        // Set хранит порядок вставки: первый элемент — самый старый.
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}

export type AppendKind = 'thinking' | 'commentary';

export interface AppendInput {
  kind: AppendKind;
  /** `null` — контекст всей сессии, без привязки к делегации. */
  delegationId: string | null;
  content: string;
  /** Идентификатор клиента: вернётся в `*.appended` как `client_event_id`. */
  eventId: string;
}

/** Исходящее `session.thinking.append` / `session.commentary.append` (форма из харнесса T0). */
export function buildAppend(input: AppendInput): Record<string, unknown> {
  return { type: `session.${input.kind}.append`, event_id: input.eventId, delegation_id: input.delegationId, content: input.content };
}
