/**
 * Модель острова: счётчики пилюли, группы «в работе» по работам, комнаты по участникам, Codex только при запросе действия, подписи
 * сессий; Done (ход окончен, не смотрели): строка с ключом конца хода, Clear, порядок после работы, комната `done`;
 * удержанные ключи: посмотренная (`idle`) сессия с концом хода и ключом в `held` остаётся строкой Done; `seen` у строки
 * Done: ложно для `unseen`, истинно для удержанной `idle`.
 */

import { describe, expect, it } from 'vitest';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
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
  it('работает и ждёт — в пилюле; Codex только при запросе действия; «finished» — Done, а не работа', () => {
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

  it('Codex в Done не попадает', () => {
    const byRef = activityMap([makeActivity(ref('s-04'), 'unseen', { turnEndedAt: ENDED })]);
    expect(islandModel([work()], byRef, new Set(), NONE, NONE)).toMatchObject({ done: 0, groups: [] });
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
