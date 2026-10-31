import { describe, expect, it } from 'vitest';
import { initialRemoteState, reduce, actionFromEvent, sessionKey, workKeyOf } from '../src/index.js';
import { PROJECT, activityItem, live, ref, session, snap, work } from './fixtures.js';

const status = (epoch: string | null, host: 'online' | 'starting' = 'online') => ({ t: 'bridge.status' as const, host, epoch });

describe('reducer: снимок по (epoch, revision)', () => {
  it('старый revision той же эпохи не откатывает новый', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, { t: 'snapshot', snapshot: snap(5, [work('w-1', { title: 'new' })]) });
    s = reduce(s, { t: 'snapshot', snapshot: snap(3, [work('w-1', { title: 'old' })]) });
    expect(s.snapshot?.revision).toBe(5);
    expect(s.snapshot?.works[0]?.title).toBe('new');
    s = reduce(s, { t: 'snapshot', snapshot: snap(6, [work('w-1', { title: 'newer' })]) });
    expect(s.snapshot?.works[0]?.title).toBe('newer');
  });

  it('другая epoch сбрасывает состояние, и снимок с меньшим revision применяется', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, { t: 'snapshot', snapshot: snap(50, [work('w-1')]) });
    s = reduce(s, { t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-1'), 'blocked')] });
    expect(Object.keys(s.activity)).toHaveLength(1);
    s = reduce(s, status('e2'));
    expect(s.epoch).toBe('e2');
    expect(s.snapshot).toBeNull();
    expect(s.activity).toEqual({});
    s = reduce(s, { t: 'snapshot', snapshot: snap(2, [work('w-9')]) });
    expect(s.snapshot?.revision).toBe(2);
  });

  it('тот же статус той же эпохи состояние не пересоздаёт, смена host — меняет только статус', () => {
    const s = reduce(initialRemoteState(), status('e1'));
    expect(reduce(s, status('e1'))).toBe(s);
    const off = reduce(s, status('e1', 'starting'));
    expect(off.hostStatus).toBe('starting');
    expect(off.epoch).toBe('e1');
  });

  it('снимок ответа другой эпохи не применяется', () => {
    const s = reduce(initialRemoteState(), status('e2'));
    expect(reduce(s, { t: 'snapshot', snapshot: snap(1, []), epoch: 'e1' })).toBe(s);
  });
});

describe('reducer: активность', () => {
  it('activity.snapshot заменяет карту целиком, activity.changed правит по ref', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, { t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-1'), 'working'), activityItem(ref('s-2'), 'idle'), { junk: 1 }] });
    expect(Object.keys(s.activity).sort()).toEqual([sessionKey(ref('s-1')), sessionKey(ref('s-2'))].sort());
    s = reduce(s, { t: 'activity.changed', ref: ref('s-1'), activity: live('blocked'), metrics: null });
    expect(s.activity[sessionKey(ref('s-1'))]?.activity.activity).toBe('blocked');
    s = reduce(s, { t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-3'), 'idle')] });
    expect(Object.keys(s.activity)).toEqual([sessionKey(ref('s-3'))]);
  });

  it('activity.snapshot другой эпохи не применяется', () => {
    const s = reduce(initialRemoteState(), status('e2'));
    expect(reduce(s, { t: 'activity.snapshot', epoch: 'e1', items: [activityItem(ref('s-1'), 'idle')] })).toBe(s);
  });
});

describe('reducer: письма и разбор кадров', () => {
  const letter = (id: string, over: object = {}) => ({
    id,
    roomId: null,
    from: 's-1',
    to: ['human'],
    at: '2026-10-31T10:00:00.000Z',
    text: `text ${id}`,
    kind: 'note',
    readBy: {},
    ...over,
  });
  const mail = (letters: object[], extra: object = {}) => ({
    projectPath: PROJECT,
    workId: 'w-1',
    version: 2,
    prevVersion: 1,
    updatedAt: 'x',
    rooms: [{ roomId: null, prevTop: 0, top: 1, total: 1, lastAt: null, letters, reads: [], deleted: [], ...extra }],
    droppedRooms: [],
    unread: { letters: letters.length, rooms: {} },
  });

  it('rooms.mail добавляет письма, отметки прочтения и удаления, счётчик — абсолютный', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, actionFromEvent('rooms.mail', mail([letter('m-1'), letter('m-2')]))!);
    const key = workKeyOf(PROJECT, 'w-1');
    expect(Object.keys(s.letters[key] ?? {})).toEqual(['m-1', 'm-2']);
    expect(s.letterUnread[key]).toBe(2);
    s = reduce(s, actionFromEvent('rooms.mail', { ...mail([]), rooms: [{ ...mail([]).rooms[0], reads: [{ id: 'm-1', reader: 'human', at: 'now' }], deleted: ['m-2'] }], unread: { letters: 0, rooms: {} } })!);
    expect(s.letters[key]?.['m-1']?.readBy.human).toBe('now');
    expect(s.letters[key]?.['m-2']).toBeUndefined();
    expect(s.letterUnread[key]).toBe(0);
  });

  it('страница context.messages комнаты на прямые письма не влияет; страница прямых — добавляет', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, { t: 'messages', projectPath: PROJECT, workId: 'w-1', roomId: 'r-1', messages: [letter('m-1', { roomId: 'r-1' }) as never] });
    expect(s.letters).toEqual({});
    s = reduce(s, { t: 'messages', projectPath: PROJECT, workId: 'w-1', roomId: null, messages: [letter('m-3') as never] });
    expect(Object.keys(s.letters[workKeyOf(PROJECT, 'w-1')] ?? {})).toEqual(['m-3']);
  });

  it('works.changed разбирается схемой проекции; мусор и чужие события — null', () => {
    expect(actionFromEvent('works.changed', { revision: 1, works: [{ nope: 1 }] })).toBeNull();
    expect(actionFromEvent('works.changed', snap(4, [work('w-1', { sessions: [session('s-1')] })]))?.t).toBe('snapshot');
    expect(actionFromEvent('host.notice', {})).toBeNull();
    expect(actionFromEvent('bridge.status', { host: 'nope', epoch: null })).toBeNull();
  });

  it('счётчик direct.unread снимка попадает в letterUnread', () => {
    let s = reduce(initialRemoteState(), status('e1'));
    s = reduce(s, { t: 'snapshot', snapshot: snap(1, [work('w-1', { messages: { direct: { total: 3, unread: 2 }, inline: 0 } })]) });
    expect(s.letterUnread[workKeyOf(PROJECT, 'w-1')]).toBe(2);
  });
});
