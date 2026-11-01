/** Бюджет работы и комнаты (P37): допуск, резервы, окна, отмена и неоднозначные владельцы — чистыми фикстурами и через запись карты в базу. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, addSession, parseMap, transitionSession } from './map.js';
import {
  CREATION_WINDOW_MS,
  DEFAULT_RESOURCE_LIMITS,
  RESOURCE_COVERAGE,
  RESOURCE_WINDOW_MS,
  ResourceDeniedError,
  assertMessageBudget,
  RESOURCE_LIMIT_BOUNDS,
  RESOURCE_LIMIT_KEYS,
  attemptKindFor,
  checkSwarmSpawn,
  deniedForAgent,
  limitsFromConfig,
  noteCreation,
  recentCreations,
  reserveAttempt,
  resourceStatus,
  roomOfSession,
  countRecipients,
  settleAttempt,
  settleByEvidence,
  teamStartFits,
  type ResourceLimits,
} from './resource-policy.js';
import { addRoom } from './rooms.js';
import type { WorkSwarm } from './swarms.js';
import { createWork, readMap, readStoredMap, updateMap } from './store.js';
import { HUMAN, PARLEY, SYSTEM, type CreationKind, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

/** Чуть впереди настоящих часов: отметки `history` из `transitionSession` не должны выглядеть свидетельством запуска после резерва. */
const NOW = Date.now() + 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const limits = (patch: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...patch });

/** `count` записей журнала создания вида `kind`; по умолчанию «только что» (`NOW`) и вне комнат. */
const recentOf = (kind: CreationKind, count: number, room: string | null = null, at: number = NOW) =>
  Array.from({ length: count }, () => ({ kind, at: iso(at), room }));

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'бюджет', goal: '', status: 'active', createdAt: iso(NOW), updatedAt: iso(NOW) },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Сессия `active`: так её видит бюджет — как занятый слот. */
function addActive(map: WorkMap): string {
  const session = addSession(map, { provider: 'claude', label: 'x', task: 'y' });
  transitionSession(map, session.id, 'active');
  return session.id;
}

/** Сессия, которую усыпил хост: `autoSleep` ставит `transitionSession` из отметки «засыпает» при уходе в `sleeping`. */
function addHostSlept(map: WorkMap): string {
  const session = addSession(map, { provider: 'claude', label: 'z', task: 't' });
  transitionSession(map, session.id, 'active');
  session.autoSleepPending = { reason: 'idle', at: iso(NOW), waitTarget: null };
  transitionSession(map, session.id, 'sleeping');
  return session.id;
}

/** Сессия, которую остановил человек: ушла в `sleeping` без отметки, `autoSleep` пуст. */
function addHumanStopped(map: WorkMap): string {
  const session = addSession(map, { provider: 'claude', label: 'h', task: 't' });
  transitionSession(map, session.id, 'active');
  transitionSession(map, session.id, 'sleeping');
  return session.id;
}

const denied = (run: () => void): ResourceDeniedError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ResourceDeniedError);
    return error as ResourceDeniedError;
  }
  throw new Error('отказа не было');
};

describe('reserveAttempt: окно запусков, слоты и повтор', () => {
  const owner = 'host-A';

  it('окно: запуски сверх порога отказаны, старше часа — освободились сами', () => {
    const map = emptyMap();
    const ids = [addActive(map), addActive(map), addActive(map)].map((id) => id);
    const two = limits({ workLaunches: 2, workConcurrent: 50 });
    for (const id of ids.slice(0, 2)) {
      const attempt = reserveAttempt(map, { kind: 'launch', actor: 'human', session: id, owner, limits: two, now: NOW });
      settleAttempt(map, attempt.id, owner, 'spent', NOW);
    }
    const refusal = denied(() => reserveAttempt(map, { kind: 'launch', actor: 'auto', session: ids[2] as string, owner, limits: two, now: NOW + 1000 }));
    expect([refusal.code, refusal.scope, refusal.used]).toEqual(['launches', 'work', 2]);

    expect(() =>
      reserveAttempt(map, { kind: 'launch', actor: 'auto', session: ids[2] as string, owner, limits: two, now: NOW + RESOURCE_WINDOW_MS + 1 }),
    ).not.toThrow();
  });

  it('комната уже работы: запуски членов комнаты упираются в её порог, чужая сессия — нет', () => {
    const map = emptyMap();
    const a = addActive(map);
    const b = addActive(map);
    const outsider = addActive(map);
    addRoom(map, { title: 'r', creator: a, members: [a, b] });
    const tight = limits({ roomLaunches: 1, workLaunches: 10, workConcurrent: 50, roomConcurrent: 50 });

    const first = reserveAttempt(map, { kind: 'launch', actor: 'human', session: a, owner, limits: tight, now: NOW });
    settleAttempt(map, first.id, owner, 'spent', NOW);
    const refusal = denied(() => reserveAttempt(map, { kind: 'launch', actor: 'human', session: b, owner, limits: tight, now: NOW }));
    expect([refusal.code, refusal.scope]).toEqual(['launches', 'room']);
    expect(() => reserveAttempt(map, { kind: 'launch', actor: 'human', session: outsider, owner, limits: tight, now: NOW })).not.toThrow();
  });

  it('слоты одновременных сессий: ожидающий резерв занимает место до исхода', () => {
    const map = emptyMap();
    const one = addActive(map);
    const sleeper = addSession(map, { provider: 'claude', label: 's', task: 't' }).id;
    transitionSession(map, sleeper, 'active');
    transitionSession(map, sleeper, 'sleeping');
    const other = addSession(map, { provider: 'claude', label: 'o', task: 't' }).id;
    transitionSession(map, other, 'active');
    transitionSession(map, other, 'sleeping');
    const two = limits({ workConcurrent: 2 });

    expect(one).toBe('s-01');
    reserveAttempt(map, { kind: 'resume', actor: 'wake', session: sleeper, owner, limits: two, now: NOW });
    const refusal = denied(() => reserveAttempt(map, { kind: 'resume', actor: 'wake', session: other, owner, limits: two, now: NOW }));
    expect([refusal.code, refusal.used, refusal.limit]).toEqual(['concurrent', 2, 2]);
  });

  it('возобновления одной сессии за час: порог будильника, чужие сессии и ручные запуски его не расходуют', () => {
    const map = emptyMap();
    const target = addSession(map, { provider: 'claude', label: 't', task: 't' }).id;
    transitionSession(map, target, 'active');
    transitionSession(map, target, 'sleeping');
    for (let i = 0; i < 2; i += 1) {
      const attempt = reserveAttempt(map, { kind: 'resume', actor: 'wake', session: target, owner, limits: limits(), sessionResumeRate: 2, now: NOW + i });
      settleAttempt(map, attempt.id, owner, 'spent', NOW + i);
    }
    const refusal = denied(() =>
      reserveAttempt(map, { kind: 'resume', actor: 'wake', session: target, owner, limits: limits(), sessionResumeRate: 2, now: NOW + 10 }),
    );
    expect([refusal.code, refusal.scope, refusal.limit]).toEqual(['resume-rate', 'session', 2]);
    // Ручное возобновление человеком пороге будильника не подчиняется (но окно запусков считает).
    expect(() => reserveAttempt(map, { kind: 'resume', actor: 'human', session: target, owner, limits: limits(), now: NOW + 20 })).not.toThrow();
  });

  it('повтор той же попытки не списывает второй резерв; новый настоящий запуск после удавшегося — списывает', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 's', task: 't' }).id;
    const first = reserveAttempt(map, { kind: 'launch', actor: 'auto', session, owner, limits: limits(), now: NOW });
    // Хост перезапущен: тот же нерешённый резерв подхватывает новый владелец.
    const retried = reserveAttempt(map, { kind: 'launch', actor: 'human', session, owner: 'host-B', limits: limits(), now: NOW + 5 });
    expect(retried.id).toBe(first.id);
    expect(retried.owner).toBe('host-B');
    expect(map.resources?.attempts).toHaveLength(1);

    settleAttempt(map, first.id, 'host-B', 'spent', NOW + 10);
    expect(attemptKindFor(map, session, 'launch')).toBe('retry');
    expect(attemptKindFor(map, session, 'resume')).toBe('resume');
    const next = reserveAttempt(map, { kind: 'retry', actor: 'human', session, owner: 'host-B', limits: limits(), now: NOW + 20 });
    expect(next.id).not.toBe(first.id);
    expect(map.resources?.attempts).toHaveLength(2);
  });

  it('отказ не трогает карту: резерва не появилось', () => {
    const map = emptyMap();
    const session = addActive(map);
    const first = reserveAttempt(map, { kind: 'launch', actor: 'human', session, owner, limits: limits({ workLaunches: 1 }), now: NOW });
    settleAttempt(map, first.id, owner, 'spent', NOW);
    const other = addActive(map);
    denied(() => reserveAttempt(map, { kind: 'launch', actor: 'human', session: other, owner, limits: limits({ workLaunches: 1 }), now: NOW }));
    expect(map.resources?.attempts.map((attempt) => attempt.session)).toEqual([session]);
  });
});

