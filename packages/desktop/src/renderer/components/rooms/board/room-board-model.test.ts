import { describe, expect, it } from 'vitest';
import type { PlanAttempt, PlanItem, PlanMode, Room, RoomPlan, WindowWorkEntry, WorkSession } from '@parley/core';
import { autonomousPlan } from '../../../test-utils/autonomous-plan.js';
import { activityMap, makeActivity, makeNeed, makeRoom, makeSession, makeWork } from '../../../test-utils/work-fixtures.js';
import { sessionWord } from '../../../lib/session-word.js';
import type { ParticipantModel } from '../feed-model.js';
import { boardItemAgent, buildRoomBoard, roomBoardAvailable, type BoardCardModel, type RoomBoardInput } from './room-board-model.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ref = (sessionId: string) => ({ projectPath: '/tmp/proj', workId: 'w-01', sessionId });

const item = (id: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `Item ${id}`, owner: 's-01', scope: 'src', after: [], criteria: [], verifier: 's-02', status: 'waiting', evidence: null, note: null, log: [], ...patch,
});
const planOf = (mode: PlanMode, items: PlanItem[], patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01', roomId: 'r-01', rev: 2, mode, status: 'active', goal: 'Goal', items, backlog: [],
  acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null, ...patch,
});
const attempt = (patch: Partial<PlanAttempt>): PlanAttempt => ({ ...autonomousPlan().attempts[0]!, ...patch });
const autoPlan = (items: PlanItem[], attempts: PlanAttempt[], halted: RoomPlan['autonomous'] extends infer A ? (A extends { halted: infer H } ? H : never) : never = null): RoomPlan =>
  planOf('autonomous', items, { autonomous: { ...autonomousPlan(), attempts, ops: [], halted } });

interface Setup { sessions?: WorkSession[]; room?: Partial<Room>; activity?: ReturnType<typeof makeActivity>[]; participants?: ParticipantModel[] }
function input(plan: RoomPlan, setup: Setup = {}): RoomBoardInput {
  const sessions = setup.sessions ?? [makeSession('s-01', 'back'), makeSession('s-02', 'front'), makeSession('s-03', 'lead')];
  const room: Room = { ...makeRoom('r-01', 'Delivery'), members: ['s-01', 's-02', 's-03'], lead: 's-03', ...setup.room };
  const entry: WindowWorkEntry = makeWork('w-01', { sessions, rooms: [room] });
  entry.map.plans = [plan];
  return { plan, room, entry, participants: setup.participants ?? [], activity: activityMap(setup.activity ?? []), now: NOW };
}
const cards = (model: ReturnType<typeof buildRoomBoard>): BoardCardModel[] => model.columns.flatMap((column) => column.cards);
const columnOf = (plan: RoomPlan, id: number, setup?: Setup) => cards(buildRoomBoard(input(plan, setup))).find((card) => card.itemId === id)!.column;

it('доска доступна у active, completing, completed и недоступна у proposed, cancelled и без плана', () => {
  for (const status of ['active', 'completing', 'completed'] as const) expect(roomBoardAvailable(planOf('verified', [], { status }))).toBe(true);
  for (const status of ['proposed', 'cancelled'] as const) expect(roomBoardAvailable(planOf('verified', [], { status }))).toBe(false);
  expect(roomBoardAvailable(null)).toBe(false);
});

