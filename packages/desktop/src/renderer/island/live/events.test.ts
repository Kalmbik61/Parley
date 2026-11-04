import { describe, expect, it } from 'vitest';
import { buildAppend, createEventDeduper, parseLiveEvent } from './events.js';

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
