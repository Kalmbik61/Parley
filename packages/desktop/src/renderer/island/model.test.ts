/**
 * Модель острова: счётчики пилюли, группы «в работе» по работам, комнаты по участникам, полная активность Codex, подписи
 * сессий; Done (ход окончен, не смотрели): строка с ключом конца хода, Clear, порядок после работы, комната `done`;
 * удержанные ключи: посмотренная (`idle`) сессия с концом хода и ключом в `held` остаётся строкой Done; `seen` у строки
 * Done: ложно для `unseen`, истинно для удержанной `idle`.
 */

import { describe, expect, it } from 'vitest';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeRoom, makeSession, makeSwarm, makeSwarmMember, makeWork } from '../test-utils/work-fixtures.js';
import { islandModel, sessionLabels } from './model.js';

const PROJECT = '/Users/me/Desktop/Доки ВК';
const ref = (sessionId: string, workId = 'w-1') => ({ projectPath: PROJECT, workId, sessionId });
const ENDED = '2026-10-13T10:00:00.000Z';
const NONE: ReadonlySet<string> = new Set();
/** Ключ Done: сессия и конец хода через `\0`. */
const doneKey = (sessionId: string, endedAt = ENDED) => `${refKey(ref(sessionId))}\u0000${endedAt}`;

function work() {
  const room = { ...makeRoom('r-1', 'Refunds'), members: ['s-02', 's-03'] };
  return makeWork('w-1', {
    projectPath: PROJECT,
    title: 'Backend',
    sessions: [
      makeSession('s-01', 'lead'),
      makeSession('s-02', 'api'),
      makeSession('s-03', 'review', { provider: 'glm' }),
      makeSession('s-04', 'codex', { provider: 'codex' }),
      makeSession('s-05', 'done'),
    ],
    rooms: [room],
  });
}