describe('колонки', () => {
  it('Checklist — три колонки, done стоит в Done', () => {
    const model = buildRoomBoard(input(planOf('checklist', [item(1, { status: 'done' }), item(2, { status: 'in_progress' }), item(3)])));
    expect(model.columns.map((column) => column.id)).toEqual(['waiting', 'progress', 'done']);
    expect(model.columns.map((column) => column.cards.map((card) => card.itemId))).toEqual([[3], [2], [1]]);
  });

  it('Verified: waiting и ready — Waiting; in_progress, returned, blocked — In progress; done — In review; verified — последняя', () => {
    const plan = planOf('verified', [item(1), item(2, { status: 'ready' }), item(3, { status: 'in_progress' }), item(4, { status: 'returned' }), item(5, { status: 'blocked' }), item(6, { status: 'done' }), item(7, { status: 'verified' })]);
    const model = buildRoomBoard(input(plan));
    expect(model.columns.map((column) => column.id)).toEqual(['waiting', 'progress', 'review', 'done']);
    expect(model.columns.map((column) => column.cards.map((card) => card.itemId))).toEqual([[1, 2], [3, 4, 5], [6], [7]]);
  });

  it('done с основанием из Checklist стоит в последней колонке и несёт basis', () => {
    const plan = planOf('verified', [item(1, { status: 'done', acceptedChecklistRevision: 1 }), item(2, { status: 'done', acceptedChecklistRevision: 2 })]);
    expect(columnOf(plan, 1)).toBe('done');
    expect(columnOf(plan, 2)).toBe('review');
    const card = cards(buildRoomBoard(input(plan))).find((row) => row.itemId === 1)!;
    expect(card.basis).toBe(1);
  });

  it('зависимость, принятая по основанию из Checklist, считается закрытой', () => {
    const plan = planOf('verified', [item(1, { status: 'done', acceptedChecklistRevision: 1 }), item(2, { after: [1] })]);
    const card = cards(buildRoomBoard(input(plan))).find((row) => row.itemId === 2)!;
    expect(card.ready).toBe(true);
    expect(card.waitsFor).toEqual([]);
  });

  it('Waiting: незакрытые зависимости и ready', () => {
    const plan = planOf('verified', [item(1, { status: 'in_progress' }), item(2, { status: 'verified' }), item(3, { after: [1, 2] })]);
    const card = cards(buildRoomBoard(input(plan))).find((row) => row.itemId === 3)!;
    expect(card.waitsFor).toEqual([1]);
    expect(card.ready).toBe(false);
  });

  it('Autonomous: running — In progress; submitted, checking, accepted, queued — In review; verified — Verified', () => {
    const run = (status: PlanAttempt['status'], itemStatus: PlanItem['status'] = 'in_progress') => columnOf(autoPlan([item(1, { status: itemStatus })], [attempt({ item: 1, status })]), 1);
    expect(run('running')).toBe('progress');
    for (const status of ['submitted', 'checking', 'accepted', 'queued'] as const) expect(run(status)).toBe('review');
    expect(run('integrated')).toBe('progress');
    expect(run('integrated', 'verified')).toBe('done');
    expect(columnOf(autoPlan([item(1, { status: 'in_progress' })], []), 1)).toBe('progress');
  });

  it('Autonomous: returned и blocked стоят в In progress при попытке submitted', () => {
    for (const status of ['returned', 'blocked'] as const)
      expect(columnOf(autoPlan([item(1, { status })], [attempt({ item: 1, status: 'submitted' })]), 1)).toBe('progress');
  });

  it('Autonomous: attempt n of m есть и у проверенного пункта', () => {
    const plan = autoPlan([item(1, { status: 'verified' })], [attempt({ item: 1, n: 2, status: 'integrated' })]);
    expect(cards(buildRoomBoard(input(plan)))[0]!.attempt).toEqual({ n: 2, of: 3 });
  });

  it('сочетание вне таблиц попадает в In progress, карточка не теряется', () => {
    const odd = planOf('checklist', [item(1, { status: 'verified' })]);
    expect(columnOf(odd, 1)).toBe('progress');
    const oddAuto = autoPlan([item(1, { status: 'done' })], []);
    expect(columnOf(oddAuto, 1)).toBe('progress');
    expect(cards(buildRoomBoard(input(oddAuto)))).toHaveLength(1);
  });
});

