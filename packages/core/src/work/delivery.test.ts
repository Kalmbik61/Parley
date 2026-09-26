import { describe, expect, it } from 'vitest';
import type { SessionActivity } from './activity.js';
import { deliveryAction, pointerText } from './delivery.js';
import type { Message, WorkSession } from './types.js';

const sessionOf = (patch: Partial<WorkSession> = {}): WorkSession => ({
  id: 's-01',
  provider: 'claude',
  label: 'сессия',
  task: '',
  parent: null,
  contextFrom: [],
  status: 'active',
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
  ...patch,
});

const messageOf = (patch: Partial<Message> = {}): Message => ({
  id: 'm-01',
  from: 's-00',
  to: 's-01',
  at: new Date().toISOString(),
  text: 'привет',
  kind: 'note',
  readAt: null,
  ...patch,
});

const activityOf = (activity: SessionActivity['activity']): SessionActivity => ({
  activity,
  subagents: 0,
  turnEndedAt: null,
  lastEventAt: null,
  source: 'hooks',
  exited: false,
  hooksMissing: false,
});

describe('pointerText', () => {
  it('одно письмо', () => {
    expect(pointerText(1)).toBe('Новые письма (1). Вызови check_inbox.');
  });

  it('три письма', () => {
    expect(pointerText(3)).toBe('Новые письма (3). Вызови check_inbox.');
  });
});

describe('deliveryAction', () => {
  const base: Parameters<typeof deliveryAction>[0] = {
    session: sessionOf(),
    activity: activityOf('unseen'),
    hasDraft: false,
    paused: false,
    unread: [messageOf()],
    pointed: new Set<string>(),
    inFlight: false,
  };

  it('1. пауза — none(paused), даже если остальные условия тоже нарушены', () => {
    expect(
      deliveryAction({
        ...base,
        paused: true,
        session: sessionOf({ status: 'exited' }),
        hasDraft: true,
      }),
    ).toEqual({ kind: 'none', reason: 'paused' });
  });

  it('2а. нет непрочитанных — none(no-letters)', () => {
    expect(deliveryAction({ ...base, unread: [] })).toEqual({ kind: 'none', reason: 'no-letters' });
  });

  it('2б. все непрочитанные уже указаны — none(already-pointed)', () => {
    const message = messageOf({ id: 'm-01' });
    expect(
      deliveryAction({ ...base, unread: [message], pointed: new Set(['m-01']) }),
    ).toEqual({ kind: 'none', reason: 'already-pointed' });
  });

  it('2в. удалённые письма в счёт не идут', () => {
    const deleted = messageOf({ id: 'm-01', deleted: true });
    expect(deliveryAction({ ...base, unread: [deleted] })).toEqual({
      kind: 'none',
      reason: 'no-letters',
    });
  });

  it('3. сессия не active — none(not-live)', () => {
    for (const status of ['pending', 'exited', 'done', 'failed'] as const) {
      expect(deliveryAction({ ...base, session: sessionOf({ status }) })).toEqual({
        kind: 'none',
        reason: 'not-live',
      });
    }
  });

  it('4а. активности не известно — none(busy)', () => {
    expect(deliveryAction({ ...base, activity: null })).toEqual({ kind: 'none', reason: 'busy' });
  });

  it('4б. working или blocked — none(busy)', () => {
    expect(deliveryAction({ ...base, activity: activityOf('working') })).toEqual({
      kind: 'none',
      reason: 'busy',
    });
    expect(deliveryAction({ ...base, activity: activityOf('blocked') })).toEqual({
      kind: 'none',
      reason: 'busy',
    });
  });

  it('5. черновик человека — none(draft)', () => {
    expect(deliveryAction({ ...base, hasDraft: true })).toEqual({ kind: 'none', reason: 'draft' });
  });

  it('6. указатель уже в полёте — none(in-flight)', () => {
    expect(deliveryAction({ ...base, inFlight: true })).toEqual({ kind: 'none', reason: 'in-flight' });
  });

  it('7. иначе — печать указателя со всеми id непрочитанных, unseen и idle разрешены', () => {
    const a = messageOf({ id: 'm-01' });
    const b = messageOf({ id: 'm-02' });
    expect(deliveryAction({ ...base, unread: [a, b] })).toEqual({
      kind: 'type-pointer',
      text: 'Новые письма (2). Вызови check_inbox.',
      letterIds: ['m-01', 'm-02'],
    });
    expect(deliveryAction({ ...base, activity: activityOf('idle') })).toMatchObject({
      kind: 'type-pointer',
    });
  });
});
