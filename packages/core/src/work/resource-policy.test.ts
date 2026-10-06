/** Бюджет работы и комнаты (P37): допуск, резервы, окна, отмена и неоднозначные владельцы — чистыми фикстурами и через замок карты. */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, addSession, parseMap, transitionSession } from './map.js';
import {
  DEFAULT_RESOURCE_LIMITS,
  RESOURCE_COVERAGE,
  RESOURCE_WINDOW_MS,
  ResourceDeniedError,
  admitSpawn,
  assertMessageBudget,
  attemptKindFor,
  deniedForAgent,
  limitsFromConfig,
  reserveAttempt,
  resourceStatus,
  settleAttempt,
  settleByEvidence,
  spawnDepthOf,
  teamStartFits,
  type ResourceLimits,
} from './resource-policy.js';
import { addRoom } from './rooms.js';
import { createWork, readMap, updateMap, workPaths } from './store.js';
import { HUMAN, PARLEY, SYSTEM, type WorkMap } from './types.js';

/** Чуть впереди настоящих часов: отметки `history` из `transitionSession` не должны выглядеть свидетельством запуска после резерва. */
const NOW = Date.now() + 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const limits = (patch: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...patch });

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'бюджет', goal: '', status: 'active', createdAt: iso(NOW), updatedAt: iso(NOW) },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Сессия `active`: так её видит бюджет — как занятый слот. */
function addActive(map: WorkMap, parent: string | null = null): string {
  const session = addSession(map, { provider: 'claude', label: 'x', task: 'y', parent });
  transitionSession(map, session.id, 'active');
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

describe('admitSpawn: глубина, новые сессии и слоты', () => {
  it('глубина: корень может породить ребёнка, ребёнок — внука, но не глубже порога', () => {
    const map = emptyMap();
    const root = addActive(map);
    const child = addSession(map, { provider: 'claude', label: 'c', task: 't', parent: root }).id;
    const grand = addSession(map, { provider: 'claude', label: 'g', task: 't', parent: child }).id;
    expect(spawnDepthOf(map, root)).toBe(0);
    expect(spawnDepthOf(map, grand)).toBe(2);

    expect(() => admitSpawn(map, { actor: root, limits: limits({ spawnDepth: 3 }), now: NOW })).not.toThrow();
    const refusal = denied(() => admitSpawn(map, { actor: grand, limits: limits({ spawnDepth: 2 }), now: NOW }));
    expect(refusal.code).toBe('depth');
    expect(refusal.message).toContain('depth');
  });

  it('новые сессии: потолок работы и потолок комнаты породившего, счётчик не уменьшается от удаления', () => {
    const map = emptyMap();
    const lead = addActive(map);
    addRoom(map, { title: 'r', creator: lead, members: [] });
    const tight = limits({ workNewSessions: 3, roomNewSessions: 2, workConcurrent: 50, roomConcurrent: 50 });

    admitSpawn(map, { actor: lead, limits: tight, now: NOW });
    admitSpawn(map, { actor: lead, limits: tight, now: NOW });
    const room = denied(() => admitSpawn(map, { actor: lead, limits: tight, now: NOW }));
    expect([room.code, room.scope, room.limit]).toEqual(['new-sessions', 'room', 2]);

    // Агент вне комнаты упирается в потолок работы: комнатный его не касается.
    const loner = addActive(map);
    admitSpawn(map, { actor: loner, limits: tight, now: NOW });
    const work = denied(() => admitSpawn(map, { actor: loner, limits: tight, now: NOW }));
    expect([work.code, work.scope]).toEqual(['new-sessions', 'work']);
    expect(map.resources?.spawned).toBe(3);
    expect(map.resources?.spawnedByRoom).toEqual({ 'r-01': 2 });
  });

  it('слоты: живые и заказанные (pending с родителем) занимают место, закрытые и ручные pending — нет', () => {
    const map = emptyMap();
    const root = addActive(map);
    addSession(map, { provider: 'claude', label: 'c', task: 't', parent: root }); // заказан агентом: занимает слот
    addSession(map, { provider: 'claude', label: 'm', task: '' }); // ручной pending без родителя: не занимает
    const closed = addActive(map);
    transitionSession(map, closed, 'closed');

    const two = limits({ workConcurrent: 2 });
    const refusal = denied(() => admitSpawn(map, { actor: root, limits: two, now: NOW }));
    expect([refusal.code, refusal.used, refusal.limit]).toEqual(['concurrent', 2, 2]);
    expect(() => admitSpawn(map, { actor: root, limits: limits({ workConcurrent: 3 }), now: NOW })).not.toThrow();
  });

  it('отказ ничего не оставляет в карте: ни резерва, ни счётчика', () => {
    const map = emptyMap();
    const root = addActive(map);
    denied(() => admitSpawn(map, { actor: root, limits: limits({ workNewSessions: 0 }), now: NOW }));
    expect(map.resources?.spawned ?? 0).toBe(0);
    expect(map.resources?.attempts ?? []).toEqual([]);
  });
});

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
    addRoom(map, { title: 'r', creator: a, members: [b] });
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
    expect(() => assertMessageBudget(map, { ...base, limits: limits({ workMessages: 4, roomMessages: 4 }) })).not.toThrow();
    const work = denied(() => assertMessageBudget(map, { ...base, limits: limits({ workMessages: 3, roomMessages: 50 }) }));
    expect([work.code, work.scope, work.used]).toEqual(['messages', 'work', 3]);
    const inRoom = denied(() => assertMessageBudget(map, { ...base, limits: limits({ workMessages: 50, roomMessages: 3 }) }));
    expect([inRoom.code, inRoom.scope]).toEqual(['messages', 'room']);
    // Прямое письмо вне комнаты комнатный потолок не задевает.
    expect(() => assertMessageBudget(map, { ...base, room: null, limits: limits({ workMessages: 50, roomMessages: 3 }) })).not.toThrow();
  });

  it('письма старше часа не считаются', () => {
    const map = emptyMap();
    const a = addActive(map);
    const b = addActive(map);
    addMessage(map, { from: a, to: [b], text: 'старое' }, iso(NOW - RESOURCE_WINDOW_MS - 1));
    expect(() => assertMessageBudget(map, { actor: a, room: null, messages: 1, recipients: 1, limits: limits({ workMessages: 1 }), now: NOW })).not.toThrow();
  });

  it('рассылка: потолок адресатов считает каждого получателя, а письмо — как одно', () => {
    const map = emptyMap();
    const a = addActive(map);
    const members = [addActive(map), addActive(map), addActive(map)];
    const id = room(map, a, members);
    addMessage(map, { from: a, to: [], text: 'всем', roomId: id }, iso(NOW - 10)); // три адресата

    const fan = limits({ fanout: 4 });
    expect(() => assertMessageBudget(map, { actor: a, room: id, messages: 1, recipients: 1, limits: fan, now: NOW })).not.toThrow();
    const refusal = denied(() => assertMessageBudget(map, { actor: a, room: id, messages: 1, recipients: 2, limits: fan, now: NOW }));
    expect([refusal.code, refusal.used, refusal.limit]).toEqual(['fanout', 3, 4]);
  });

  it('приглашения: N приглашённых — N писем и N адресатов сразу', () => {
    const map = emptyMap();
    const a = addActive(map);
    const refusal = denied(() =>
      assertMessageBudget(map, { actor: a, room: null, messages: 5, recipients: 5, limits: limits({ workMessages: 4 }), now: NOW }),
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
    addSession(map, { provider: 'claude', label: 'c', task: 't', parent: lead }); // заказана
    const id = addRoom(map, { title: 'r', creator: lead, members: [member] }).id;
    admitSpawn(map, { actor: lead, limits: limits(), now: NOW });
    addMessage(map, { from: lead, to: [member], text: 'x', roomId: id }, iso(NOW - 5));

    const status = resourceStatus(map, limits({ workConcurrent: 4, roomConcurrent: 2 }), NOW, id);
    expect(status.work.concurrent).toEqual({ used: 2, reserved: 1, limit: 4, remaining: 1 });
    expect(status.room?.concurrent).toEqual({ used: 2, reserved: 0, limit: 2, remaining: 0 });
    expect(status.work.newSessions.used).toBe(1);
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

  it('двенадцать одновременных spawn не превышают слоты: проходят ровно разрешённые', async () => {
    await updateMap(project, workId, (map) => {
      addActive(map);
    });
    const tight = limits({ workNewSessions: 4, workConcurrent: 50 });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        updateMap(project, workId, (map) => {
          const attempt = admitSpawn(map, { actor: 's-01', limits: tight });
          attempt.session = addSession(map, { provider: 'claude', label: 'k', task: 't', parent: 's-01' }).id;
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(refused).toHaveLength(8);
    expect(refused.every((result) => result.reason instanceof ResourceDeniedError)).toBe(true);
    const map = await readMap(project, workId);
    expect(map.sessions).toHaveLength(5);
    expect(map.resources?.spawned).toBe(4);
  });

  it('параллельные резервы запуска не обходят общий потолок слотов, повтор той же сессии не берёт второй', async () => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 6; i += 1) addSession(map, { provider: 'claude', label: 'x', task: 't' });
    });
    const two = limits({ workConcurrent: 2, workLaunches: 50 });
    // Замок карты берут опросом, порядок захвата не задан: какие две сессии займут слоты и достанется ли слот
    // повтору `s-01`, решает очередь. Проверяются инварианты, не порядок. Таймаут замка — запас на нагрузку:
    // семь записей подряд с индексом и `.bak` под ней укладываются в три секунды по умолчанию не всегда.
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
      admitSpawn(map, { actor: lead, limits: limits({ workNewSessions: 1 }) }).session = addSession(map, { provider: 'claude', label: 'k', task: 't', parent: lead }).id;
      const attempt = reserveAttempt(map, { kind: 'launch', actor: 'human', session: lead, owner: 'host-A', limits: limits() });
      settleAttempt(map, attempt.id, 'host-A', 'spent');
    });

    // «Другой процесс» читает ту же карту заново — ничего не помнит, кроме файла.
    const after = parseMap(await readFile(workPaths(project, workId).map, 'utf8'), workPaths(project, workId).map);
    expect(after.resources?.spawned).toBe(1);
    expect(after.resources?.attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([
      ['spawn', 'spent'],
      ['launch', 'spent'],
    ]);
    const refusal = denied(() => admitSpawn(after, { actor: 's-01', limits: limits({ workNewSessions: 1 }) }));
    expect(refusal.code).toBe('new-sessions');
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