describe('агент', () => {
  it('участник комнаты, бывший участник, сессии нет в карте, автономный пункт без исполнителя', () => {
    const plan = planOf('verified', [item(1), item(2, { owner: 's-09' }), item(3, { owner: 's-04' })]);
    const setup = { sessions: [makeSession('s-01', 'back'), makeSession('s-02', 'front'), makeSession('s-04', 'ex', { provider: 'codex' })] };
    const model = buildRoomBoard(input(plan, setup));
    const by = (id: number) => cards(model).find((card) => card.itemId === id)!.agent!;
    expect(by(1)).toMatchObject({ id: 's-01', provider: 'claude', label: 'S01 back' });
    expect(by(3)).toMatchObject({ id: 's-04', provider: 'codex', label: 'S04 ex' });
    expect(by(2)).toEqual({ id: 's-09', label: 's-09', provider: null, word: '' });
    const auto = autoPlan([item(1, { status: 'in_progress' }), item(2, { status: 'in_progress' })], [attempt({ item: 2, worker: 's-02' })]);
    const autoModel = buildRoomBoard(input(auto));
    expect(cards(autoModel).find((card) => card.itemId === 1)!.agent).toBeNull();
    expect(cards(autoModel).find((card) => card.itemId === 2)!.agent?.id).toBe('s-02');
    expect(boardItemAgent(input(auto), auto.items[0]!)).toBeNull();
  });

  it('слово агента — sessionWord: закрытая сессия с результатом done и failed, сессия в очереди, уснувшая сессия', () => {
    const variants: Partial<WorkSession>[] = [
      { lifecycle: 'closed', result: 'done' },
      { lifecycle: 'closed', result: 'failed' },
      { lifecycle: 'pending', queued: { reason: 'limit', active: 18, limit: 18, since: '2026-11-17T11:00:00.000Z' } as WorkSession['queued'] },
      { lifecycle: 'sleeping' },
    ];
    for (const patch of variants) {
      const session = makeSession('s-01', 'back', patch);
      const board = buildRoomBoard(input(planOf('verified', [item(1, { status: 'in_progress' })]), { sessions: [session, makeSession('s-02', 'front')] }));
      const word = cards(board)[0]!.agent!.word;
      expect(word).toBe(sessionWord(session, null, NOW));
      expect(word).not.toBe('');
    }
  });

  it('слово берётся из живой активности', () => {
    const session = makeSession('s-01', 'back');
    const live = makeActivity(ref('s-01'), 'working');
    const board = buildRoomBoard(input(planOf('verified', [item(1, { status: 'in_progress' })]), { sessions: [session], activity: [live] }));
    expect(cards(board)[0]!.agent!.word).toBe(sessionWord(session, live.activity, NOW));
  });
});

