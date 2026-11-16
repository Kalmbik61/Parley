import { describe, expect, it } from 'vitest';
import { makeSession, makeSwarm, makeSwarmMember } from '../test-utils/work-fixtures.js';
import { nominalSwarm, formatSwarmTimer, isSwarmShown, memberAria, memberName, memberTitle, memberWord, swarmBadge, swarmBadgeView, swarmCounter, swarmDots, swarmElapsedMs, swarmMemberViews } from './swarm-view.js';

const T0 = Date.parse('2026-09-27T08:00:00.000Z');

describe('таймер роя', () => {
  it('идущий считает до now, законченный — до endedAt', () => {
    const running = makeSwarm('sw-01', 's-01');
    expect(swarmElapsedMs(running, T0 + 252_000)).toBe(252_000);
    const done = makeSwarm('sw-02', 's-01', { status: 'done', endedAt: '2026-09-27T08:04:12.000Z' });
    expect(swarmElapsedMs(done, T0 + 9_999_000)).toBe(252_000);
  });

  it('битая дата создания — ноль, будущее — не отрицательное', () => {
    expect(swarmElapsedMs(makeSwarm('sw-01', 's-01', { createdAt: 'x' }), T0)).toBe(0);
    expect(swarmElapsedMs(makeSwarm('sw-01', 's-01'), T0 - 5_000)).toBe(0);
  });

  it('м:сс, от часа — ч:мм:сс', () => {
    expect(formatSwarmTimer(0)).toBe('0:00');
    expect(formatSwarmTimer(252_000)).toBe('4:12');
    expect(formatSwarmTimer(3_909_000)).toBe('1:05:09');
    expect(formatSwarmTimer(-5)).toBe('0:00');
  });
});

describe('видимость роя в карточке', () => {
  it('идущий виден всегда; законченный done/failed — пока не просмотрен; остальные — при раскрытых закрытых', () => {
    expect(isSwarmShown(makeSwarm('sw-01', 's-01'), false)).toBe(true);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'done' }), false)).toBe(true);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'failed' }), false)).toBe(true);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'done', seenAt: '2026-09-27T09:00:00.000Z' }), false)).toBe(false);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'cancelled' }), false)).toBe(false);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'cancelled' }), true)).toBe(true);
    expect(isSwarmShown(makeSwarm('sw-01', 's-01', { status: 'done', seenAt: '2026-09-27T09:00:00.000Z' }), true)).toBe(true);
  });
});

describe('участники роя', () => {
  const swarm = makeSwarm('sw-01', 's-01', {
    members: [
      makeSwarmMember('s-05', 'verifier'),
      makeSwarmMember('s-03', 'drone', 2),
      makeSwarmMember('s-01', 'queen'),
      makeSwarmMember('s-02', 'drone', 1, true),
    ],
  });
  const sessions = [makeSession('s-01', 'queen'), makeSession('s-02', 'd1'), makeSession('s-03', 'd2'), makeSession('s-05', 'v', { lifecycle: 'pending' })];

  it('порядок: королева, трутни по номеру, проверяющие; состояние — по memberState', () => {
    const views = swarmMemberViews(swarm, sessions);
    expect(views.map((view) => view.member.sessionId)).toEqual(['s-01', 's-02', 's-03', 's-05']);
    expect(views.map((view) => view.state)).toEqual(['working', 'handed', 'working', 'waiting']);
  });

  it('удалённая сессия участника: запись остаётся, сессии нет — failed, а сдавший остаётся сдавшим', () => {
    const views = swarmMemberViews(swarm, sessions.filter((session) => session.id !== 's-03' && session.id !== 's-02'));
    expect(views.find((view) => view.member.sessionId === 's-03')).toMatchObject({ session: null, state: 'failed' });
    expect(views.find((view) => view.member.sessionId === 's-02')).toMatchObject({ session: null, state: 'handed' });
  });

  it('точки — по одной на трутня и проверяющего, королевы среди них нет', () => {
    expect(swarmDots(swarmMemberViews(swarm, sessions))).toEqual(['handed', 'open', 'open']);
  });

  it('счётчик 3/5; до первого трутня — многоточие', () => {
    expect(swarmCounter(swarm)).toBe('1/3');
    expect(swarmCounter(makeSwarm('sw-02', 's-01'))).toBe('…');
  });

  it('названия: Queen, Drone N, Verifier', () => {
    expect(memberTitle({ role: 'queen', n: 1 })).toBe('Queen');
    expect(memberTitle({ role: 'drone', n: 2 })).toBe('Drone 2');
    expect(memberTitle({ role: 'verifier', n: 1 })).toBe('Verifier');
  });
});