describe('reserveAttempt: подъём сессии, которую усыпил хост, идёт вне окон запусков', () => {
  const owner = 'host-A';
  /** Подъём будильником, как его берёт `sessions-service`: с порогом `resumeRate`, исход — `spent`. */
  const wake = (map: WorkMap, session: string, patch: Partial<ResourceLimits>, at: number) => {
    const attempt = reserveAttempt(map, { kind: 'resume', actor: 'wake', session, owner, limits: limits(patch), sessionResumeRate: 6, now: at });
    settleAttempt(map, attempt.id, owner, 'spent', at);
    return attempt;
  };

  it('усыплённую хостом будильник поднимает сверх resumeRate', () => {
    const map = emptyMap();
    const target = addHostSlept(map);
    // Семь подъёмов за час при пороге шесть: все резервы взяты, у каждой попытки отметка «вне окна».
    const attempts = Array.from({ length: 7 }, (_, i) => wake(map, target, {}, NOW + i));
    expect(attempts.map((attempt) => attempt.windowFree)).toEqual(Array(7).fill(true));
    expect(map.resources?.attempts).toHaveLength(7);
  });

  it('подъёмы после сна не тратят workLaunches и roomLaunches', () => {
    const map = emptyMap();
    const sleeper = addHostSlept(map);
    const peer = addActive(map);
    const fresh = addSession(map, { provider: 'claude', label: 'n', task: 't' }).id;
    const other = addSession(map, { provider: 'claude', label: 'o', task: 't' }).id;
    const room = addRoom(map, { title: 'r', creator: peer, members: [sleeper, peer, fresh, other] }).id;
    // Шестьдесят подъёмов при умолчаниях: окно работы (60) и окно комнаты (20) исчерпали бы их задолго до конца.
    for (let i = 0; i < 60; i += 1) wake(map, sleeper, {}, NOW + i);
    const status = resourceStatus(map, limits(), NOW + 100, room);
    expect([status.work.launches.used, status.room?.launches.used]).toEqual([0, 0]);

    // Обычный запуск проходит под порогом в единицу и сам окно по-прежнему тратит: следующий отказан.
    const tight = limits({ workLaunches: 1, roomLaunches: 1 });
    const launch = reserveAttempt(map, { kind: 'launch', actor: 'human', session: fresh, owner, limits: tight, now: NOW + 100 });
    expect(launch.windowFree).toBeUndefined();
    settleAttempt(map, launch.id, owner, 'spent', NOW + 100);
    const refusal = denied(() => reserveAttempt(map, { kind: 'launch', actor: 'human', session: other, owner, limits: tight, now: NOW + 101 }));
    expect([refusal.code, refusal.scope, refusal.used]).toEqual(['launches', 'work', 1]);
  });

  it('слоты одновременных сессий подъём после сна занимает', () => {
    const map = emptyMap();
    addActive(map);
    addActive(map);
    const first = addHostSlept(map);
    const second = addHostSlept(map);
    // В работе места на двоих, и оба заняты: подъём отказан по слотам, карта не тронута.
    const full = denied(() =>
      reserveAttempt(map, { kind: 'resume', actor: 'wake', session: first, owner, limits: limits({ workConcurrent: 2 }), sessionResumeRate: 6, now: NOW }),
    );
    expect([full.code, full.scope, full.used, full.limit]).toEqual(['concurrent', 'work', 2, 2]);
    expect(map.resources?.attempts).toHaveLength(0);

    // Место есть — подъём берёт слот до исхода, и следующий упирается в него.
    const three = limits({ workConcurrent: 3 });
    const taken = reserveAttempt(map, { kind: 'resume', actor: 'wake', session: first, owner, limits: three, sessionResumeRate: 6, now: NOW });
    expect(taken.windowFree).toBe(true);
    const next = denied(() => reserveAttempt(map, { kind: 'resume', actor: 'wake', session: second, owner, limits: three, sessionResumeRate: 6, now: NOW }));
    expect([next.code, next.scope, next.used]).toEqual(['concurrent', 'work', 3]);

    // Слоты комнаты тоже: в комнате места на одного, и его держит живой участник.
    const mate = addActive(map);
    const sleeper = addHostSlept(map);
    addRoom(map, { title: 'r', creator: mate, members: [mate, sleeper] });
    const inRoom = denied(() =>
      reserveAttempt(map, { kind: 'resume', actor: 'wake', session: sleeper, owner, limits: limits({ workConcurrent: 50, roomConcurrent: 1 }), sessionResumeRate: 6, now: NOW }),
    );
    expect([inRoom.code, inRoom.scope]).toEqual(['concurrent', 'room']);
  });

  it('остановленную человеком будильник считает по-старому', () => {
    const map = emptyMap();
    const target = addHumanStopped(map);
    // Шесть подъёмов за час — порог; у них нет отметки «вне окна», они считаются в окне.
    const attempts = Array.from({ length: 6 }, (_, i) => wake(map, target, {}, NOW + i));
    expect(attempts.map((attempt) => attempt.windowFree)).toEqual(Array(6).fill(undefined));
    const refusal = denied(() => wake(map, target, {}, NOW + 10));
    expect([refusal.code, refusal.scope, refusal.limit]).toEqual(['resume-rate', 'session', 6]);
  });

  it('усыплённую хостом сессию, поднятую не будильником, окна считают как обычно', () => {
    const map = emptyMap();
    const target = addHostSlept(map);
    const one = limits({ workLaunches: 1 });
    // Resume человеком — его действие, а не решение хоста: попытка без отметки, окно запусков её считает.
    const first = reserveAttempt(map, { kind: 'resume', actor: 'human', session: target, owner, limits: one, now: NOW });
    expect(first.windowFree).toBeUndefined();
    settleAttempt(map, first.id, owner, 'spent', NOW);
    const refusal = denied(() => reserveAttempt(map, { kind: 'resume', actor: 'human', session: target, owner, limits: one, now: NOW + 1 }));
    expect([refusal.code, refusal.scope]).toEqual(['launches', 'work']);
  });

  it('validateResources: windowFree — только true, иначе карта не читается', () => {
    const ledger = (extra: Record<string, unknown>) => ({
      ...emptyMap(),
      resources: {
        seq: 1,
        spawned: 0,
        spawnedByRoom: {},
        attempts: [{ id: 'a-0001', kind: 'resume', state: 'spent', at: iso(NOW), actor: 'wake', session: 's-01', room: null, owner: 'host-A', ...extra }],
      },
    });
    expect(parseMap(JSON.stringify(ledger({ windowFree: true })), 'map.json').resources?.attempts[0]?.windowFree).toBe(true);
    expect(parseMap(JSON.stringify(ledger({})), 'map.json').resources?.attempts[0]?.windowFree).toBeUndefined();
    for (const bad of [false, 'true', 1, null]) {
      expect(() => parseMap(JSON.stringify(ledger({ windowFree: bad })), 'map.json')).toThrow('invalid resource ledger');
    }
  });
});

