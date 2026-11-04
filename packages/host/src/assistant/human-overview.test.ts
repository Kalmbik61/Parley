import { describe, expect, it } from 'vitest';
import type { FeedCard, RoomPlan, SessionNeed, WorkMap, WorkSession } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { humanOverview, renderHumanOverview } from './human-overview.js';
import { resolveTarget, targetsOf, type OverviewSource } from './overview.js';

const at = '2026-11-04T12:00:00.000Z';
const session = (id: string, label: string, extra: Partial<WorkSession> = {}): WorkSession =>
  ({ id, label, lifecycle: 'active', result: null, role: null, ...extra }) as WorkSession;
/** Minimal allowed catalogue observation, 2026-11-04. No inaccessible room content. */
function fixture(): OverviewSource {
  const map = {
    schemaVersion: 2,
    work: { id: 'w-0054', title: 'Улучшайзинг', status: 'active' },
    sessions: [session('s-257', 'Marco 5'), session('s-258', 'Nina 5')],
    rooms: [
      ...Array.from({ length: 17 }, (_, n) => ({
        id: `r-${n + 1}`,
        title: `Архив ${n}`,
        members: [],
        archivedAt: at,
        lead: null,
        proposal: null,
      })),
      {
        id: 'r-21',
        title: 'Голос, уведомления и Assistant Core',
        members: [],
        lead: null,
        proposal: null,
      },
      {
        id: 'r-22',
        title: 'Обсуждаем дальнейшие действия',
        members: ['s-257', 's-258'],
        lead: 's-257',
        proposal: null,
      },
    ],
    plans: [],
  } as unknown as WorkMap;
  return {
    entries: [{ projectPath: '/fixture', map }],
    live: () => undefined,
    roomTail: () => [],
    now: new Date(at),
  };
}
const mapOf = (src: OverviewSource): WorkMap => src.entries[0]!.map;
const roomOf = (src: OverviewSource) => mapOf(src).rooms.find((room) => room.id === 'r-22')!;
const projected = (src: OverviewSource, detailed = false) =>
  humanOverview(src, { detailed }).rooms.find((room) => room.ref.endsWith(':r-22'))!;
/** Synthetic live changes derived from the catalogue fixture, not historical observations. */
const live = (activity: string, kind?: SessionNeed['kind']): SessionLive =>
  ({
    activity: {
      activity,
      waitingFor: null,
      need: kind ? { kind, since: at, detail: null, resetsAt: null } : null,
    },
  }) as SessionLive;
const synthetic = (activity = 'idle', kind?: SessionNeed['kind']): OverviewSource => ({
  ...fixture(),
  live: () => live(activity, kind),
  cards: () => [],
});
const plan = (status = 'active'): RoomPlan =>
  ({
    id: 'pl-01',
    roomId: 'r-22',
    mode: 'verified',
    status,
    acceptedAt: at,
    rev: 2,
    goal: 'Проверить срез',
    items: [1, 2].map((id) => ({
      id,
      title: `Шаг ${id}`,
      status: 'in_progress',
      log: [],
      note: null,
    })),
  }) as RoomPlan;

