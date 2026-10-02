import { describe, expect, it } from 'vitest';
import type { Message, Proposal, Room, SessionActivity, WorkEntry, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { ActivityEntry } from '../store/activity.js';
import {
  ATTENTION_RANK,
  humanUnreadLetters,
  isHumanUnread,
  roomAwaitsDecision,
  roomDecisionReturned,
  roomUnreadForHuman,
  sessionAttention,
  workAttention,
} from './derive.js';

function session(id: string, lifecycle: WorkSession['lifecycle'] = 'active'): WorkSession {
  return {
    id,
    provider: 'claude',
    label: id,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle,
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
  };
}

function live(activity: SessionActivity['activity'], lastEventAt: string | null = null): SessionActivity {
  return {
    activity,
    subagents: 0,
    turnEndedAt: null,
    lastEventAt,
    source: 'hooks',
    exited: false,
    hooksMissing: false,
  };
}

function letter(over: Partial<Message> & Pick<Message, 'id' | 'from' | 'to'>): Message {
  return { roomId: null, at: '2026-09-27T10:00:00.000Z', text: '', kind: 'note', readBy: {}, ...over };
}

function entry(sessions: WorkSession[], messages: Message[] = [], updatedAt = '2026-09-27T09:00:00.000Z'): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      work: { id: 'work-01', title: 'W', goal: '', status: 'active', createdAt: updatedAt, updatedAt },
      sessions,
      messages,
      rooms: [{ id: 'r-01', title: 'R', creator: 'human', members: ['s-01', 's-02'], createdAt: updatedAt }],
    },
  };
}

function activityOf(e: WorkEntry, byId: Record<string, SessionActivity>): Record<string, ActivityEntry> {
  const out: Record<string, ActivityEntry> = {};
  for (const [sessionId, activity] of Object.entries(byId)) {
    const ref = { projectPath: e.projectPath, workId: e.map.work.id, sessionId };
    out[refKey(ref)] = { ref, activity, metrics: null };
  }
  return out;
}

describe('sessionAttention (1)', () => {
  it('таблица 7.1', () => {
    expect(sessionAttention(session('s-01', 'closed'), live('blocked'))).toBe('off');
    expect(sessionAttention(session('s-01', 'pending'), null)).toBe('idle');
    expect(sessionAttention(session('s-01', 'sleeping'), live('working'))).toBe('idle');
    expect(sessionAttention(session('s-01'), null)).toBe('idle');
    expect(sessionAttention(session('s-01'), live('blocked'))).toBe('needs-you');
    expect(sessionAttention(session('s-01'), live('unseen'))).toBe('unseen');
    expect(sessionAttention(session('s-01'), live('working'))).toBe('working');
    expect(sessionAttention(session('s-01'), live('idle'))).toBe('idle');
  });

  it('ранги 4..0', () => {
    expect(ATTENTION_RANK).toEqual({ 'needs-you': 4, unseen: 3, working: 2, idle: 1, off: 0 });
  });
});

// Тест 7 куска 4.2: таблица случаев теста 1 куска 4.1 (`markHumanRead` в core) дословно —
// рантайм core окну недоступен, общего модуля нет, и правило должно совпадать с хостом.
describe('isHumanUnread (7 куска 4.2)', () => {
  it('таблица случаев «непрочитано человеком» теста 1 куска 4.1', () => {
    // письмо S01 человеку → непрочитано; после отметки — уже нет
    expect(isHumanUnread(letter({ id: 'm1', from: 's-01', to: ['human'] }))).toBe(true);
    expect(isHumanUnread(letter({ id: 'm1', from: 's-01', to: ['human'], readBy: { human: '2026-09-27T11:00:00.000Z' } }))).toBe(false);
    // письмо S01 человеку и S02, прочитанное S02, но не человеком → непрочитано
    expect(
      isHumanUnread(letter({ id: 'm2', from: 's-01', to: ['human', 's-02'], readBy: { 's-02': '2026-09-27T11:00:00.000Z' } })),
    ).toBe(true);
    // письмо S01 агенту S02 → не человеку
    expect(isHumanUnread(letter({ id: 'm3', from: 's-01', to: ['s-02'] }))).toBe(false);
    // сообщение комнаты от S02 → непрочитано; от человека → нет
    expect(isHumanUnread(letter({ id: 'm4', from: 's-02', to: [], roomId: 'r-01' }))).toBe(true);
    expect(isHumanUnread(letter({ id: 'm5', from: 'human', to: [], roomId: 'r-01' }))).toBe(false);
    // письмо человека агенту S01 → нет
    expect(isHumanUnread(letter({ id: 'm6', from: 'human', to: ['s-01'] }))).toBe(false);
  });
});