describe('settleAttempt: отмена освобождает только свой ожидающий слот', () => {
  it('released возвращает слот в окно, spent оставляет; чужой владелец и закрытая попытка — false', () => {
    const map = emptyMap();
    const a = addSession(map, { provider: 'claude', label: 'a', task: 't' }).id;
    const b = addSession(map, { provider: 'claude', label: 'b', task: 't' }).id;
    const tight = limits({ workLaunches: 2 });
    const mine = reserveAttempt(map, { kind: 'launch', actor: 'human', session: a, owner: 'host-A', limits: tight, now: NOW });
    const theirs = reserveAttempt(map, { kind: 'launch', actor: 'human', session: b, owner: 'host-A', limits: tight, now: NOW });

    expect(settleAttempt(map, mine.id, 'host-X', 'released', NOW)).toBe(false);
    expect(settleAttempt(map, 'a-9999', 'host-A', 'released', NOW)).toBe(false);
    expect(map.resources?.attempts.every((attempt) => attempt.state === 'reserved')).toBe(true);

    expect(settleAttempt(map, mine.id, 'host-A', 'released', NOW)).toBe(true);
    expect(map.resources?.attempts.find((attempt) => attempt.id === theirs.id)?.state).toBe('reserved');
    // Повторная отмена того же слота ничего не делает.
    expect(settleAttempt(map, mine.id, 'host-A', 'released', NOW)).toBe(false);
    const status = resourceStatus(map, tight, NOW);
    expect([status.work.launches.used, status.work.launches.reserved]).toEqual([0, 1]);
  });
});

describe('неоднозначный резерв: один срок его не снимает', () => {
  it('чужое поколение без свидетельств остаётся занятым спустя сутки; считается неоднозначным', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 's', task: 't' }).id;
    reserveAttempt(map, { kind: 'launch', actor: 'auto', session, owner: 'host-old', limits: limits(), now: NOW });

    const later = NOW + 24 * RESOURCE_WINDOW_MS;
    settleByEvidence(map, later);
    const other = addSession(map, { provider: 'claude', label: 'o', task: 't' }).id;
    const refusal = denied(() =>
      reserveAttempt(map, { kind: 'launch', actor: 'human', session: other, owner: 'host-new', limits: limits({ workConcurrent: 1 }), now: later }),
    );
    expect(refusal.code).toBe('concurrent');
    expect(map.resources?.attempts[0]?.state).toBe('reserved');
    expect(resourceStatus(map, limits(), later, null, 'host-new').ambiguous).toBe(1);
    // Чужой владелец освободить его не может: подхватить — только повтором той же сессии.
    expect(settleAttempt(map, map.resources?.attempts[0]?.id as string, 'host-new', 'released', later)).toBe(false);
  });

  it('свидетельства закрывают резерв: сессия удалена или закрыта — released, переход в active после резерва — spent', () => {
    const map = emptyMap();
    const gone = addSession(map, { provider: 'claude', label: 'g', task: 't' }).id;
    const closed = addSession(map, { provider: 'claude', label: 'c', task: 't' }).id;
    const started = addSession(map, { provider: 'claude', label: 'd', task: 't' }).id;
    const waiting = addSession(map, { provider: 'claude', label: 'w', task: 't' }).id;
    const big = limits({ workConcurrent: 50 });
    for (const session of [gone, closed, started, waiting]) {
      reserveAttempt(map, { kind: 'launch', actor: 'auto', session, owner: 'host-old', limits: big, now: NOW });
    }
    map.sessions = map.sessions.filter((session) => session.id !== gone);
    transitionSession(map, closed, 'closed');
    // Процесс стартовал уже после резерва: переход в `active` с отметкой позже него.
    transitionSession(map, started, 'active', { at: iso(NOW + 500) });

    settleByEvidence(map, NOW + 1000);
    const states = Object.fromEntries((map.resources?.attempts ?? []).map((attempt) => [attempt.session, attempt.state]));
    expect(states).toEqual({ [gone]: 'released', [closed]: 'released', [started]: 'spent', [waiting]: 'reserved' });
  });
});

