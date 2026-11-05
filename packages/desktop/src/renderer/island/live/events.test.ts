import { describe, expect, it } from 'vitest';
import { buildAppend, createEventDeduper, createSourceOffsets, parseLiveEvent } from './events.js';

/** Целое `decision.event` из записки V0 §3 (реальный ответ OpenAI), без изменений формы. */
const V0_DECISION = {
  event_id: 'event_EglMw70ZSJ5OMyrf2J0R6',
  type: 'decision.event',
  delegation_id: null,
  event: {
    type: 'decision.completed',
    decision: {
      model: 'gpt-6-luna',
      answers: [
        {
          type: 'choice',
          name: 'expression',
          choice: 'joy',
          probabilities: [
            { value: 'calm', probability: 0.02 },
            { value: 'joy', probability: 0.98 },
            { value: 'sad', probability: 0 },
            { value: 'surprise', probability: 0 },
            { value: 'anger', probability: 0 },
          ],
          confidence: 0.98,
        },
      ],
      usage: { input_tokens: 165, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 165 },
    },
  },
  source_event_id: 'event_EglMwXrcElK0HEaTEwiko',
  source_event_type: 'session.output_transcript.delta',
  trigger_id: 'trg_EglMwv29MKYZrth8dZVml',
};


describe('parseLiveEvent', () => {
  it('session.delegation.created: id, offset_ms и event_id', () => {
    const raw = { type: 'session.delegation.created', offset_ms: 5600, delegation: { id: 'item_1', type: 'delegation', target: 'client' }, event_id: 'event_a' };
    expect(parseLiveEvent(raw)).toEqual({ eventId: 'event_a', event: { type: 'delegationCreated', delegationId: 'item_1', offsetMs: 5600 } });
  });

  it('принимает строку JSON; битая строка и не-объект — null', () => {
    expect(parseLiveEvent(JSON.stringify({ type: 'session.closed', reason: 'close_requested', event_id: 'e' }))).toEqual({ eventId: 'e', event: { type: 'sessionClosed', reason: 'close_requested' } });
    expect(parseLiveEvent('{not json')).toBeNull();
    expect(parseLiveEvent('[]')).toBeNull();
    expect(parseLiveEvent(42)).toBeNull();
    expect(parseLiveEvent({})).toBeNull();
  });

  it('делегация без id или offset_ms — null', () => {
    expect(parseLiveEvent({ type: 'session.delegation.created', offset_ms: 1, delegation: {} })).toBeNull();
    expect(parseLiveEvent({ type: 'session.delegation.created', delegation: { id: 'x' } })).toBeNull();
  });

  it('фрагменты транскрипта хранят текст как есть, без обрезки пробелов', () => {
    expect(parseLiveEvent({ type: 'session.input_transcript.delta', start_ms: 2800, end_ms: 3000, delta: ' Please', event_id: 'i1' })).toEqual({
      eventId: 'i1',
      event: { type: 'inputTranscript', text: ' Please', startMs: 2800, endMs: 3000 },
    });
    expect(parseLiveEvent({ type: 'session.output_transcript.delta', start_ms: 6000, end_ms: 6200, delta: ' Okay,' })).toEqual({
      eventId: null,
      event: { type: 'outputTranscript', text: ' Okay,', startMs: 6000, endMs: 6200 },
    });
    expect(parseLiveEvent({ type: 'session.input_transcript.delta', start_ms: 1, delta: 'x' })).toBeNull();
  });

  it('appended, usage, started', () => {
    expect(parseLiveEvent({ type: 'session.thinking.appended', client_event_id: 'p1_1', event_id: 'a' })?.event).toEqual({ type: 'appended', kind: 'thinking', clientEventId: 'p1_1' });
    expect(parseLiveEvent({ type: 'session.commentary.appended', event_id: 'b' })?.event).toEqual({ type: 'appended', kind: 'commentary', clientEventId: null });
    expect(parseLiveEvent({ type: 'session.usage.updated', usage: { seconds: 15 } })?.event).toEqual({ type: 'usage', seconds: 15 });
    expect(parseLiveEvent({ type: 'session.usage.updated', usage: {} })).toBeNull();
    expect(parseLiveEvent({ type: 'session.started', session: { id: 'live_x', expires_at: 1793827006, instructions: 'secret prompt' } })?.event).toEqual({ type: 'sessionStarted', expiresAt: 1793827006 });
  });

  it('ошибка: код и сообщение обрезаются', () => {
    const long = 'x'.repeat(500);
    const parsed = parseLiveEvent({ type: 'error', error: { code: 'bad', message: long } });
    expect(parsed?.event).toEqual({ type: 'error', code: 'bad', message: 'x'.repeat(200) });
    expect(parseLiveEvent({ type: 'session.error', message: 'boom' })?.event).toEqual({ type: 'error', code: 'error', message: 'boom' });
  });

  it('неизвестный тип — null', () => {
    expect(parseLiveEvent({ type: 'session.something.new', event_id: 'z' })).toBeNull();
  });
});

