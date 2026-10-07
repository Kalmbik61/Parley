import { describe, expect, it } from 'vitest';
import { addMessage, addRoom, addSession, compactWorkMap } from '@parley/core';
import type { WorkMap } from '@parley/core';
import { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, contextPageMethodSchemas } from './context-pages.js';
import { LineDecoder, LineTooLongError, MAX_LINE_BYTES, encodeLine, parseIncoming } from './framing.js';
import { METHODS } from './methods.js';
import type { WorksSnapshot } from './types.js';

const messages = contextPageMethodSchemas['context.messages'];
const text = contextPageMethodSchemas['context.text'];
const location = { projectPath: '/p', workId: 'w-0001' };

describe('страницы переписки: методы окна', () => {
  it('методы входят в общую таблицу протокола, hello принимает features', () => {
    expect(Object.keys(METHODS)).toEqual(expect.arrayContaining(['context.messages', 'context.text']));
    const hello = METHODS.hello;
    expect(hello.safeParse({ token: 't', protocol: 1, client: 'desktop', features: [COMPACT_WORKS_FEATURE] }).success).toBe(true);
    expect(hello.safeParse({ token: 't', protocol: 1, client: 'desktop' }).success).toBe(true);
    expect(hello.safeParse({ token: 't', protocol: 1, client: 'desktop', features: [1] }).success).toBe(false);
  });

  it('context.messages: комната или прямые письма, курсор before/after, размер страницы в пределах', () => {
    expect(messages.safeParse({ ...location, roomId: 'r-01' }).success).toBe(true);
    expect(messages.safeParse({ ...location, roomId: null, cursor: 'before:12', maxBytes: 65536 }).success).toBe(true);
    expect(messages.safeParse({ ...location, roomId: 'r-01', cursor: 'after:0' }).success).toBe(true);
    for (const bad of [
      { roomId: 'room' }, { roomId: undefined }, { roomId: 'r-01', cursor: '12' }, { roomId: 'r-01', cursor: 'before:-1' },
      { roomId: 'r-01', maxBytes: 100 }, { roomId: 'r-01', maxBytes: 10 ** 7 }, { roomId: 'r-01', maxBytes: 1.5 }, { roomId: 'r-01', extra: 1 },
    ]) expect(messages.safeParse({ ...location, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(messages.safeParse({ projectPath: '', workId: 'w-1', roomId: null }).success).toBe(false);
    expect(messages.safeParse({ projectPath: '/p\0', workId: 'w-1', roomId: null }).success).toBe(false);
  });

  it('context.text: письмо, цель или поле сессии; курсор несёт хеш текста', () => {
    expect(text.safeParse({ ...location, ref: { kind: 'message', id: 'm-12' } }).success).toBe(true);
    expect(text.safeParse({ ...location, ref: { kind: 'goal' }, cursor: 'offset:100:0123456789ab' }).success).toBe(true);
    expect(text.safeParse({ ...location, ref: { kind: 'session', sessionId: 's-02', field: 'summary' } }).success).toBe(true);
    for (const bad of [
      { ref: { kind: 'session', sessionId: 's-02', field: 'label' } }, { ref: { kind: 'message', id: 'x' } },
      { ref: { kind: 'goal' }, cursor: 'offset:100' }, { ref: { kind: 'path', path: '/etc/passwd' } },
    ]) expect(text.safeParse({ ...location, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

/** Карта с перепиской, как в воспроизведениях аудита A14. */
function bigMap(count: number, size: number, init: { kind?: 'decision' } = {}): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: { id: 'w-0001', title: 'Работа', goal: 'Цель', status: 'active', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' },
    sessions: [],
    messages: [],
    rooms: [],
  };
  addSession(map, { provider: 'claude', label: 'план', task: 'x' });
  addSession(map, { provider: 'claude', label: 'код', task: 'y', parent: 's-01' });
  addRoom(map, { title: 'Комната', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
  for (let i = 0; i < count; i += 1) addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(size, 'x'), ...init });
  return map;
}

const snapshotOf = (maps: WorkMap[]): WorksSnapshot => ({ entries: maps.map((map) => ({ projectPath: '/p', map })), branches: {}, revision: 1 });

describe('рамки: снимок работ и предел кадра', () => {
  const overflow = (data: WorksSnapshot): void => {
    expect(() => new LineDecoder().push(Buffer.from(encodeLine({ event: 'works.changed', data })))).toThrow(LineTooLongError);
  };
  const through = (data: WorksSnapshot): unknown => {
    const line = encodeLine({ event: 'works.changed', data });
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_LINE_BYTES);
    // Кадр режется на куски по 64 КиБ, как на сокете.
    const decoder = new LineDecoder();
    const buffer = Buffer.from(line);
    let decoded: unknown[] = [];
    for (let at = 0; at < buffer.length; at += 65536) decoded = decoded.concat(decoder.push(buffer.subarray(at, at + 65536)));
    return decoded[0];
  };

  it('воспроизведение 1 (900 писем по 10 000 знаков): полный снимок рвёт декодер, компактный проходит и разбирается', () => {
    const map = bigMap(900, 10_000);
    overflow(snapshotOf([map]));
    const compact = snapshotOf([compactWorkMap(map, { messageBytes: 512 * 1024 })]);
    const event = through(compact) as { event: string; data: WorksSnapshot };
    expect(event.event).toBe('works.changed');
    expect(event.data.entries[0]?.map.compact?.messages.total).toBe(900);
    expect(event.data.revision).toBe(1);
  });

  it('воспроизведение 2 (2 100 решений по 4 000 знаков): то же', () => {
    const map = bigMap(2100, 4000, { kind: 'decision' });
    overflow(snapshotOf([map]));
    through(snapshotOf([compactWorkMap(map, { messageBytes: 512 * 1024 })]));
  });

  it('10 тыс. писем в нескольких работах: компактные снимки входят в кадр с большим запасом, предел для старых клиентов ниже кадра', () => {
    const maps = [0, 1, 2, 3].map(() => bigMap(2500, 1500));
    overflow(snapshotOf(maps));
    const compact = snapshotOf(maps.map((map) => compactWorkMap(map, { messageBytes: 512 * 1024 })));
    const bytes = Buffer.byteLength(encodeLine({ event: 'works.changed', data: compact }));
    expect(bytes).toBeLessThan(MAX_LINE_BYTES / 2);
    through(compact);
    expect(LEGACY_SNAPSHOT_MAX_BYTES).toBeLessThan(MAX_LINE_BYTES);
  });

  it('запрос страницы проходит разбор рамки как обычный запрос', () => {
    const parsed = parseIncoming({ id: 7, method: 'context.messages', params: { ...location, roomId: 'r-01', cursor: 'before:20' } });
    expect(parsed.kind).toBe('request');
    const bad = parseIncoming({ id: 8, method: 'context.messages', params: { ...location, roomId: 'r-01', cursor: 'sideways' } });
    expect(bad.kind).toBe('invalid');
  });
});