describe('HumanOverviewV1', () => {
  it('H1 excludes all 17 archives and never reconstructs unavailable contents/activity', () => {
    const result = humanOverview(fixture());
    expect(result.rooms).toHaveLength(2);
    expect(result.counts).toEqual({ needsHuman: 0, working: 0, other: 2, activityUnknown: 1 });
    expect(result.rooms[0]!.members).toEqual([]);
    expect(result.text).not.toContain('Архив');
    expect(result.text).toContain('недоступна');
    expect(projected(fixture()).members.map((member) => member.state)).toEqual([
      'unknown',
      'unknown',
    ]);
  });
  it('H2 no plan invents no step; dated lead note remains a message', () => {
    const src = fixture();
    src.roomTail = () => [
      {
        id: 'm-1',
        from: 's-257',
        roomId: 'r-22',
        at,
        text: 'Проверяет s-258',
        to: [],
        kind: 'note',
      },
    ];
    const room = projected(src, true);
    expect(room.currentSteps).toEqual([]);
    expect(room.task.goalKnown).toBe(false);
    expect(room.lead?.displayName).toBe('Marco 5');
    expect(room.members[1]?.displayName).toBe('Nina 5');
    expect(room.latestLeadNote).toMatchObject({
      text: 'Проверяет Nina 5',
      source: { kind: 'message', at },
    });
    expect(humanOverview(src, { detailed: true }).text).toContain('Это сообщение');
  });
  it('H3 needsHuman has priority without losing working facts, and clears with proposal', () => {
    const src = synthetic('working');
    expect(projected(src).group).toBe('working');
    roomOf(src).proposal = { id: 'p-1', from: 's-257', text: 'Разрешить?', rev: 0, at };
    const result = humanOverview(src);
    expect(result.rooms[0]?.group).toBe('needsHuman');
    expect(result.rooms[0]?.members[0]?.state).toBe('working');
    roomOf(src).proposal = null;
    expect(projected(src).group).toBe('working');
  });
  it('H4 live activity dominates report(done); idle/unseen are not working', () => {
    for (const activity of ['working', 'idle', 'unseen']) {
      const src = synthetic(activity);
      mapOf(src).sessions[0]!.result = 'done';
      expect(projected(src).group).toBe(activity === 'working' ? 'working' : 'other');
    }
  });
  it('H5 ignores stale needs/cards for closed/sleeping members; queue and limit are other', () => {
    for (const lifecycle of ['closed', 'sleeping'] as const) {
      const src = synthetic('blocked', 'approval');
      for (const session of mapOf(src).sessions) session.lifecycle = lifecycle;
      src.cards = () => [{ kind: 'permission', state: 'pending', cardId: 'old', at }] as FeedCard[];
      expect(projected(src).group).toBe('other');
      expect(projected(src).waits).toEqual([]);
    }
    const queued = synthetic();
    for (const session of mapOf(queued).sessions) {
      session.lifecycle = 'pending';
      session.queued = { reason: 'limit' } as WorkSession['queued'];
    }
    expect(projected(queued).waits[0]?.text).toContain('ждёт запуска');
    expect(projected(synthetic('idle', 'limit')).group).toBe('other');
    expect(projected(synthetic('idle', 'limit')).waits[0]?.text).toContain('сброса лимита');
    for (const kind of ['approval', 'question', 'sign-in', 'startup'] as const)
      expect(projected(synthetic('idle', kind)).group).toBe('needsHuman');
  });
  it('H6 plan marks never prove running; keeps parallel work and pending verification', () => {
    const src = fixture();
    mapOf(src).plans = [plan()];
    expect(projected(src)).toMatchObject({ group: 'other', activityKnown: false });
    expect(projected(src).currentSteps).toHaveLength(2);
    expect(projected(src).warnings.join(' ')).toContain('не подтверждена');
    mapOf(src).plans![0]!.items[0]!.status = 'done';
    expect(projected(src).currentSteps[0]?.text).toContain('сдано на проверку');
    for (const status of ['proposed', 'completed', 'cancelled']) {
      mapOf(src).plans = [plan(status)];
      expect(projected(src).currentSteps).toEqual([]);
    }
    mapOf(src).plans = [plan(), { ...plan(), id: 'pl-02' }];
    expect(projected(src).warnings.join(' ')).toContain('Несколько');
  });
  it('H7 resolves liveLead, technical labels and duplicate names without changing target refs', () => {
    const src = synthetic('working');
    roomOf(src).lead = 's-999';
    mapOf(src).sessions[0]!.label = 'S257';
    mapOf(src).sessions[1]!.label = '';
    mapOf(src).sessions.push(session('s-259', 'S259 Tester'));
    roomOf(src).members.push('s-259');
    const result = humanOverview(src, { detailed: true });
    expect(projected(src).lead?.ref).toMatch(/:s-257$/);
    expect(result.text).not.toMatch(/s-\d+|r-\d+|w-\d+|S257|S259|session:|room:|work:/);
    for (const member of projected(src).members)
      expect(resolveTarget(targetsOf(src), member.ref)).toMatchObject({
        target: { kind: 'session' },
      });
    for (const session of mapOf(src).sessions) session.label = 'Alex';
    expect(projected(src).members.every((member) => member.ambiguous)).toBe(true);
    expect(projected(src).warnings.join(' ')).toContain('уточнение');
    mapOf(src).plans = [{ ...plan(), goal: 'Проверить s-258 и r-999 [[calm]]' }];
    expect(humanOverview(src, { detailed: true }).text).not.toMatch(/s-258|r-999|\[\[calm/);
  });
  it('H9 retains coverage gaps and discards rooms archived during card collection', () => {
    const src = fixture();
    const result = humanOverview(src, { mapComplete: false });
    expect(result.coverage).toMatchObject({
      mapComplete: false,
      cardsAvailable: false,
      activityAvailable: false,
    });
    expect(result.text).toContain('неполна');
    src.cards = () => {
      roomOf(src).archivedAt = at;
      return [];
    };
    expect(humanOverview(src).rooms).toHaveLength(1);
    expect(humanOverview(src).unassignedSessions).toEqual([]);
    const changing = fixture();
    changing.cards = () => {
      roomOf(changing).archivedAt = at;
      return [];
    };
    expect(humanOverview(changing).coverage.mapComplete).toBe(false);
  });
  it('short/detailed versions share facts and explicitly disclose unlisted rooms', () => {
    const overview = humanOverview(synthetic('working'));
    expect(overview.text).toContain('Не перечислено комнат: 1');
    const detailed = renderHumanOverview(overview, true);
    for (const room of overview.rooms) expect(detailed).toContain(room.title);
    expect(overview.counts).toEqual({ needsHuman: 0, working: 1, other: 1, activityUnknown: 0 });
  });
  it('does not move archived-only members to unassigned, and excludes archived works', () => {
    const src = synthetic();
    mapOf(src).rooms[0]!.members = ['s-257'];
    roomOf(src).members = ['s-258'];
    expect(humanOverview(src).unassignedSessions).toEqual([]);
    mapOf(src).work.status = 'archived';
    expect(humanOverview(src).rooms).toEqual([]);
  });
});