describe('слова состояния', () => {
  const sessions = [makeSession('s-01', 'queen'), makeSession('s-02', 'd1')];
  const word = (swarm: ReturnType<typeof makeSwarm>, id: string): string => memberWord(swarm, swarmMemberViews(swarm, sessions).find((view) => view.member.sessionId === id)!);

  it('королева: режет задачу без трутней, ждёт сдачи с трутнями, сводит в collecting, сдала в done', () => {
    const alone = makeSwarm('sw-01', 's-01');
    expect(word(alone, 's-01')).toBe('cutting the task…');
    const withDrone = makeSwarm('sw-01', 's-01', { members: [makeSwarmMember('s-01', 'queen'), makeSwarmMember('s-02', 'drone')] });
    expect(word(withDrone, 's-01')).toBe('waiting for hand-ins…');
    expect(word({ ...withDrone, status: 'collecting' }, 's-01')).toBe('collecting…');
    expect(word({ ...withDrone, status: 'done' }, 's-01')).toBe('handed in ✓');
    expect(word({ ...withDrone, status: 'failed' }, 's-01')).toBe('failed');
  });

  it('трутень и проверяющий: читает, проверяет, сдал, закрыт', () => {
    const swarm = makeSwarm('sw-01', 's-01', { members: [makeSwarmMember('s-01', 'queen'), makeSwarmMember('s-02', 'drone'), makeSwarmMember('s-03', 'verifier')] });
    expect(word(swarm, 's-02')).toBe('reading…');
    expect(memberWord(swarm, { member: swarm.members[2]!, session: makeSession('s-03', 'v'), state: 'working' })).toBe('verifying…');
    expect(word({ ...swarm, status: 'cancelled' }, 's-02')).toBe('closed');
    const handed = { ...swarm, members: [swarm.members[0]!, makeSwarmMember('s-02', 'drone', 1, true)] };
    expect(word(handed, 's-02')).toBe('handed in ✓');
  });
});

describe('значок карточки и группы', () => {
  it('считает идущие рои и готовые непросмотренные итоги', () => {
    const swarms = [
      makeSwarm('sw-01', 's-01'),
      makeSwarm('sw-02', 's-01', { status: 'collecting' }),
      makeSwarm('sw-03', 's-01', { status: 'done' }),
      makeSwarm('sw-04', 's-01', { status: 'done', seenAt: '2026-09-27T09:00:00.000Z' }),
      makeSwarm('sw-05', 's-01', { status: 'cancelled' }),
    ];
    expect(swarmBadge({ swarms })).toEqual({ active: 2, ready: 1 });
    expect(swarmBadge({})).toEqual({ active: 0, ready: 0 });
  });

  it('идущие — число; нет идущих, но есть итог — галочка; пусто — нет значка', () => {
    expect(swarmBadgeView({ active: 2, ready: 1 })).toMatchObject({ status: 'running', count: 2, title: '2 swarms running' });
    expect(swarmBadgeView({ active: 1, ready: 0 })?.title).toBe('1 swarm running');
    expect(swarmBadgeView({ active: 0, ready: 1 })).toMatchObject({ status: 'done', count: null });
    expect(swarmBadgeView({ active: 0, ready: 0 })).toBeNull();
  });
});

