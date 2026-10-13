/** Модель острова: счётчики пилюли, группы «в работе» по работам, комнаты по участникам, Codex вне острова, подписи сессий. */

import { describe, expect, it } from 'vitest';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { islandModel, sessionLabels } from './model.js';

const PROJECT = '/Users/me/Desktop/Доки ВК';
const ref = (sessionId: string, workId = 'w-1') => ({ projectPath: PROJECT, workId, sessionId });

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
  it('работает и ждёт — в пилюле; Codex, простаивающие и «finished» — нет', () => {
    const byRef = activityMap([
      makeActivity(ref('s-01'), 'working'),
      makeActivity(ref('s-02'), 'blocked'),
      makeActivity(ref('s-03'), 'working'),
      makeActivity(ref('s-04'), 'blocked'),
      makeActivity(ref('s-05'), 'unseen'),
    ]);
    const model = islandModel([work()], byRef, new Set([refKey(ref('s-02'))]));
    expect(model).toMatchObject({ working: 2, waiting: 1, providers: ['claude', 'glm'], active: true });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ title: 'Backend', project: 'Доки ВК' });
    const sessions = model.groups[0]?.rows.filter((row) => row.kind === 'session') ?? [];
    expect(sessions.map((row) => row.kind === 'session' && row.ref.sessionId)).toEqual(['s-01', 's-02', 's-03']);
  });

  it('комната в работе, если в работе хоть один её участник', () => {
    const byRef = activityMap([makeActivity(ref('s-03'), 'working')]);
    const rows = islandModel([work()], byRef, new Set()).groups[0]?.rows ?? [];
    expect(rows.find((row) => row.kind === 'room')).toMatchObject({ kind: 'room', roomId: 'r-1', title: 'Refunds', busy: 1 });
  });

  it('ждёт без карточки острова — «в терминале»', () => {
    const byRef = activityMap([makeActivity(ref('s-02'), 'blocked')]);
    const row = islandModel([work()], byRef, new Set()).groups[0]?.rows[0];
    expect(row).toMatchObject({ kind: 'session', state: 'needs-you', inTerminal: true });
  });

  it('никто не работает и не ждёт — остров неактивен, групп нет', () => {
    expect(islandModel([work()], {}, new Set())).toEqual({ working: 0, waiting: 0, providers: [], groups: [], active: false });
  });

  it('работы не active (done, archived) не считаются', () => {
    const done = makeWork('w-2', { projectPath: PROJECT, status: 'done', sessions: [makeSession('s-01', 'x')] });
    const byRef = activityMap([makeActivity(ref('s-01', 'w-2'), 'working')]);
    expect(islandModel([done], byRef, new Set()).active).toBe(false);
  });

  it('sessionLabels — подписи сессий для шапки карточки', () => {
    const labels = sessionLabels([work()]);
    expect(labels.get(refKey(ref('s-02')))).toEqual({ session: 'S02 api', work: 'Backend', project: 'Доки ВК' });
  });
});