describe('assertMessageBudget: письма, рассылки и приглашения', () => {
  const room = (map: WorkMap, creator: string, members: string[]): string => addRoom(map, { title: 'r', creator, members }).id;

  it('работа и комната: общий потолок писем агентов; письма человека, хоста и плана не считаются', () => {
    const map = emptyMap();
    const a = addActive(map);
    const b = addActive(map);
    const id = room(map, a, [b]);
    for (let i = 0; i < 3; i += 1) addMessage(map, { from: a, to: [b], text: 'x', roomId: id }, iso(NOW - 1000));
    for (const from of [HUMAN, SYSTEM, PARLEY]) addMessage(map, { from, to: [b], text: 'control', roomId: id }, iso(NOW - 1000));

    const base = { actor: a, room: id, messages: 1, recipients: 1, now: NOW } as const;
    expect(() => assertMessageBudget(map, lt(map), { ...base, limits: limits({ workMessages: 4, roomMessages: 4 }) })).not.toThrow();
    const work = denied(() => assertMessageBudget(map, lt(map), { ...base, limits: limits({ workMessages: 3, roomMessages: 50 }) }));
    expect([work.code, work.scope, work.used]).toEqual(['messages', 'work', 3]);
    const inRoom = denied(() => assertMessageBudget(map, lt(map), { ...base, limits: limits({ workMessages: 50, roomMessages: 3 }) }));
    expect([inRoom.code, inRoom.scope]).toEqual(['messages', 'room']);
    // Прямое письмо вне комнаты комнатный потолок не задевает.
    expect(() => assertMessageBudget(map, lt(map), { ...base, room: null, limits: limits({ workMessages: 50, roomMessages: 3 }) })).not.toThrow();
  });

  it('письма старше часа не считаются', () => {
    const map = emptyMap();
    const a = addActive(map);
    const b = addActive(map);
    addMessage(map, { from: a, to: [b], text: 'старое' }, iso(NOW - RESOURCE_WINDOW_MS - 1));
    expect(() => assertMessageBudget(map, lt(map), { actor: a, room: null, messages: 1, recipients: 1, limits: limits({ workMessages: 1 }), now: NOW })).not.toThrow();
  });

  it('рассылка: потолок адресатов считает каждого получателя, а письмо — как одно', () => {
    const map = emptyMap();
    const a = addActive(map);
    const members = [addActive(map), addActive(map), addActive(map)];
    const id = room(map, a, members);
    addMessage(map, { from: a, to: [], text: 'всем', roomId: id }, iso(NOW - 10)); // три адресата

    const fan = limits({ fanout: 4 });
    expect(() => assertMessageBudget(map, lt(map), { actor: a, room: id, messages: 1, recipients: 1, limits: fan, now: NOW })).not.toThrow();
    const refusal = denied(() => assertMessageBudget(map, lt(map), { actor: a, room: id, messages: 1, recipients: 2, limits: fan, now: NOW }));
    expect([refusal.code, refusal.used, refusal.limit]).toEqual(['fanout', 3, 4]);
  });

  it('запросы ограничены лимитами, а не письмами за час: письма человека не читаются, агентские — не больше workMessages', () => {
    const map = emptyMap();
    const a = addActive(map);
    const b = addActive(map);
    // Час, полный писем человека и хоста: у настоящего хоста их тысячи.
    for (let i = 0; i < 300; i += 1) addMessage(map, { from: i % 2 === 0 ? HUMAN : SYSTEM, to: [b], text: 'x' }, iso(NOW - 1000));
    for (let i = 0; i < 3; i += 1) addMessage(map, { from: a, to: [b], text: 'x' }, iso(NOW - 1000));
    const inner = lt(map);
    const asked: Array<{ agentsOnly?: boolean; limit?: number }> = [];
    const spy = {
      ...inner,
      query: (q: Parameters<typeof inner.query>[0]) => {
        asked.push({ ...(q.agentsOnly === undefined ? {} : { agentsOnly: q.agentsOnly }), limit: q.limit });
        return inner.query(q);
      },
    };

    expect(() => assertMessageBudget(map, spy, { actor: a, room: null, messages: 1, recipients: 1, limits: limits({ workMessages: 10 }), now: NOW })).not.toThrow();

    expect(asked).toEqual([{ agentsOnly: true, limit: 3 }]);
    // Отказ по числу писем не читает их вовсе.
    asked.length = 0;
    const refusal = denied(() => assertMessageBudget(map, spy, { actor: a, room: null, messages: 1, recipients: 1, limits: limits({ workMessages: 3 }), now: NOW }));
    expect([refusal.code, refusal.used]).toEqual(['messages', 3]);
    expect(asked).toEqual([]);
  });

  it('приглашения: N приглашённых — N писем и N адресатов сразу', () => {
    const map = emptyMap();
    const a = addActive(map);
    const refusal = denied(() =>
      assertMessageBudget(map, lt(map), { actor: a, room: null, messages: 5, recipients: 5, limits: limits({ workMessages: 4 }), now: NOW }),
    );
    expect(refusal.code).toBe('messages');
  });
});

