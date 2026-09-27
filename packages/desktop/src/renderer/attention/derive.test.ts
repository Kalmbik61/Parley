import { describe, expect, it } from 'vitest';
import type { Message, SessionActivity, WorkEntry, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { ActivityEntry } from '../store/activity.js';
import {
  ATTENTION_RANK,
  humanUnreadLetters,
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

  it('только письмо человеку → needs-you', () => {
    const e = entry([], [letter({ id: 'm1', from: 's-01', to: ['human'] })]);
    const a = workAttention(e, {});
    expect(a.level).toBe('needs-you');
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
});