describe('humanUnreadLetters (2)', () => {
  it('считает только непрочитанные письма человеку не от человека', () => {
    const e = entry(
      [],
      [
        letter({ id: 'm1', from: 's-01', to: ['s-02'] }),
        letter({ id: 'm2', from: 's-01', to: ['human'] }),
        letter({ id: 'm3', from: 's-01', to: ['human'], readBy: { human: '2026-09-27T11:00:00.000Z' } }),
        letter({ id: 'm4', from: 'human', to: ['human', 's-01'] }),
        letter({ id: 'm5', from: 's-01', to: ['human'], roomId: 'r-01' }),
      ],
    );
    expect(humanUnreadLetters(e.map).map((m) => m.id)).toEqual(['m2']);
  });
});

describe('roomUnreadForHuman (3)', () => {
  it('сообщение сессии — 1, человека — 0, прочитанное — 0', () => {
    const fromAgent = letter({ id: 'm1', from: 's-01', to: [], roomId: 'r-01' });
    expect(roomUnreadForHuman(entry([], [fromAgent]).map, 'r-01')).toBe(1);
    expect(roomUnreadForHuman(entry([], [letter({ id: 'm2', from: 'human', to: [], roomId: 'r-01' })]).map, 'r-01')).toBe(0);
    const read = { ...fromAgent, readBy: { human: '2026-09-27T11:00:00.000Z' } };
    expect(roomUnreadForHuman(entry([], [read]).map, 'r-01')).toBe(0);
    expect(roomUnreadForHuman(entry([], [fromAgent]).map, 'r-02')).toBe(0);
  });
});

describe('workAttention (4)', () => {
  it('blocked + unseen → needs-you, счётчики по сессиям', () => {
    const e = entry([session('s-01'), session('s-02'), session('s-03')]);
    const a = workAttention(e, activityOf(e, { 's-01': live('blocked'), 's-02': live('unseen'), 's-03': live('working') }));
    expect(a.level).toBe('needs-you');
    expect(a.needsYou).toBe(1);
    expect(a.unseen).toBe(1);
    expect(a.humanUnread).toBe(0);
    expect(a.roomsUnread).toEqual({});
  });

  it('только письмо человеку → unseen (ранг 3, спека 2.7), а не needs-you', () => {
    const e = entry([], [letter({ id: 'm1', from: 's-01', to: ['human'] })]);
    const a = workAttention(e, {});
    expect(a.level).toBe('unseen');
    expect(ATTENTION_RANK[a.level]).toBe(3);
    expect(a.humanUnread).toBe(1);
    expect(a.needsYou).toBe(0);
  });

  it('непрочитанная комната уровень не поднимает', () => {
    const e = entry([session('s-01')], [letter({ id: 'm1', from: 's-01', to: [], roomId: 'r-01' })]);
    const a = workAttention(e, activityOf(e, { 's-01': live('working') }));
    expect(a.level).toBe('working');
    expect(a.roomsUnread).toEqual({ 'r-01': 1 });
  });

  it('без сессий и писем — off', () => {
    expect(workAttention(entry([]), {}).level).toBe('off');
  });

  it('lastEventAt — максимум сессий, updatedAt и последнего письма', () => {
    const e = entry([session('s-01')], [letter({ id: 'm1', from: 's-01', to: ['s-02'], at: '2026-09-27T12:00:00.000Z' })]);
    expect(workAttention(e, {}).lastEventAt).toBe('2026-09-27T12:00:00.000Z');
    const withLive = activityOf(e, { 's-01': live('idle', '2026-09-27T13:00:00.000Z') });
    expect(workAttention(e, withLive).lastEventAt).toBe('2026-09-27T13:00:00.000Z');
    expect(workAttention(entry([]), {}).lastEventAt).toBe('2026-09-27T09:00:00.000Z');
  });

  it('не-ISO время письма или сессии не становится lastEventAt', () => {
    for (const bad of ['w-9999', 's-01', '', 'garbage']) {
      const e = entry([session('s-01')], [letter({ id: 'm1', from: 's-01', to: ['s-02'], at: bad })]);
      const withLive = activityOf(e, { 's-01': live('idle', bad) });
      expect(workAttention(e, withLive).lastEventAt).toBe('2026-09-27T09:00:00.000Z');
    }
  });

  it('битый updatedAt уступает любому ISO; ISO с +00:00 сравнивается как время', () => {
    const e = entry([], [letter({ id: 'm1', from: 's-01', to: ['s-02'], at: '2026-09-27T08:00:00+00:00' })], 'w-9999');
    expect(workAttention(e, {}).lastEventAt).toBe('2026-09-27T08:00:00+00:00');
    const later = entry([], [letter({ id: 'm1', from: 's-01', to: ['s-02'], at: '2026-09-27T09:00:01+00:00' })]);
    expect(workAttention(later, {}).lastEventAt).toBe('2026-09-27T09:00:01+00:00');
  });
});