describe('текст отказа и состояние бюджета', () => {
  it('агенту отказ говорит, что лимит расширяет человек; сессий, денег и токенов не обещает', () => {
    const text = deniedForAgent(new ResourceDeniedError('concurrent', 'room', 6, 6));
    expect(text).toContain('6 of 6');
    expect(text).toContain('in this room');
    expect(text).toContain('Only the human can raise this limit');
  });

  it('resourceStatus: использовано, занято заранее и осталось по работе и комнате; полнота названа', () => {
    const map = emptyMap();
    const lead = addActive(map);
    const member = addActive(map);
    const legacy = addSession(map, { provider: 'claude', label: 'c', task: 't' });
    legacy.parent = lead; // историческая запись
    const id = addRoom(map, { title: 'r', creator: lead, members: [lead, member] }).id;
    map.resources = { seq: 0, spawned: 1, spawnedByRoom: {}, attempts: [], recent: recentOf('session', 1, id) };
    addMessage(map, { from: lead, to: [member], text: 'x', roomId: id }, iso(NOW - 5));

    const status = resourceStatus(map, limits({ workConcurrent: 4, roomConcurrent: 2 }), NOW, id);
    expect(status.work.concurrent).toEqual({ used: 2, reserved: 1, limit: 4, remaining: 1 });
    expect(status.room?.concurrent).toEqual({ used: 2, reserved: 0, limit: 2, remaining: 0 });
    expect(status.work.newSessions.used).toBe(1);
    expect(status.room?.newSessions.used).toBe(1);
    expect(status.work.messages.used).toBe(1);
    expect(status.exhausted).toContain('concurrent');
    expect(status.monetaryCap).toBe(false);
    expect(status.coverage).toBe(RESOURCE_COVERAGE);
    expect(RESOURCE_COVERAGE.completeness).toBe('partial');
    expect(RESOURCE_COVERAGE.notCounted.join(' ')).toMatch(/subagents or forks/);
    expect(RESOURCE_COVERAGE.notCounted.join(' ')).toMatch(/tokens/);
  });

  it('старт команды: нужные участники против оставшихся слотов, запусков и порога комнаты', () => {
    const map = emptyMap();
    addActive(map);
    const status = resourceStatus(map, limits({ workConcurrent: 3, workLaunches: 10 }), NOW);
    expect(teamStartFits(status, 2)).toMatchObject({ fits: true, reason: null, needed: 2 });
    expect(teamStartFits(status, 3)).toMatchObject({ fits: false, reason: 'concurrent', scope: 'work', remaining: 2 });
    expect(teamStartFits(resourceStatus(map, limits({ workLaunches: 1 }), NOW), 2)).toMatchObject({ fits: false, reason: 'launches' });
    // Комната из четырёх не уместится в порог комнаты три, даже если работа вместит.
    expect(teamStartFits(resourceStatus(map, limits(), NOW), 4, 3)).toMatchObject({ fits: false, reason: 'concurrent', scope: 'room', remaining: 3 });
  });

  it('limitsFromConfig берёт только пороги', () => {
    const picked = limitsFromConfig({ ...limits({ fanout: 7 }), extra: 1 } as ResourceLimits);
    expect(picked).toEqual(limits({ fanout: 7 }));
  });
});

describe('журнал в карте: чтение, запись, перезапуск и параллельные операции', () => {
  let project = '';
  let home = '';
  let workId = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-resource-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-resource-project-'));
    process.env.PARLEY_HOME = home;
    workId = (await createWork(project, { title: 'бюджет' })).work.id;
  });

  afterEach(async () => {
    delete process.env.PARLEY_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('параллельные резервы запуска не обходят общий потолок слотов, повтор той же сессии не берёт второй', async () => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 6; i += 1) addSession(map, { provider: 'claude', label: 'x', task: 't' });
    });
    const two = limits({ workConcurrent: 2, workLaunches: 50 });
    // Порядок записей в базу не задан: какие две сессии займут слоты и достанется ли слот
    // повтору `s-01`, решает очередь. Проверяются инварианты, не порядок. Таймаут записи — запас на нагрузку:
    // семь записей подряд укладываются в три секунды по умолчанию не всегда.
    const reserve = (session: string) =>
      updateMap(
        project,
        workId,
        (map) => {
          reserveAttempt(map, { kind: 'launch', actor: 'human', session, owner: 'host-A', limits: two });
        },
        { lockTimeoutMs: 30_000 },
      );
    const sessions = ['s-01', 's-02', 's-03', 's-04', 's-05', 's-06', 's-01'];
    const results = await Promise.allSettled(sessions.map(reserve));

    const map = await readMap(project, workId);
    const reserved = map.resources?.attempts.filter((attempt) => attempt.state === 'reserved') ?? [];
    expect(reserved).toHaveLength(2);
    expect(new Set(reserved.map((attempt) => attempt.session)).size).toBe(2); // повтор не занял второй слот
    const holders = new Set(reserved.map((attempt) => attempt.session));
    sessions.forEach((session, index) => {
      const result = results[index] as PromiseSettledResult<unknown>;
      // Слот держит — вызов прошёл (повтор `s-01` тоже); не держит — отказ именно по потолку слотов, не сбой замка.
      if (holders.has(session)) expect(result.status).toBe('fulfilled');
      else expect(result).toMatchObject({ status: 'rejected', reason: { code: 'concurrent' } });
    });
  });

  it('перезапуск не выдаёт новый бюджет: счётчики читаются с диска, окно запусков и новые сессии на месте', async () => {
    await updateMap(project, workId, (map) => {
      const lead = addActive(map);
      // Счётчики и журнал старых spawn сохраняются; новые операции их не создают.
      const child = addSession(map, { provider: 'claude', label: 'legacy', task: '' });
      child.parent = lead;
      const at = new Date().toISOString();
      map.resources = { seq: 1, spawned: 1, spawnedByRoom: {}, attempts: [{ id: 'a-0001', kind: 'spawn', state: 'spent', at, settledAt: at, actor: lead, session: child.id, room: null, owner: `mcp:${lead}` }] };
      const attempt = reserveAttempt(map, { kind: 'launch', actor: 'human', session: lead, owner: 'host-A', limits: limits() });
      settleAttempt(map, attempt.id, 'host-A', 'spent');
    });

    // «Другой процесс» читает ту же карту заново — ничего не помнит, кроме базы.
    const after = readStoredMap(project, workId);
    expect(after.resources?.spawned).toBe(1);
    expect(after.resources?.attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([
      ['spawn', 'spent'],
      ['launch', 'spent'],
    ]);
    const status = resourceStatus(after, limits({ workLaunches: 1 }), Date.now());
    expect(status.work.launches.remaining).toBe(0);
  });

  it('прежняя карта без журнала читается, бюджет начинается с нуля; битый журнал — отказ читать', () => {
    const plain = JSON.stringify(emptyMap());
    expect(parseMap(plain, 'map.json').resources).toBeUndefined();

    const broken = { ...emptyMap(), resources: { seq: 'x', spawned: 0, spawnedByRoom: {}, attempts: [] } };
    expect(() => parseMap(JSON.stringify(broken), 'map.json')).toThrow('invalid resource ledger');
    const badAttempt = { ...emptyMap(), resources: { seq: 1, spawned: 0, spawnedByRoom: {}, attempts: [{ id: 'a-0001', kind: 'boom' }] } };
    expect(() => parseMap(JSON.stringify(badAttempt), 'map.json')).toThrow('invalid resource ledger');
  });
});