describe('карточка', () => {
  const line = (text: string): ParticipantModel => ({ id: 's-01', planLine: { kind: 'current', text } }) as unknown as ParticipantModel;
  const progress = (next: string, blocker: string | null = null) => ({ owner: { by: 's-01', at: '2026-11-17T10:00:00.000Z', submission: null, done: 'd', next, artifacts: [], blocker } });

  it('чем занят: next отметки; строка личного плана у единственной карточки; при двух карточках строки нет', () => {
    const one = planOf('verified', [item(1, { status: 'in_progress' })]);
    expect(cards(buildRoomBoard(input(one, { participants: [line('Writing tests')] })))[0]!.doing).toBe('Writing tests');
    expect(cards(buildRoomBoard(input(one)))[0]!.doing).toBeNull();
    const two = planOf('verified', [item(1, { status: 'in_progress' }), item(2, { status: 'in_progress', progress: progress('Resume here') })]);
    const model = buildRoomBoard(input(two, { participants: [line('Writing tests')] }));
    expect(cards(model).find((card) => card.itemId === 1)!.doing).toBeNull();
    expect(cards(model).find((card) => card.itemId === 2)!.doing).toBe('Resume here');
    const next = { id: 's-01', planLine: { kind: 'next', text: 'Later' } } as unknown as ParticipantModel;
    expect(cards(buildRoomBoard(input(one, { participants: [next] })))[0]!.doing).toBeNull();
  });

  it('что мешает: блокировка, ожидание человека, мягкое препятствие — по порядку', () => {
    const need = makeActivity(ref('s-01'), 'blocked', { need: makeNeed('approval') });
    const soft = progress('n', 'waiting for API');
    const blocked = planOf('verified', [item(1, { status: 'blocked', note: 'No access', progress: soft })]);
    expect(cards(buildRoomBoard(input(blocked, { activity: [need] })))[0]!.obstacle).toEqual({ kind: 'blocked', note: 'No access' });
    const waiting = planOf('verified', [item(1, { status: 'in_progress', progress: soft })]);
    expect(cards(buildRoomBoard(input(waiting, { activity: [need] })))[0]!.obstacle).toMatchObject({ kind: 'need' });
    expect(cards(buildRoomBoard(input(waiting)))[0]!.obstacle).toEqual({ kind: 'soft', text: 'waiting for API' });
    expect(cards(buildRoomBoard(input(planOf('verified', [item(1, { status: 'in_progress' })]))))[0]!.obstacle).toBeNull();
  });

  it('нужен человек: заблокированный пункт, чья сессия ждёт человека, стоит первым; Waiting и последняя колонка — тоже', () => {
    const need = makeActivity(ref('s-02'), 'blocked', { need: makeNeed('approval') });
    const plan = planOf('verified', [
      item(1, { status: 'in_progress' }), item(2, { status: 'blocked', owner: 's-02' }),
      item(3), item(4, { owner: 's-02' }),
      item(5, { status: 'verified' }), item(6, { status: 'verified', owner: 's-02' }),
    ]);
    const model = buildRoomBoard(input(plan, { activity: [need] }));
    const ids = model.columns.map((column) => column.cards.map((card) => card.itemId));
    expect(ids).toEqual([[4, 3], [2, 1], [], [6, 5]]);
    expect(cards(model).filter((card) => card.needsHuman).map((card) => card.itemId).sort()).toEqual([2, 4, 6]);
  });

  it('возврат: returnNote важнее note сдачи, она важнее note пункта', () => {
    const submission = (patch: object) => ({ n: 1, by: 's-01', at: 'x', evidence: { text: '', artifacts: [] }, verdict: 'returned', verdictBy: 's-02', verdictAt: 'x', note: 'verifier note', ...patch }) as PlanItem['submissions'] extends (infer S)[] | undefined ? S : never;
    const run = (patch: Partial<PlanItem>) => cards(buildRoomBoard(input(planOf('verified', [item(1, { status: 'returned', note: 'item note', ...patch })]))))[0]!.returned;
    expect(run({ submissions: [submission({ returnNote: 'human note' })] })).toBe('human note');
    expect(run({ submissions: [submission({})] })).toBe('verifier note');
    expect(run({})).toBe('item note');
    expect(run({ note: null })).toBe('');
    expect(cards(buildRoomBoard(input(planOf('verified', [item(1)]))))[0]!.returned).toBeNull();
  });

  it('проверка Verified: сессия, человек, недоступный проверяющий, без ведущего, ведущий — исполнитель', () => {
    const review = (patch: Partial<PlanItem>, setup?: Setup) => cards(buildRoomBoard(input(planOf('verified', [item(1, { status: 'done', ...patch })]), setup)))[0]!;
    const byReviewer = review({});
    expect(byReviewer.review).toMatchObject({ kind: 'waiting', reviewer: { id: 's-02', provider: 'claude' } });
    expect(byReviewer.involved).toEqual(['s-01', 's-02']);
    expect(byReviewer.needsHuman).toBe(false);
    const human = review({ verifier: 'human' });
    expect(human.review).toEqual({ kind: 'human' });
    expect(human.needsHuman).toBe(true);
    expect(review({ verifier: 's-09' }).review).toMatchObject({ kind: 'waiting', reviewer: { id: 's-03' } });
    expect(review({ verifier: 's-09' }, { room: { members: [], lead: null } }).review).toEqual({ kind: 'none' });
    expect(review({ verifier: 's-09', owner: 's-03' }).review).toEqual({ kind: 'none' });
    expect(review({ verifier: null }).review).toEqual({ kind: 'none' });
  });

  it('проверка Autonomous: состояние попытки, текст проверки, failed при fail и error', () => {
    const base = autonomousPlan();
    const run = (verdict: 'fail' | 'error' | 'pass') => {
      const check = { ...base.ops[0]!.result!.checkResult as object, verdict } as never;
      const plan = autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status: 'checking' })]);
      plan.autonomous!.ops = [{ ...base.ops[0]!, result: { checkResult: check } }];
      return cards(buildRoomBoard(input(plan)))[0]!.review;
    };
    expect(run('fail')).toEqual({ kind: 'attempt', status: 'checking', check: 'verifier:0 → fail · Restart still fails', failed: true });
    expect(run('error')).toMatchObject({ failed: true });
    expect(run('pass')).toMatchObject({ failed: false });
    const none = autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status: 'queued', checks: [] })]);
    expect(cards(buildRoomBoard(input(none)))[0]!.review).toEqual({ kind: 'attempt', status: 'queued', check: '', failed: false });
  });

  it('сдача: номер показан со второй; обновлено: позднейшее время из журнала пункта и журнала попытки', () => {
    const log = (n: number) => Array.from({ length: n }, (_, index) => ({ at: `2026-11-17T0${index + 1}:00:00.000Z`, by: 's-01', status: 'done' as const, note: null }));
    expect(cards(buildRoomBoard(input(planOf('verified', [item(1, { status: 'done', log: log(1) })]))))[0]!.submission).toBeNull();
    const second = cards(buildRoomBoard(input(planOf('verified', [item(1, { status: 'done', log: log(2) })]))))[0]!;
    expect(second.submission).toBe(2);
    expect(second.updatedAt).toBe('2026-11-17T02:00:00.000Z');
    expect(cards(buildRoomBoard(input(planOf('verified', [item(1)]))))[0]!.updatedAt).toBeNull();
    const auto = autoPlan([item(1, { status: 'in_progress', log: log(1) })], [attempt({ item: 1, status: 'running', log: [{ at: '2026-11-17T09:00:00.000Z', by: 'engine', status: 'running', note: null, op: null }] })]);
    expect(cards(buildRoomBoard(input(auto)))[0]!.updatedAt).toBe('2026-11-17T09:00:00.000Z');
  });
});

