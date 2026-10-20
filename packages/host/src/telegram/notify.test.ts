import { describe, expect, it } from 'vitest';
import type { Message, Room, SessionActivity, WorkEntry, WorkSession } from '@parley/core';
import type { SessionRef, WorksSnapshot } from '@parley/protocol';
import { activityTransition, emptyMemory, sessionWhere, worksTriggers } from './notify.js';

const ref: SessionRef = { projectPath: '/p/my_harnas', workId: 'w-01', sessionId: 's-01' };
const session = (lifecycle: WorkSession['lifecycle'] = 'active'): WorkSession => ({ id: 's-01', lifecycle, result: null }) as unknown as WorkSession;
const live = (activity: SessionActivity['activity']): SessionActivity => ({ activity }) as SessionActivity;

describe('activityTransition', () => {
  it('первое значение — база', () => {
    expect(activityTransition(emptyMemory(), ref, session(), live('blocked'))).toBeNull();
  });
  it('idle → blocked → needs-you, повтор blocked → null', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('idle'));
    expect(activityTransition(memory, ref, session(), live('blocked'))).toBe('needs-you');
    expect(activityTransition(memory, ref, session(), live('blocked'))).toBeNull();
  });
  it('working → unseen → unseen', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('working'));
    expect(activityTransition(memory, ref, session(), live('unseen'))).toBe('unseen');
  });
  it('переход в working и idle поводом не является', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('blocked'));
    expect(activityTransition(memory, ref, session(), live('working'))).toBeNull();
    expect(activityTransition(memory, ref, session(), live('idle'))).toBeNull();
  });
  it('закрытая сессия не даёт повода', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('idle'));
    expect(activityTransition(memory, ref, session('closed'), live('blocked'))).toBeNull();
  });
});

const message = (id: string, over: Partial<Message> = {}): Message =>
  ({ id, roomId: null, from: 's-01', to: ['human'], at: '2026-10-20T10:00:00Z', text: 'hello', kind: 'note', readBy: {}, ...over }) as Message;
const room = (over: Partial<Room> = {}): Room => ({ id: 'r-01', title: 'Auth', members: ['s-01'], proposal: null, ...over }) as Room;
const entry = (messages: Message[] = [], rooms: Room[] = []): WorkEntry =>
  ({ projectPath: '/p/my_harnas', map: { work: { id: 'w-01', title: 'Parley' }, sessions: [], messages, rooms } }) as unknown as WorkEntry;
const snap = (e: WorkEntry): WorksSnapshot => ({ entries: [e], branches: {} });
const slot = (id: string, rev: number): NonNullable<Room['proposal']> => ({ id, from: 's-01', text: 'go', rev, at: '2026-10-20T10:00:00Z' });

describe('worksTriggers: письма', () => {
  it('первый снимок — база без поводов', () => {
    const triggers = worksTriggers(emptyMemory(), snap(entry([message('m-01')], [room({ proposal: slot('p-01', 0) })])));
    expect(triggers).toEqual({ letters: [], decisions: [], closed: [] });
  });
  it('новое письмо и @human в комнате появляются один раз', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry()));
    const mention = message('m-02', { roomId: 'r-01', to: [], text: 'ping @human please' });
    const next = snap(entry([message('m-01'), mention], [room()]));
    expect(worksTriggers(memory, next).letters.map((l) => l.message.id)).toEqual(['m-01', 'm-02']);
    expect(worksTriggers(memory, next).letters).toEqual([]);
  });
  it('прочитанное и своё письмо поводом не служит', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry()));
    const read = message('m-01', { readBy: { human: '2026-10-20T10:01:00Z' } });
    const mine = message('m-02', { from: 'human', to: ['s-01'] });
    expect(worksTriggers(memory, snap(entry([read, mine]))).letters).toEqual([]);
  });
});

describe('worksTriggers: решения', () => {
  it('новый слот → new', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room()])));
    const triggers = worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    expect(triggers.decisions.map((d) => d.change)).toEqual(['new']);
    expect(worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })]))).decisions).toEqual([]);
  });
  it('тот же id с rev+1 → revised и closed.now === revised', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const triggers = worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 1) })])));
    expect(triggers.decisions.map((d) => d.change)).toEqual(['revised']);
    expect(triggers.closed.map((c) => [c.now, c.previous])).toEqual([['revised', { id: 'p-01', rev: 0 }]]);
  });
  it('слот исчез после «Decision accepted.» → accepted', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const letter = message('m-09', { roomId: 'r-01', from: 'human', to: ['s-01'], text: 'Decision accepted.' });
    const triggers = worksTriggers(memory, snap(entry([letter], [room()])));
    expect(triggers.closed.map((c) => [c.roomId, c.now])).toEqual([['r-01', 'accepted']]);
    expect(worksTriggers(memory, snap(entry([letter], [room()]))).closed).toEqual([]);
  });
  it('слот исчез после возврата → returned, без письма → gone', () => {
    const returned = emptyMemory();
    worksTriggers(returned, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const letter = message('m-09', { roomId: 'r-01', from: 'human', to: ['s-01'], text: 'Returned for rework: no' });
    expect(worksTriggers(returned, snap(entry([letter], [room()]))).closed[0]?.now).toBe('returned');

    const gone = emptyMemory();
    worksTriggers(gone, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    expect(worksTriggers(gone, snap(entry([], [room()]))).closed[0]?.now).toBe('gone');
  });
});

describe('sessionWhere', () => {
  it('название работы и папка проекта', () => {
    expect(sessionWhere(entry())).toBe('Parley · my_harnas');
  });
});