describe('parseLiveEvent: decision.event (V2)', () => {
  const withAnswers = (answers: unknown[]) => ({ ...V0_DECISION, event: { ...V0_DECISION.event, decision: { ...V0_DECISION.event.decision, answers } } });

  it('V0-событие: эмоция, уверенность, id исходного фрагмента и входные токены Decisions', () => {
    expect(parseLiveEvent(V0_DECISION)).toEqual({
      eventId: 'event_EglMw70ZSJ5OMyrf2J0R6',
      event: { type: 'emotion', value: 'joy', confidence: 0.98, sourceEventId: 'event_EglMwXrcElK0HEaTEwiko', inputTokens: 165 },
    });
    expect(parseLiveEvent(JSON.stringify(V0_DECISION))?.event.type).toBe('emotion');
  });

  it('принимаются ровно пять значений; остальные — decisionRejected с токенами', () => {
    for (const value of ['calm', 'joy', 'sad', 'surprise', 'anger']) {
      expect(parseLiveEvent(withAnswers([{ name: 'expression', choice: value, confidence: 0.7 }]))?.event).toMatchObject({ type: 'emotion', value });
    }
    for (const value of ['error', 'fear', '', 7, null]) {
      expect(parseLiveEvent(withAnswers([{ name: 'expression', choice: value, confidence: 0.9 }]))?.event).toEqual({ type: 'decisionRejected', inputTokens: 165 });
    }
  });

  it('ответ берётся по name === expression; чужие ответы и пустой список не годятся', () => {
    const other = { name: 'other', choice: 'sad', confidence: 0.9 };
    expect(parseLiveEvent(withAnswers([other, { name: 'expression', choice: 'surprise', confidence: 0.6 }]))?.event).toMatchObject({ type: 'emotion', value: 'surprise', confidence: 0.6 });
    expect(parseLiveEvent(withAnswers([other]))?.event).toEqual({ type: 'decisionRejected', inputTokens: 165 });
    expect(parseLiveEvent(withAnswers([]))?.event).toEqual({ type: 'decisionRejected', inputTokens: 165 });
  });

  it('ответ без числовой уверенности — decisionRejected; usage нет — токены 0', () => {
    const raw = { ...V0_DECISION, event: { type: 'decision.completed', decision: { answers: [{ name: 'expression', choice: 'joy' }] } } };
    expect(parseLiveEvent(raw)?.event).toEqual({ type: 'decisionRejected', inputTokens: 0 });
  });

  it('другой вложенный тип и битая форма — null; нет source_event_id — sourceEventId null', () => {
    expect(parseLiveEvent({ ...V0_DECISION, event: { type: 'decision.failed' } })).toBeNull();
    expect(parseLiveEvent({ ...V0_DECISION, event: { type: 'decision.completed' } })).toBeNull();
    expect(parseLiveEvent({ ...V0_DECISION, event: 'oops' })).toBeNull();
    expect(parseLiveEvent({ type: 'decision.event' })).toBeNull();
    const withoutSource: Record<string, unknown> = { ...V0_DECISION };
    delete withoutSource['source_event_id'];
    expect(parseLiveEvent(withoutSource)?.event).toMatchObject({ type: 'emotion', sourceEventId: null });
  });

  it('дедупликация по внешнему event_id: два канала дают одно решение', () => {
    const dedupe = createEventDeduper();
    expect(dedupe.accept(parseLiveEvent(V0_DECISION)?.eventId ?? null)).toBe(true);
    expect(dedupe.accept(parseLiveEvent(V0_DECISION)?.eventId ?? null)).toBe(false);
  });
});

describe('createSourceOffsets', () => {
  it('помнит end_ms фрагмента по event_id; неизвестный и null — null', () => {
    const offsets = createSourceOffsets();
    offsets.remember('event_a', 6000);
    offsets.remember(null, 1);
    expect(offsets.endOf('event_a')).toBe(6000);
    expect(offsets.endOf('event_b')).toBeNull();
    expect(offsets.endOf(null)).toBeNull();
  });

  it('окно ограничено: самый старый фрагмент забывается', () => {
    const offsets = createSourceOffsets(2);
    offsets.remember('a', 1);
    offsets.remember('b', 2);
    offsets.remember('c', 3);
    expect(offsets.endOf('a')).toBeNull();
    expect(offsets.endOf('c')).toBe(3);
  });
});

describe('createEventDeduper', () => {
  it('повтор того же event_id (канал данных и sideband) отсекается', () => {
    const dedupe = createEventDeduper();
    expect(dedupe.accept('event_1')).toBe(true);
    expect(dedupe.accept('event_1')).toBe(false);
    expect(dedupe.accept('event_2')).toBe(true);
  });

  it('событие без event_id всегда проходит', () => {
    const dedupe = createEventDeduper();
    expect(dedupe.accept(null)).toBe(true);
    expect(dedupe.accept(null)).toBe(true);
  });

  it('окно ограничено: самый старый id забывается', () => {
    const dedupe = createEventDeduper(2);
    dedupe.accept('a');
    dedupe.accept('b');
    dedupe.accept('c');
    expect(dedupe.accept('b')).toBe(false);
    expect(dedupe.accept('a')).toBe(true);
  });
});

describe('buildAppend', () => {
  it('thinking и commentary с delegation_id; null — контекст сессии', () => {
    expect(buildAppend({ kind: 'thinking', delegationId: 'item_1', content: 'Progress', eventId: 'p_1' })).toEqual({
      type: 'session.thinking.append',
      event_id: 'p_1',
      delegation_id: 'item_1',
      content: 'Progress',
    });
    expect(buildAppend({ kind: 'commentary', delegationId: null, content: '', eventId: 'c_1' })).toEqual({ type: 'session.commentary.append', event_id: 'c_1', delegation_id: null, content: '' });
  });
});