describe('уведомление и фильтр', () => {
  it('уведомление: решение, остановка с любым значением причины, решение важнее остановки, ничего', () => {
    const halted = (reason: 'budget' | 'human') => ({ reason, at: 'x', detail: 'budget spent' });
    const plan = autoPlan([item(1)], [], halted('budget'));
    expect(buildRoomBoard(input(plan)).notice).toEqual({ kind: 'halted', detail: 'budget spent' });
    expect(buildRoomBoard(input(autoPlan([item(1)], [], halted('human')))).notice).toEqual({ kind: 'halted', detail: 'budget spent' });
    const proposal = { proposal: { id: 'p', by: 's-03', at: 'x', text: 't' } } as unknown as Partial<Room>;
    expect(buildRoomBoard(input(plan, { room: proposal })).notice).toEqual({ kind: 'decision' });
    expect(buildRoomBoard(input(planOf('verified', [item(1)]))).notice).toBeNull();
    expect(buildRoomBoard(input(autoPlan([item(1)], [], null))).notice).toBeNull();
  });

  it('фильтр: агенты и проверяющие без повторов, по номеру сессии, без сессий вне карты', () => {
    const plan = planOf('verified', [
      item(1, { owner: 's-10', status: 'in_progress' }), item(2, { owner: 's-02', status: 'in_progress' }),
      item(3, { owner: 's-09', status: 'in_progress' }), item(4, { owner: 's-02', status: 'done', verifier: 's-10' }),
    ]);
    const sessions = [makeSession('s-02', 'a'), makeSession('s-10', 'b'), makeSession('s-03', 'lead')];
    const model = buildRoomBoard(input(plan, { sessions, room: { members: ['s-02', 's-10', 's-03'] } }));
    expect(model.filterAgents.map((agent) => agent.id)).toEqual(['s-02', 's-10']);
  });
});
