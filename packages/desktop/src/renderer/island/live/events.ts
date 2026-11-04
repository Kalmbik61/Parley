/**
 * События GPT-Live канала данных `oai-events` (чистый TS): разбор в типизированные события, дедупликация по `event_id`
 * и сборка исходящих `thinking.append` / `commentary.append`. Формы сверены с живыми журналами T0
 * (`docs/research/2026-11-04-gpt-live-transport-spike.md` §1, §2d, §2e). Тексты, аудио и ключ не логируются.
 *
 * Канал данных и sideband на хосте получают одни и те же события с одним `event_id`, поэтому дедуплицировать нужно по
 * `event_id` и здесь тоже (на случай повторной доставки по каналу).
 */

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