describe('модель острова', () => {
  const tasks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), agentType: 'worker', description: `Task ${index}`, background: true }));
  const metrics = (items = tasks(1), subagents = 1) => ({ tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents, model: null, tasks: items });

  it('Done is orthogonal to children; Clear retains one background parent without phantom work', () => {
    const entry = work();
    const live = makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED, metrics: metrics() });
    const model = islandModel([entry], activityMap([live]), NONE, NONE, NONE);
    expect(model).toMatchObject({ working: 0, done: 1, subagents: 1 });
    expect(model.groups[0]?.rows.filter((row) => row.kind === 'session')).toHaveLength(1);
    expect(model.groups[0]?.rows[0]).toMatchObject({ state: 'done', doneKey: doneKey('s-05'), tasks: { items: tasks(1), reported: 1, total: 1 } });
    const cleared = new Set([doneKey('s-05')]);
    expect(islandModel([entry], activityMap([live]), NONE, cleared, NONE).groups[0]?.rows[0]).toMatchObject({ state: 'subagents' });
    expect(islandModel([entry], activityMap([live]), NONE, cleared, NONE)).toMatchObject({ working: 0, done: 0, active: true });
    const ended = { ...live, metrics: metrics([], 0) };
    expect(islandModel([entry], activityMap([ended]), NONE, cleared, NONE).groups).toEqual([]);
    const next = makeActivity(ref('s-05'), 'unseen', { turnEndedAt: '2026-10-14T10:00:00.000Z', metrics: metrics([], 0) });
    expect(islandModel([entry], activityMap([next]), NONE, cleared, NONE).done).toBe(1);
    expect(islandModel([], activityMap([live]), NONE, NONE, NONE).groups).toEqual([]);
  });

  it('held background without an end marker stays idle parent with no invented Done or working count', () => {
    const live = makeActivity(ref('s-01'), 'working', { heldByBackground: true, metrics: metrics(), turnEndedAt: null });
    const model = islandModel([work()], activityMap([live]), NONE, NONE, NONE);
    expect(model).toMatchObject({ working: 0, waiting: 0, done: 0, subagents: 1, active: true });
    expect(model.groups[0]?.rows[0]).toMatchObject({ state: 'subagents' });
    const stopped = makeActivity(ref('s-01'), 'idle', { metrics: metrics([], 0) });
    expect(islandModel([work()], activityMap([stopped]), NONE, NONE, NONE).groups).toEqual([]);
  });

  it('task source total, delivered items and reported count remain independent', () => {
    for (const [items, total, reported] of [[tasks(8), 12, 5], [tasks(3), 3, 12], [[], 0, 12]] as const) {
      const live = { ...makeActivity(ref('s-01'), 'idle', { metrics: metrics([...items], reported) }), islandTasksTotal: total };
      const row = islandModel([work()], activityMap([live]), NONE, NONE, NONE).groups[0]?.rows[0];
      expect(row).toMatchObject({ state: 'subagents', tasks: { items, total, reported } });
    }
    const absent = makeActivity(ref('s-01'), 'idle', { metrics: { tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 12, model: null } });
    expect(islandModel([work()], activityMap([absent]), NONE, NONE, NONE).groups[0]?.rows[0]).toMatchObject({ tasks: { items: [], total: null, reported: 12 } });
  });

  it.each([undefined, 'decision', 'completion'] as const)('pending room %s survives busy0/done0 with current live lead and opaque revision identity', (kind) => {
    const entry = work(); const room = entry.map.rooms[0]!;
    room.proposal = { id: 'p-1', from: 's-01', text: 'SECRET-proposal', rev: 1, at: ENDED, ...(kind === undefined ? {} : { kind }) };
    room.lead = 's-02';
    const model = islandModel([entry], {}, NONE, NONE, NONE);
    expect(model).toMatchObject({ working: 0, done: 0, proposals: 1, active: true });
    const row = model.groups[0]?.rows[0];
    expect(row).toMatchObject({ kind: 'room', busy: 0, done: false, proposal: { kind: kind ?? 'decision', lead: 's-02' } });
    expect(JSON.stringify(row)).not.toContain('SECRET');
    const key = row?.kind === 'room' ? row.proposal?.key : null;
    room.proposal.rev = 2; entry.map.sessions.find((s) => s.id === 's-02')!.lifecycle = 'closed';
    const revised = islandModel([entry], {}, NONE, NONE, NONE).groups[0]?.rows[0];
    expect(revised).toMatchObject({ proposal: { lead: 's-03' } });
    expect(revised?.kind === 'room' ? revised.proposal?.key : null).not.toBe(key);
    room.proposal = null;
    expect(islandModel([entry], {}, NONE, NONE, NONE).groups).toEqual([]);
  });

  it('proposals respect active work/archive boundaries and full refs; halted alone adds nothing', () => {
    const entry = work(); const room = entry.map.rooms[0]!;
    room.proposal = { id: 'p-1', from: 's-01', text: 'SECRET', rev: 0, at: ENDED };
    const other = { ...entry, projectPath: '/other/proj' };
    const models = islandModel([entry, other], {}, NONE, NONE, NONE);
    expect(models.groups).toHaveLength(2);
    const keys = models.groups.flatMap((g) => g.rows).map((r) => r.kind === 'room' ? r.proposal?.key : null);
    expect(new Set(keys).size).toBe(2);
    for (const status of ['suspended', 'closed', 'done', 'archived']) {
      Object.assign(entry.map.work, { status });
      expect(islandModel([entry], {}, NONE, NONE, NONE).groups).toEqual([]);
    }
    entry.map.work.status = 'active'; room.archivedAt = ENDED;
    expect(islandModel([entry], {}, NONE, NONE, NONE).groups).toEqual([]);
    room.archivedAt = null; room.proposal = null;
    Object.assign(room, { halted: 'stuck' });
    expect(islandModel([entry], {}, NONE, NONE, NONE).groups).toEqual([]);
  });

  it('работает и ждёт — в пилюле для всех провайдеров; «finished» — Done, а не работа', () => {
    const byRef = activityMap([
      makeActivity(ref('s-01'), 'working'),
      makeActivity(ref('s-02'), 'blocked'),
      makeActivity(ref('s-03'), 'working'),
      makeActivity(ref('s-04'), 'blocked'),
      makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED }),
    ]);
    const model = islandModel([work()], byRef, new Set([refKey(ref('s-02'))]), NONE, NONE);
    expect(model).toMatchObject({ working: 2, waiting: 2, done: 1, providers: ['claude', 'codex', 'glm'], active: true });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ title: 'Backend', project: 'Доки ВК' });
    const sessions = model.groups[0]?.rows.filter((row) => row.kind === 'session') ?? [];
    expect(sessions.map((row) => row.kind === 'session' && row.ref.sessionId)).toEqual(['s-01', 's-02', 's-03', 's-04', 's-05']);
  });

  it('комната в работе, если в работе хоть один её участник', () => {
    const byRef = activityMap([makeActivity(ref('s-03'), 'working')]);
    const rows = islandModel([work()], byRef, new Set(), NONE, NONE).groups[0]?.rows ?? [];
    expect(rows.find((row) => row.kind === 'room')).toMatchObject({ kind: 'room', roomId: 'r-1', title: 'Refunds', busy: 1 });
  });

  it('ждёт без карточки острова — «в терминале»', () => {
    const byRef = activityMap([makeActivity(ref('s-02'), 'blocked')]);
    const row = islandModel([work()], byRef, new Set(), NONE, NONE).groups[0]?.rows[0];
    expect(row).toMatchObject({ kind: 'session', state: 'needs-you', inTerminal: true });
  });

  it('никто не работает и не ждёт — остров неактивен, групп нет', () => {
    expect(islandModel([work()], {}, new Set(), NONE, NONE)).toEqual({ working: 0, waiting: 0, done: 0, providers: [], groups: [], active: false });
  });

  it('работы не active (done, archived) не считаются', () => {
    const done = makeWork('w-2', { projectPath: PROJECT, status: 'done', sessions: [makeSession('s-01', 'x')] });
    const byRef = activityMap([makeActivity(ref('s-01', 'w-2'), 'working')]);
    expect(islandModel([done], byRef, new Set(), NONE, NONE).active).toBe(false);
  });

  it('Done: unseen-сессия — строка с ключом (сессия + конец хода), провайдер в пилюлю не идёт, active не растёт', () => {
    const byRef = activityMap([makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED })]);
    const model = islandModel([work()], byRef, new Set(), NONE, NONE);
    expect(model).toMatchObject({ working: 0, waiting: 0, done: 1, providers: [], active: false });
    expect(model.groups[0]?.rows).toEqual([
      { kind: 'session', key: refKey(ref('s-05')), ref: ref('s-05'), label: 'S05 done', provider: 'claude', state: 'done', inTerminal: false, doneKey: doneKey('s-05'), turnEndedAt: ENDED, seen: false },
    ]);
  });

  it('seen: unseen-сессия — false, удержанная idle — true', () => {
    const unseen = activityMap([makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED })]);
    expect(islandModel([work()], unseen, new Set(), NONE, NONE).groups[0]?.rows[0]).toMatchObject({ state: 'done', seen: false });
    // Ключ в held, но сессия всё ещё unseen — она не просмотрена.
    expect(islandModel([work()], unseen, new Set(), NONE, new Set([doneKey('s-05')])).groups[0]?.rows[0]).toMatchObject({ state: 'done', seen: false });
    const idle = activityMap([makeActivity(ref('s-05'), 'idle', { turnEndedAt: ENDED })]);
    expect(islandModel([work()], idle, new Set(), NONE, new Set([doneKey('s-05')])).groups[0]?.rows[0]).toMatchObject({ state: 'done', seen: true });
  });

  it('Done без времени конца хода — ключ с пустым хвостом, turnEndedAt null', () => {
    const byRef = activityMap([makeActivity(ref('s-05'), 'unseen')]);
    const row = islandModel([work()], byRef, new Set(), NONE, NONE).groups[0]?.rows[0];
    expect(row).toMatchObject({ state: 'done', doneKey: `${refKey(ref('s-05'))}\u0000`, turnEndedAt: null });
  });

  it('Clear прячет Done по ключу; новый конец хода — другой ключ, строка возвращается', () => {
    const cleared = new Set([doneKey('s-05')]);
    const old = activityMap([makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED })]);
    expect(islandModel([work()], old, new Set(), cleared, NONE)).toMatchObject({ done: 0, groups: [] });
    const later = '2026-10-13T10:05:00.000Z';
    const next = activityMap([makeActivity(ref('s-05'), 'unseen', { turnEndedAt: later })]);
    const row = islandModel([work()], next, new Set(), cleared, NONE).groups[0]?.rows[0];
    expect(row).toMatchObject({ state: 'done', doneKey: doneKey('s-05', later) });
  });

  describe('удержанные ключи (held)', () => {
    const HELD: ReadonlySet<string> = new Set([doneKey('s-05')]);

    it('idle с концом хода и ключом в held — такая же строка Done: считается, в комнате done, после работающих', () => {
      const byRef = activityMap([
        makeActivity(ref('s-05'), 'idle', { turnEndedAt: ENDED }),
        makeActivity(ref('s-01'), 'working'),
      ]);
      const model = islandModel([work()], byRef, new Set(), NONE, HELD);
      expect(model).toMatchObject({ working: 1, done: 1, active: true });
      const rows = model.groups[0]?.rows ?? [];
      expect(rows.map((row) => row.kind === 'session' && `${row.ref.sessionId}:${row.state}`)).toEqual(['s-01:working', 's-05:done']);
      expect(rows[1]).toEqual({ kind: 'session', key: refKey(ref('s-05')), ref: ref('s-05'), label: 'S05 done', provider: 'claude', state: 'done', inTerminal: false, doneKey: doneKey('s-05'), turnEndedAt: ENDED, seen: true });
    });

    it('комната done и для удержанной строки', () => {
      const byRef = activityMap([makeActivity(ref('s-02'), 'idle', { turnEndedAt: ENDED })]);
      const room = islandModel([work()], byRef, new Set(), NONE, new Set([doneKey('s-02')])).groups[0]?.rows.find((row) => row.kind === 'room');
      expect(room).toMatchObject({ kind: 'room', roomId: 'r-1', busy: 0, done: true });
    });

    it('idle без ключа в held — строки нет', () => {
      const byRef = activityMap([makeActivity(ref('s-05'), 'idle', { turnEndedAt: ENDED })]);
      expect(islandModel([work()], byRef, new Set(), NONE, NONE)).toMatchObject({ done: 0, groups: [] });
      // Ключ другого конца хода той же сессии не держит.
      expect(islandModel([work()], byRef, new Set(), NONE, new Set([doneKey('s-05', '2026-10-13T09:00:00.000Z')]))).toMatchObject({ done: 0, groups: [] });
    });

    it('idle с ключом в held, но и в cleared — строки нет', () => {
      const byRef = activityMap([makeActivity(ref('s-05'), 'idle', { turnEndedAt: ENDED })]);
      expect(islandModel([work()], byRef, new Set(), new Set([doneKey('s-05')]), HELD)).toMatchObject({ done: 0, groups: [] });
    });

    it('idle без конца хода (turnEndedAt null) — строки нет, даже если ключ с пустым хвостом в held', () => {
      const byRef = activityMap([makeActivity(ref('s-05'), 'idle')]);
      const held = new Set([`${refKey(ref('s-05'))}\u0000`]);
      expect(islandModel([work()], byRef, new Set(), NONE, held)).toMatchObject({ done: 0, groups: [] });
    });

    it('сессия снова заработала — обычная строка в работе, а не Done', () => {
      const byRef = activityMap([makeActivity(ref('s-05'), 'working', { turnEndedAt: ENDED })]);
      const model = islandModel([work()], byRef, new Set(), NONE, HELD);
      expect(model).toMatchObject({ working: 1, done: 0, active: true });
      expect(model.groups[0]?.rows[0]).toMatchObject({ state: 'working' });
    });
  });

  it('Codex Done виден даже без текста ответа и имеет тот же ключ конца хода', () => {
    const byRef = activityMap([makeActivity(ref('s-04'), 'unseen', { turnEndedAt: ENDED })]);
    const model = islandModel([work()], byRef, new Set(), NONE, NONE);
    expect(model).toMatchObject({ working: 0, waiting: 0, done: 1, active: false, providers: [] });
    expect(model.groups[0]?.rows).toEqual([
      { kind: 'session', key: refKey(ref('s-04')), ref: ref('s-04'), label: 'S04 codex', provider: 'codex', state: 'done', inTerminal: false, doneKey: doneKey('s-04'), turnEndedAt: ENDED, seen: false },
    ]);
  });

  it('Codex в двух worktree: working/needs-you/Done, комнаты и счётчики без двойного учёта', () => {
    const paths = ['/tmp/worktree-a', '/tmp/worktree-b'];
    const entries = paths.map((projectPath) => makeWork('w-1', {
      projectPath,
      sessions: [makeSession('s-01', 'one', { provider: 'codex' }), makeSession('s-02', 'two', { provider: 'codex' })],
      rooms: [{ ...makeRoom('r-1', 'Codex room'), members: ['s-01', 's-02'] }],
    }));
    const a = { projectPath: paths[0]!, workId: 'w-1', sessionId: 's-01' };
    const b = { ...a, sessionId: 's-02' };
    const c = { ...a, projectPath: paths[1]! };
    const d = { ...c, sessionId: 's-02' };
    const model = islandModel(entries, activityMap([
      makeActivity(a, 'working'), makeActivity(b, 'blocked'), makeActivity(c, 'unseen', { turnEndedAt: ENDED }), makeActivity(d, 'working'),
    ]), NONE, NONE, NONE);
    expect(model).toMatchObject({ working: 2, waiting: 1, done: 1, active: true, providers: ['codex'] });
    expect(model.groups).toHaveLength(2);
    const rows = model.groups.flatMap((group) => group.rows);
    expect(rows.filter((row) => row.kind === 'session')).toHaveLength(4);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.find((row) => row.kind === 'session' && row.key === refKey(b))).toMatchObject({ state: 'needs-you', inTerminal: true });
    expect(model.groups[0]?.rows.find((row) => row.kind === 'room')).toMatchObject({ busy: 2, done: false });
    expect(model.groups[1]?.rows.find((row) => row.kind === 'room')).toMatchObject({ busy: 1, done: false });
  });

  it('Clear Codex Done не задевает тот же sessionId другого worktree; новый конец хода возвращается', () => {
    const entries = ['/tmp/worktree-a', '/tmp/worktree-b'].map((projectPath) => makeWork('w-1', {
      projectPath, sessions: [makeSession('s-01', 'one', { provider: 'codex' })],
      rooms: [{ ...makeRoom('r-1', 'Codex room'), members: ['s-01'] }],
    }));
    const a = { projectPath: entries[0]!.projectPath, workId: 'w-1', sessionId: 's-01' };
    const b = { ...a, projectPath: entries[1]!.projectPath };
    const clearedKey = `${refKey(a)}\u0000${ENDED}`;
    const byRef = activityMap([makeActivity(a, 'unseen', { turnEndedAt: ENDED }), makeActivity(b, 'unseen', { turnEndedAt: ENDED })]);
    expect(islandModel(entries, byRef, NONE, NONE, NONE)).toMatchObject({ done: 2, working: 0, waiting: 0 });
    const cleared = new Set([clearedKey]);
    const remaining = islandModel(entries, byRef, NONE, cleared, NONE);
    expect(remaining.done).toBe(1);
    expect(remaining.groups.map((group) => group.rows.find((row) => row.kind === 'session')?.key)).toEqual([refKey(b)]);
    const next = islandModel(entries, activityMap([
      makeActivity(a, 'unseen', { turnEndedAt: '2026-10-13T11:00:00.000Z' }), makeActivity(b, 'unseen', { turnEndedAt: ENDED }),
    ]), NONE, cleared, NONE);
    expect(next.done).toBe(2);
    expect(next.groups.flatMap((group) => group.rows).filter((row) => row.kind === 'room')).toHaveLength(2);
  });

  it('группа, где есть только Done, видна', () => {
    const byRef = activityMap([makeActivity(ref('s-05'), 'unseen', { turnEndedAt: ENDED })]);
    const model = islandModel([work()], byRef, new Set(), NONE, NONE);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ title: 'Backend' });
  });

  it('порядок в группе: строки в работе и ожидания, потом Done — как бы ни стояли сессии в карте', () => {
    const entry = makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'finished'), makeSession('s-02', 'busy'), makeSession('s-03', 'waits')] });
    const byRef = activityMap([
      makeActivity(ref('s-01'), 'unseen', { turnEndedAt: ENDED }),
      makeActivity(ref('s-02'), 'working'),
      makeActivity(ref('s-03'), 'blocked'),
    ]);
    const rows = islandModel([entry], byRef, new Set(), NONE, NONE).groups[0]?.rows ?? [];
    expect(rows.map((row) => row.kind === 'session' && `${row.ref.sessionId}:${row.state}`)).toEqual(['s-02:working', 's-03:needs-you', 's-01:done']);
  });

  it('комната done: никто из участников не в работе, а кто-то в Done; Clear её убирает', () => {
    const byRef = activityMap([makeActivity(ref('s-02'), 'unseen', { turnEndedAt: ENDED })]);
    const room = islandModel([work()], byRef, new Set(), NONE, NONE).groups[0]?.rows.find((row) => row.kind === 'room');
    expect(room).toMatchObject({ kind: 'room', roomId: 'r-1', busy: 0, done: true });
    expect(islandModel([work()], byRef, new Set(), new Set([doneKey('s-02')]), NONE)).toMatchObject({ done: 0, groups: [] });
  });

  it('комната не done, пока кто-то из участников в работе: busy > 0', () => {
    const byRef = activityMap([makeActivity(ref('s-02'), 'unseen', { turnEndedAt: ENDED }), makeActivity(ref('s-03'), 'working')]);
    const room = islandModel([work()], byRef, new Set(), NONE, NONE).groups[0]?.rows.find((row) => row.kind === 'room');
    expect(room).toMatchObject({ busy: 1, done: false });
  });

  it('sessionLabels — подписи сессий для шапки карточки', () => {
    const labels = sessionLabels([work()]);
    expect(labels.get(refKey(ref('s-02')))).toEqual({ session: 'S02 api', work: 'Backend', project: 'Доки ВК' });
  });
});