describe('ownership resource accounting', () => {
  it('owns multiple rooms without consuming room slots or broadcast deliveries', () => {
    const map = emptyMap();
    const owner = addActive(map);
    const member = addActive(map);
    const first = addRoom(map, { title: 'one', creator: owner, ownerId: owner, members: [member] });
    addRoom(map, { title: 'two', creator: owner, ownerId: owner, members: [] });
    expect(roomOfSession(map, owner)).toBeNull();
    const status = resourceStatus(map, limits(), NOW, first.id);
    expect(status.room?.concurrent.used).toBe(1);
    expect(status.work.concurrent.used).toBe(2);
    expect(status.work).not.toHaveProperty('spawnDepth');
    expect(RESOURCE_COVERAGE.counted).not.toContain('spawn_session');
    expect(countRecipients(map, HUMAN, first.id, [])).toBe(1);
    expect(countRecipients(map, member, first.id, [owner])).toBe(1);
  });
});

describe('рои: пороги, отказы и проверка до общего резерва (спека роя v1, 5)', () => {
  const AT = iso(NOW);
  const swarmOf = (sessionIds: string[]): WorkSwarm => ({
    id: 'sw-01', tag: 'Research', creator: { kind: 'human' }, objective: 'Audit', queen: sessionIds[0]!,
    members: sessionIds.map((sessionId, index) => ({ sessionId, role: index === 0 ? 'queen' : 'drone', n: index === 0 ? 1 : index, addedAt: AT, handedAt: null })),
    status: 'running', createdAt: AT, endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null,
  });
  /** Карта с роем из `count` участников; `active` из них живые, остальные закрыты. */
  const mapWithSwarm = (count: number, active: number): { map: WorkMap; swarm: WorkSwarm } => {
    const map = emptyMap();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = addSession(map, { provider: 'claude', label: `m${i}`, task: 't' }).id;
      transitionSession(map, id, i < active ? 'active' : 'closed');
      ids.push(id);
    }
    const swarm = swarmOf(ids);
    map.swarms = [swarm];
    return { map, swarm };
  };

  it('умолчания и границы: 16 (2…64), 8 (2…64), 64 (0…1000), 6 (0…100), срок 90 (0…1440)', () => {
    expect(DEFAULT_RESOURCE_LIMITS).toMatchObject({ swarmSessions: 16, swarmConcurrent: 8, workSwarmSessions: 64, workSwarms: 6, swarmMinutes: 90 });
    expect(RESOURCE_LIMIT_BOUNDS.swarmSessions).toEqual({ min: 2, max: 64 });
    expect(RESOURCE_LIMIT_BOUNDS.swarmConcurrent).toEqual({ min: 2, max: 64 });
    expect(RESOURCE_LIMIT_BOUNDS.workSwarmSessions).toEqual({ min: 0, max: 1000 });
    expect(RESOURCE_LIMIT_BOUNDS.workSwarms).toEqual({ min: 0, max: 100 });
    expect(RESOURCE_LIMIT_BOUNDS.swarmMinutes).toEqual({ min: 0, max: 1440 });
    for (const key of ['swarmSessions', 'swarmConcurrent', 'workSwarmSessions', 'workSwarms', 'swarmMinutes'] as const) {
      expect(RESOURCE_LIMIT_KEYS).toContain(key);
    }
  });

  it('четыре кода отказа: область swarm, счётчики и текст, а агенту ещё и «только человек»', () => {
    const cases: Array<[ConstructorParameters<typeof ResourceDeniedError>[0], RegExp]> = [
      ['swarms', /swarm limit reached: agents created 6 of 6 swarms in this workspace in the last 24 hours; wait or raise the limit in Settings/],
      ['swarm-sessions', /swarm size limit reached: 6 of 6 sessions already belong to this swarm/],
      ['swarm-concurrent', /swarm concurrency limit reached: 6 of 6 sessions of this swarm are running or reserved/],
      ['swarm-total', /swarm session limit reached: agents created 6 of 6 swarm sessions in this workspace in the last 24 hours; wait or raise the limit in Settings/],
    ];
    for (const [code, text] of cases) {
      const error = new ResourceDeniedError(code, 'swarm', 6, 6);
      expect(error).toMatchObject({ code, scope: 'swarm', used: 6, limit: 6 });
      expect(error.message).toMatch(text);
      expect(error.message).toContain('Settings');
      expect(deniedForAgent(error)).toContain('Only the human can raise this limit');
    }
  });

  it('рой жив и места есть: отказа нет, карта не меняется', () => {
    const { map, swarm } = mapWithSwarm(3, 3);
    const before = JSON.stringify(map);
    expect(checkSwarmSpawn(map, limits(), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
    expect(JSON.stringify(map)).toBe(before);
  });

  it('swarm-sessions: участников уже столько, сколько порог, королева включена', () => {
    const { map, swarm } = mapWithSwarm(4, 0);
    const error = checkSwarmSpawn(map, limits({ swarmSessions: 4 }), { swarm, creatingSwarm: false, byAgent: true });
    expect(error).toMatchObject({ code: 'swarm-sessions', scope: 'swarm', used: 4, limit: 4 });
    expect(checkSwarmSpawn(map, limits({ swarmSessions: 5 }), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
  });

  it('swarm-total: сессии роёв, созданные агентами за сутки; ноль — рои агентам запрещены; человека не касается', () => {
    const { map, swarm } = mapWithSwarm(2, 2);
    map.resources = { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmSpawned: 5, recent: recentOf('swarm-session', 5) };
    expect(checkSwarmSpawn(map, limits({ workSwarmSessions: 5 }), { swarm, creatingSwarm: false, byAgent: true }))
      .toMatchObject({ code: 'swarm-total', scope: 'swarm', used: 5, limit: 5 });
    expect(checkSwarmSpawn(map, limits({ workSwarmSessions: 6 }), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
    expect(checkSwarmSpawn(map, limits({ workSwarmSessions: 0 }), { swarm: null, creatingSwarm: true, byAgent: true })?.code).toBe('swarm-total');
    // `swarms.create` человека: ни одного порога работы, пока нет роя, который мог бы упереться в размер.
    expect(checkSwarmSpawn(map, limits({ workSwarmSessions: 0, workSwarms: 0 }), { swarm: null, creatingSwarm: true, byAgent: false })).toBeNull();
  });

  it('swarms: роёв, созданных агентами за сутки, уже порог — только для создания роя', () => {
    const map = emptyMap();
    map.resources = { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmsCreated: 6, recent: recentOf('swarm', 6) };
    expect(checkSwarmSpawn(map, limits(), { swarm: null, creatingSwarm: true, byAgent: true }))
      .toMatchObject({ code: 'swarms', scope: 'swarm', used: 6, limit: 6 });
    expect(checkSwarmSpawn(map, limits({ workSwarms: 7 }), { swarm: null, creatingSwarm: true, byAgent: true })).toBeNull();
    // Добавить участника в уже созданный рой это не мешает.
    const { map: inner, swarm } = mapWithSwarm(2, 2);
    inner.resources = { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmsCreated: 6, recent: recentOf('swarm', 6) };
    expect(checkSwarmSpawn(inner, limits(), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
    // Без счётчиков (старая карта) — ноль; ноль порога — запрет.
    expect(checkSwarmSpawn(emptyMap(), limits({ workSwarms: 0 }), { swarm: null, creatingSwarm: true, byAgent: true })?.code).toBe('swarms');
    expect(checkSwarmSpawn(emptyMap(), limits(), { swarm: null, creatingSwarm: true, byAgent: true })).toBeNull();
  });

  it('swarm-concurrent: считаются живые и заказанные (pending) участники этого роя, закрытые и чужие — нет', () => {
    const { map, swarm } = mapWithSwarm(6, 3);
    const ordered = addSession(map, { provider: 'claude', label: 'p', task: 't' });
    swarm.members.push({ sessionId: ordered.id, role: 'drone', n: 5, addedAt: AT, handedAt: null });
    const stranger = addActive(map);
    expect(stranger).not.toBe(ordered.id);
    // Живых три, заказанный один: четыре.
    expect(checkSwarmSpawn(map, limits({ swarmConcurrent: 4 }), { swarm, creatingSwarm: false, byAgent: true }))
      .toMatchObject({ code: 'swarm-concurrent', scope: 'swarm', used: 4, limit: 4 });
    expect(checkSwarmSpawn(map, limits({ swarmConcurrent: 5 }), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
    // Сдавший места не держит, даже пока хост не закрыл его сессию.
    swarm.members.find((member) => member.sessionId === ordered.id)!.handedAt = AT;
    expect(checkSwarmSpawn(map, limits({ swarmConcurrent: 4 }), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
  });

  it('порядок: размер роя раньше сессий роёв работы, они раньше живых; создание роя — число роёв после сессий', () => {
    const { map, swarm } = mapWithSwarm(4, 4);
    map.resources = {
      seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmSpawned: 100, swarmsCreated: 100,
      recent: [...recentOf('swarm-session', 100), ...recentOf('swarm', 100)],
    };
    const all = limits({ swarmSessions: 4, swarmConcurrent: 2, workSwarmSessions: 1, workSwarms: 1 });
    expect(checkSwarmSpawn(map, all, { swarm, creatingSwarm: false, byAgent: true })?.code).toBe('swarm-sessions');
    expect(checkSwarmSpawn(map, { ...all, swarmSessions: 64 }, { swarm, creatingSwarm: false, byAgent: true })?.code).toBe('swarm-total');
    expect(checkSwarmSpawn(map, { ...all, swarmSessions: 64, workSwarmSessions: 1000 }, { swarm, creatingSwarm: false, byAgent: true })?.code).toBe('swarm-concurrent');
    expect(checkSwarmSpawn(map, all, { swarm: null, creatingSwarm: true, byAgent: true })?.code).toBe('swarm-total');
    expect(checkSwarmSpawn(map, { ...all, workSwarmSessions: 1000 }, { swarm: null, creatingSwarm: true, byAgent: true })?.code).toBe('swarms');
  });

  it('общий резерв остаётся за хостом: проверка роёв его не берёт и обычные пороги спавна не читает', () => {
    const { map, swarm } = mapWithSwarm(2, 2);
    map.resources = { seq: 0, spawned: 50, spawnedByRoom: {}, attempts: [], recent: recentOf('session', 50) };
    expect(checkSwarmSpawn(map, limits({ workNewSessions: 0 }), { swarm, creatingSwarm: false, byAgent: true })).toBeNull();
    expect(map.resources.attempts).toEqual([]);
    expect(map.resources.spawned).toBe(50);
    expect(map.resources.recent).toHaveLength(50);
  });

  it('resourceStatus: счётчики роёв по работе за сутки; исчерпанные пороги названы кодами роёв', () => {
    const map = emptyMap();
    map.resources = {
      seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmSpawned: 3, swarmsCreated: 2,
      recent: [...recentOf('swarm-session', 3), ...recentOf('swarm', 2)],
    };
    const status = resourceStatus(map, limits({ workSwarmSessions: 10, workSwarms: 2 }), NOW);
    expect(status.work.swarmSessions).toEqual({ used: 3, reserved: 0, limit: 10, remaining: 7 });
    expect(status.work.swarms).toEqual({ used: 2, reserved: 0, limit: 2, remaining: 0 });
    expect(status.exhausted).toContain('swarms');
    expect(status.exhausted).not.toContain('swarm-total');
    expect(resourceStatus(emptyMap(), limits(), NOW).work.swarms.used).toBe(0);
  });

  it('validateResources: необязательные счётчики роёв — неотрицательные целые, иначе карта не читается', () => {
    const ledger = (extra: Record<string, unknown>) => ({ ...emptyMap(), resources: { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], ...extra } });
    const ok = parseMap(JSON.stringify(ledger({ swarmSpawned: 4, swarmsCreated: 0 })), 'map.json');
    expect(ok.resources).toMatchObject({ swarmSpawned: 4, swarmsCreated: 0 });
    expect(parseMap(JSON.stringify(ledger({})), 'map.json').resources?.swarmSpawned).toBeUndefined();
    for (const bad of [{ swarmSpawned: -1 }, { swarmsCreated: 1.5 }, { swarmSpawned: '2' }, { swarmsCreated: null }]) {
      expect(() => parseMap(JSON.stringify(ledger(bad)), 'map.json')).toThrow('invalid resource ledger');
    }
  });
});

describe('создания агентами за сутки: скользящее окно вместо пожизненных счётчиков', () => {
  const HOUR = 60 * 60 * 1000;

  it('создания старше суток не считаются', () => {
    const map = emptyMap();
    map.resources = { seq: 0, spawned: 50, spawnedByRoom: {}, attempts: [], recent: recentOf('session', 50, null, NOW - 25 * HOUR) };
    expect(recentCreations(map, 'session', NOW)).toBe(0);

    // Граница окна: запись ровно суточной давности уже вне его, на миллисекунду моложе — ещё внутри.
    map.resources.recent = [
      { kind: 'session', at: iso(NOW - CREATION_WINDOW_MS), room: null },
      { kind: 'session', at: iso(NOW - CREATION_WINDOW_MS + 1), room: null },
    ];
    expect(recentCreations(map, 'session', NOW)).toBe(1);

    // Журнала нет (карта до этого окна): пусто, как бы далеко ни ушёл пожизненный счётчик.
    const before = emptyMap();
    before.resources = { seq: 0, spawned: 500, spawnedByRoom: {}, attempts: [] };
    expect(recentCreations(before, 'session', NOW)).toBe(0);
    expect(recentCreations(emptyMap(), 'session', NOW)).toBe(0);
  });

  it('noteCreation выбрасывает записи старше суток', () => {
    const map = emptyMap();
    map.resources = {
      seq: 0, spawned: 2, spawnedByRoom: {}, attempts: [],
      recent: [...recentOf('session', 1, null, NOW - CREATION_WINDOW_MS - 1), ...recentOf('swarm', 1, null, NOW - HOUR)],
    };
    noteCreation(map, 'session', 'r-01', NOW);
    expect(map.resources.recent).toEqual([...recentOf('swarm', 1, null, NOW - HOUR), ...recentOf('session', 1, 'r-01', NOW)]);
    // Пишется только журнал: пожизненные счётчики растут отдельно, у хоста.
    expect(map.resources.spawned).toBe(2);

    // Карта без журнала получает его с первой записью.
    const fresh = emptyMap();
    noteCreation(fresh, 'swarm', null, NOW);
    expect(fresh.resources).toEqual({ seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], recent: recentOf('swarm', 1) });
  });

  it('комнатный счёт — только своя комната', () => {
    const map = emptyMap();
    for (const room of ['r-1', 'r-1', 'r-1', 'r-2', 'r-2']) noteCreation(map, 'session', room, NOW);
    noteCreation(map, 'session', null, NOW);
    noteCreation(map, 'swarm', null, NOW);
    expect(recentCreations(map, 'session', NOW, 'r-1')).toBe(3);
    expect(recentCreations(map, 'session', NOW, 'r-2')).toBe(2);
    expect(recentCreations(map, 'session', NOW, 'r-3')).toBe(0);
    // По работе — все комнаты и сессии вне комнат; рои — отдельный вид.
    expect(recentCreations(map, 'session', NOW)).toBe(6);
    expect(recentCreations(map, 'swarm', NOW)).toBe(1);
    expect(recentCreations(map, 'swarm-session', NOW)).toBe(0);
  });

  it('validateResources принимает recent и отвергает кривые строки', () => {
    const ledger = (recent: unknown) => ({ ...emptyMap(), resources: { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], recent } });
    const rows = [...recentOf('session', 1, 'r-01'), ...recentOf('swarm-session', 1), ...recentOf('swarm', 1)];
    expect(parseMap(JSON.stringify(ledger(rows)), 'map.json').resources?.recent).toEqual(rows);
    expect(parseMap(JSON.stringify(ledger([])), 'map.json').resources?.recent).toEqual([]);
    // Поля нет — карта до этого окна читается, журнал пуст.
    const without = { ...emptyMap(), resources: { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [] } };
    expect(parseMap(JSON.stringify(without), 'map.json').resources?.recent).toBeUndefined();

    const at = iso(NOW);
    const bad: unknown[] = [
      {}, // не список
      ['x'], // строка не объект
      [null],
      [{ kind: 'boom', at, room: null }], // вид вне набора
      [{ kind: 'session', at: 5, room: null }], // at не строка
      [{ kind: 'session', at: 'вчера', room: null }], // at не время
      [{ kind: 'session', at, room: 7 }], // комната не строка и не null
      [{ kind: 'session', at }], // комнаты нет совсем
    ];
    for (const recent of bad) expect(() => parseMap(JSON.stringify(ledger(recent)), 'map.json')).toThrow('invalid resource ledger');
  });

  it('рои: пожизненные swarmSpawned и swarmsCreated порог не двигают, записи старше суток не считаются', () => {
    const map = emptyMap();
    map.resources = {
      seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [], swarmSpawned: 500, swarmsCreated: 500,
      recent: [...recentOf('swarm-session', 64, null, NOW - 25 * HOUR), ...recentOf('swarm', 6, null, NOW - 25 * HOUR)],
    };
    const create = { swarm: null, creatingSwarm: true, byAgent: true } as const;
    expect(checkSwarmSpawn(map, limits(), create)).toBeNull();

    // Свежие записи считаются, а рои и сессии роёв — каждый по своему виду.
    map.resources.recent = recentOf('swarm-session', 64);
    expect(checkSwarmSpawn(map, limits(), create)).toMatchObject({ code: 'swarm-total', used: 64, limit: 64 });
    map.resources.recent = recentOf('swarm', 6);
    expect(checkSwarmSpawn(map, limits(), create)).toMatchObject({ code: 'swarms', used: 6, limit: 6 });
  });

  it('resourceStatus считает созданное за сутки, а не за всё время', () => {
    const map = emptyMap();
    map.resources = {
      seq: 0, spawned: 80, spawnedByRoom: { 'r-1': 30 }, attempts: [], swarmSpawned: 90, swarmsCreated: 9,
      recent: [
        ...recentOf('session', 3, 'r-1'), ...recentOf('session', 2, 'r-2'), ...recentOf('session', 40, 'r-1', NOW - 25 * HOUR),
        ...recentOf('swarm-session', 4), ...recentOf('swarm', 1),
      ],
    };
    const status = resourceStatus(map, limits(), NOW, 'r-1');
    expect(status.work.newSessions).toEqual({ used: 5, reserved: 0, limit: 50, remaining: 45 });
    expect(status.room?.newSessions).toEqual({ used: 3, reserved: 0, limit: 12, remaining: 9 });
    expect(status.work.swarmSessions.used).toBe(4);
    expect(status.work.swarms.used).toBe(1);
    expect(status.exhausted).not.toContain('new-sessions');
    expect(status.exhausted).not.toContain('swarms');
    expect(status.exhausted).not.toContain('swarm-total');
  });

  it('тексты отказов new-sessions: счёт за последние 24 часа, область и «wait or raise»', () => {
    expect(new ResourceDeniedError('new-sessions', 'work', 50, 50).message).toBe(
      'new-session limit reached: agents created 50 of 50 sessions in this workspace in the last 24 hours; wait or raise the limit in Settings',
    );
    expect(new ResourceDeniedError('new-sessions', 'room', 12, 12).message).toBe(
      'new-session limit reached: agents created 12 of 12 sessions in this room in the last 24 hours; wait or raise the limit in Settings',
    );
    expect(deniedForAgent(new ResourceDeniedError('new-sessions', 'work', 50, 50))).toContain('Only the human can raise this limit');
  });
});