describe('nominalSwarm — условный рой для значков карточки и группы (спека роя, 7.5)', () => {
  it('идущий и сводящий — 1 из 3, готовый — 3 из 3', () => {
    expect(nominalSwarm('running')).toEqual({ handed: 1, total: 3 });
    expect(nominalSwarm('collecting')).toEqual({ handed: 1, total: 3 });
    expect(nominalSwarm('done')).toEqual({ handed: 3, total: 3 });
  });

  it('сбой и отмена — три полные серые ячейки', () => {
    for (const status of ['failed', 'cancelled'] as const) expect(nominalSwarm(status)).toEqual({ handed: 3, total: 3 });
  });
});

describe('частичная сдача и срез (спека «видимые дыры», 3.8)', () => {
  const sessions = [makeSession('s-01', 'queen'), makeSession('s-02', 'covered'), makeSession('s-03', 'partial'), makeSession('s-04', 'old'), makeSession('s-05', 'failed', { result: 'failed' }), makeSession('s-06', 'busy')];
  const swarm = makeSwarm('sw-01', 's-01', {
    members: [
      makeSwarmMember('s-01', 'queen'),
      makeSwarmMember('s-02', 'drone', 1, true, { slice: 'core', coverage: 'covered' }),
      makeSwarmMember('s-03', 'drone', 2, true, { slice: 'host/sessions', coverage: 'partial' }),
      makeSwarmMember('s-04', 'drone', 3, true),
      makeSwarmMember('s-05', 'verifier', 1, false, { slice: 'claims' }),
      makeSwarmMember('s-06', 'drone', 4),
    ],
  });
  const viewOf = (sw: typeof swarm, id: string, list = sessions) => swarmMemberViews(sw, list).find((view) => view.member.sessionId === id)!;

  it('слово: partial у сдавшего с покрытием partial; covered и сдача без поля — handed in ✓', () => {
    expect(memberWord(swarm, viewOf(swarm, 's-03'))).toBe('partial');
    expect(memberWord(swarm, viewOf(swarm, 's-02'))).toBe('handed in ✓');
    expect(memberWord(swarm, viewOf(swarm, 's-04'))).toBe('handed in ✓');
    expect(memberWord(swarm, viewOf(swarm, 's-05'))).toBe('failed');
  });

  it('частичная сдача остаётся partial после закрытия участника, удаления сессии и отмены роя', () => {
    const closed = sessions.map((session) => (session.id === 's-03' ? { ...session, lifecycle: 'closed' as const } : session));
    expect(memberWord(swarm, viewOf(swarm, 's-03', closed))).toBe('partial');
    expect(memberWord(swarm, viewOf(swarm, 's-03', sessions.filter((session) => session.id !== 's-03')))).toBe('partial');
    const cancelled = { ...swarm, status: 'cancelled' as const };
    expect(memberWord(cancelled, viewOf(cancelled, 's-03'))).toBe('partial');
    expect(memberWord(cancelled, viewOf(cancelled, 's-06'))).toBe('closed');
    expect(swarmDots(swarmMemberViews(cancelled, sessions))[1]).toBe('partial');
  });

  it('точки (трутни по номеру, затем проверяющий): handed, partial, handed (без поля), open, failed — partial отличается от handed и open', () => {
    expect(swarmDots(swarmMemberViews(swarm, sessions))).toEqual(['handed', 'partial', 'handed', 'open', 'failed']);
  });

  it('счётчик не меняется: частичная сдача — сдача', () => {
    expect(swarmCounter(swarm)).toBe('3/5');
  });

  it('название участника: со срезом «Drone 2 · host/sessions», без среза — как прежде; aria-label по 3.8', () => {
    expect(memberName(swarm.members[2]!)).toBe('Drone 2 · host/sessions');
    expect(memberName(swarm.members[3]!)).toBe('Drone 3');
    expect(memberName(swarm.members[0]!)).toBe('Queen');
    expect(memberAria(swarm, viewOf(swarm, 's-03'))).toBe('Drone 2, host/sessions: partial');
    expect(memberAria(swarm, viewOf(swarm, 's-06'))).toBe('Drone 4: reading…');
    expect(memberAria(swarm, viewOf(swarm, 's-05'))).toBe('Verifier, claims: failed');
  });
});