// Спека окна 2026-09-29, 2.7: комната с ждущим решением — ранг 4 «нужен ты», как blocked; непрочитанная
// почта человеку — ранг 3 (в прототипе handoff `workRank`: письмо — max(r, 3), решение — max(r, 4)).
describe('roomAwaitsDecision (2.7)', () => {
  const base: Room = { id: 'r-01', title: 'R', creator: 'human', members: ['s-01'], createdAt: '2026-09-29T09:00:00.000Z', lead: null, proposal: null };
  const proposal: Proposal = { id: 'p-01', from: 's-01', text: 'Возврат больше суммы — ошибка', rev: 0, at: '2026-09-29T10:00:00.000Z' };

  it('комната с Room.proposal ждёт, с proposal: null — нет', () => {
    expect(roomAwaitsDecision({ ...base, proposal })).toBe(true);
    expect(roomAwaitsDecision(base)).toBe(false);
  });

  it('у комнаты карты до 2026-09-29 поля proposal нет вовсе — это «не ждёт»', () => {
    const old = { id: 'r-01', title: 'R', creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room;
    expect(roomAwaitsDecision(old)).toBe(false);
  });
});

// Спека окна 2026-09-29, 1.10: после `Return for rework` ведущий приносит новое решение с новым `id`, и уведомление
// говорит «revised». Признак — последний ответ человека в ленте комнаты: письмо возврата или письмо принятия.
describe('roomDecisionReturned (1.10)', () => {
  const answer = (id: string, text: string, roomId = 'r-01'): Message =>
    letter({ id, from: 'human', to: ['s-01'], roomId, text });
  const mapOf = (messages: Message[]) => entry([session('s-01')], messages).map;

  it('письмо «Returned for rework: …» и «Returned for rework.» — возврат', () => {
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Returned for rework: add the tests')]), 'r-01')).toBe(true);
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Returned for rework.')]), 'r-01')).toBe(true);
  });

  it('ответов человека ещё не было или последний — принятие («Decision accepted.») — не возврат', () => {
    expect(roomDecisionReturned(mapOf([]), 'r-01')).toBe(false);
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Decision accepted.')]), 'r-01')).toBe(false);
    // Возврат был, потом принято следующее решение: решает последний ответ.
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Returned for rework.'), answer('m-2', 'Decision accepted.')]), 'r-01')).toBe(false);
    // И наоборот: принято, потом вернули следующее.
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Decision accepted.'), answer('m-2', 'Returned for rework.')]), 'r-01')).toBe(true);
  });

  it('обычные сообщения человека, чужие комнаты и письма агентов возврата не делают', () => {
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Returned for rework: x', 'r-02')]), 'r-01')).toBe(false);
    expect(roomDecisionReturned(mapOf([letter({ id: 'm-1', from: 's-01', to: [], roomId: 'r-01', text: 'Returned for rework' })]), 'r-01')).toBe(false);
    // Возврат, за которым человек написал в комнату что-то своё, остаётся возвратом.
    expect(roomDecisionReturned(mapOf([answer('m-1', 'Returned for rework.'), answer('m-2', 'Also cover refunds')]), 'r-01')).toBe(true);
  });
});

describe('workAttention — решение и почта человеку (2.7)', () => {
  const proposal: Proposal = { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' };
  const room = (id: string, patch: Partial<Room> = {}): Room => ({
    id,
    title: id,
    creator: 'human',
    members: ['s-01', 's-02'],
    createdAt: '2026-09-29T09:00:00.000Z',
    lead: null,
    proposal: null,
    ...patch,
  });
  const withRooms = (sessions: WorkSession[], rooms: Room[], messages: Message[] = []): WorkEntry => {
    const base = entry(sessions, messages);
    return { ...base, map: { ...base.map, rooms } };
  };

  it('ждущее решение — needs-you (ранг 4) даже без единой сессии в blocked; оно входит в needsYou', () => {
    const e = withRooms([session('s-01'), session('s-02')], [room('r-01', { proposal })]);
    const a = workAttention(e, activityOf(e, { 's-01': live('idle'), 's-02': live('idle') }));
    expect(a.level).toBe('needs-you');
    expect(ATTENTION_RANK[a.level]).toBe(4);
    expect(a.needsYou).toBe(1);
  });

  it('blocked-сессия и каждая комната с решением считаются по одной: 1 сессия + 2 комнаты — needsYou 3', () => {
    const e = withRooms([session('s-01'), session('s-02')], [room('r-01', { proposal }), room('r-02', { proposal: { ...proposal, id: 'p-02' } })]);
    expect(workAttention(e, activityOf(e, { 's-01': live('blocked') })).needsYou).toBe(3);
  });

  it('решение бьёт working и unseen', () => {
    const e = withRooms([session('s-01'), session('s-02')], [room('r-01', { proposal })]);
    expect(workAttention(e, activityOf(e, { 's-01': live('working'), 's-02': live('unseen') })).level).toBe('needs-you');
  });

  it('комната старой карты без proposal и комната с proposal: null уровня не поднимают', () => {
    const old = { id: 'r-02', title: 'Старая', creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room;
    const e = withRooms([session('s-01')], [room('r-01'), old]);
    const a = workAttention(e, activityOf(e, { 's-01': live('working') }));
    expect(a.level).toBe('working');
    expect(a.needsYou).toBe(0);
  });

  it('письмо человеку — ранг 3: выше working и простоя, ниже blocked и решения', () => {
    const mail = [letter({ id: 'm1', from: 's-01', to: ['human'] })];
    const working = entry([session('s-01')], mail);
    expect(workAttention(working, activityOf(working, { 's-01': live('working') })).level).toBe('unseen');
    const idle = entry([session('s-01')], mail);
    expect(workAttention(idle, activityOf(idle, { 's-01': live('idle') })).level).toBe('unseen');
    const blocked = entry([session('s-01')], mail);
    expect(workAttention(blocked, activityOf(blocked, { 's-01': live('blocked') })).level).toBe('needs-you');
    const decision = withRooms([session('s-01')], [room('r-01', { proposal })], mail);
    expect(workAttention(decision, activityOf(decision, { 's-01': live('idle') })).level).toBe('needs-you');
  });

  it('письмо человеку не меняет needsYou и unseen сессий: счётчики — только по сессиям и решениям', () => {
    const e = entry([session('s-01')], [letter({ id: 'm1', from: 's-01', to: ['human'] })]);
    const a = workAttention(e, activityOf(e, { 's-01': live('working') }));
    expect(a).toMatchObject({ needsYou: 0, unseen: 0, humanUnread: 1 });
  });
});