describe('модель острова — рой работы (спека роя, 7.4)', () => {
  const members = [makeSwarmMember('s-q', 'queen'), makeSwarmMember('s-d1', 'drone', 1, true), makeSwarmMember('s-d2', 'drone', 2)];
  const hive = [makeSession('s-q', 'queen'), makeSession('s-d1', 'one'), makeSession('s-d2', 'two')];
  const live = (ids: string[]) => activityMap(ids.map((id) => makeActivity(ref(id), 'working')));
  const build = (swarms: ReturnType<typeof makeSwarm>[], sessions = hive) =>
    islandModel([makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'lead'), ...sessions], swarms })], live(['s-01', 's-q', 's-d1', 's-d2']), NONE, NONE, NONE);

  it('участники роя не стоят рядами и не считаются работающими; вместо них — один ряд роя со счётчиком', () => {
    const model = build([makeSwarm('sw-01', 's-q', { members })]);
    expect(model.working).toBe(1);
    expect(model.groups[0]?.rows.map((row) => row.kind)).toEqual(['session', 'work-swarm']);
    expect(model.groups[0]?.rows[1]).toMatchObject({ kind: 'work-swarm', swarmId: 'sw-01', queenId: 's-q', tag: 'Research', handed: 1, total: 2, state: 'running' });
    expect(model.swarm).toEqual({ count: 1, handed: 1, total: 2 });
    expect(model.active).toBe(true);
  });

  it('рой без работающих сессий всё равно делает остров активным', () => {
    const model = islandModel([makeWork('w-1', { projectPath: PROJECT, sessions: hive, swarms: [makeSwarm('sw-01', 's-q', { members })] })], {}, NONE, NONE, NONE);
    expect(model.working).toBe(0);
    expect(model.active).toBe(true);
    expect(model.groups[0]?.rows).toHaveLength(1);
  });

  it('готовый непросмотренный рой остаётся рядом, но в счётчик идущих не входит; просмотренный и отменённый уходят', () => {
    const done = makeSwarm('sw-01', 's-q', { members, status: 'done' });
    const model = build([done]);
    expect(model.groups[0]?.rows.find((row) => row.kind === 'work-swarm')).toMatchObject({ state: 'done' });
    expect(model.swarm).toBeUndefined();
    const gone = build([{ ...done, seenAt: '2026-10-28T10:00:00.000Z' }, makeSwarm('sw-02', 's-q', { status: 'cancelled' })]);
    expect(gone.groups[0]?.rows.some((row) => row.kind === 'work-swarm')).toBe(false);
  });

  it('карта без роёв — прежняя модель, без поля swarm', () => {
    expect(build([]).swarm).toBeUndefined();
  });
});
