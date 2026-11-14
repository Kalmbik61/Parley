import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSessionName, type WorkEntry, type WorkMap, type WorkSession } from '@parley/core';
import type { ActionsReport, SessionRef } from '@parley/protocol';
import type { SessionLive } from '../activity/activity-service.js';
import type { PreparedPlan, PreparedStep, SessionPick } from './actions.js';
import type { OverviewSource } from './overview.js';
import { planClick, planOutcome, runPlan, STEP_CLASSES, type PlanExecutors } from './run-plan.js';

const session = (id: string, label: string, lifecycle: WorkSession['lifecycle']): WorkSession =>
  ({ id, label, provider: 'claude', task: '', summary: null, lifecycle }) as unknown as WorkSession;

// Состояние «хоста» между шагами: тест меняет его руками, фейки исполнителей дописывают созданное.
let w1: WorkMap;
let w2: WorkMap | null;
let queue: string[];
let nextId: number;

const workMap = (id: string, title: string, sessions: WorkSession[], rooms: unknown[] = []): WorkMap =>
  ({ schemaVersion: 2, work: { id, title, goal: '', status: 'active' }, sessions, messages: [], rooms }) as unknown as WorkMap;

const LIVE: Record<string, SessionLive> = {
  's-03': { activity: { activity: 'working', waitingFor: null }, metrics: null } as unknown as SessionLive,
  's-05': { activity: { activity: 'idle', waitingFor: null }, metrics: null } as unknown as SessionLive,
};

const snapshot = (): OverviewSource => ({
  entries: [{ projectPath: '/p', map: w1 }, ...(w2 === null ? [] : [{ projectPath: '/p', map: w2 }])] as WorkEntry[],
  live: (ref) => LIVE[ref.sessionId],
  roomTail: () => [],
  home: '/u',
});

const ref = (workId: string, sessionId: string): SessionRef => ({ projectPath: '/p', workId, sessionId });
const known = (sessionId: string, name: string): { ref: SessionRef; name: string } => ({ ref: ref('w-1', sessionId), name });
const made = (step: number, name = `the agent from step ${step}`): SessionPick => ({ step, name });

const plan = (steps: PreparedStep[]): PreparedPlan => ({
  steps,
  view: steps.map((step, index) => ({ verb: step.do, line: `line ${index + 1}`, text: null, danger: step.do === 'close' })),
  target: '',
  where: '',
  text: '',
});

const createWork: PreparedStep = { do: 'create_work', projectPath: '/p', title: 'Auth refactor', goal: '' };
const createAgent = (label: string, extra: Partial<Extract<PreparedStep, { do: 'create_session' }>> = {}): PreparedStep => ({
  do: 'create_session', work: { step: 1 }, label, role: null, provider: 'claude', model: null, task: 'go', ...extra,
});
const createRoom: PreparedStep = { do: 'create_room', work: { step: 1 }, title: 'QA', members: [made(2), made(3)], lead: made(2), task: null };

function makeExec() {
  const exec = {
    source: vi.fn<PlanExecutors['source']>(snapshot),
    createWork: vi.fn<PlanExecutors['createWork']>(async ({ title }) => {
      w2 = workMap('w-2', title, []);
      return 'w-2';
    }),
    createSession: vi.fn<PlanExecutors['createSession']>(async ({ workId }) => {
      const label = queue.shift() ?? `Agent${nextId}`;
      const id = `s-0${nextId++}`;
      (workId === 'w-2' ? w2 : w1)?.sessions.push(session(id, label, 'pending'));
      return { ref: ref(workId, id), held: false };
    }),
    resume: vi.fn<PlanExecutors['resume']>(async () => 'started'),
    interrupt: vi.fn<PlanExecutors['interrupt']>(async () => undefined),
    sleep: vi.fn<PlanExecutors['sleep']>(async () => undefined),
    close: vi.fn<PlanExecutors['close']>(async () => undefined),
    createRoom: vi.fn<PlanExecutors['createRoom']>(async () => 'r-9'),
    addMember: vi.fn<PlanExecutors['addMember']>(async () => undefined),
    roomMessage: vi.fn<PlanExecutors['roomMessage']>(async () => undefined),
    sessionMessage: vi.fn<PlanExecutors['sessionMessage']>(async () => null),
    lean: vi.fn<PlanExecutors['lean']>(async () => true),
    now: undefined as PlanExecutors['now'],
    gave: undefined as PlanExecutors['gave'],
  };
  return exec;
}

let exec: ReturnType<typeof makeExec>;
let onProgress: ReturnType<typeof vi.fn<(report: ActionsReport) => void>>;
const run = (steps: PreparedStep[], stop: () => boolean = () => false): Promise<ActionsReport> => runPlan('p1', plan(steps), exec, onProgress, stop);

beforeEach(() => {
  w1 = workMap('w-1', 'Parley', [session('s-03', 'S03 Ruslan', 'active'), session('s-05', 'S05 Vera', 'active'), session('s-06', 'S06 Nik', 'sleeping')], [
    { id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null },
    { id: 'r-2', title: 'Old', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null, archivedAt: '2026-10-01T00:00:00Z' },
  ]);
  w2 = null;
  queue = ['Alice', 'Bob'];
  nextId = 1;
  exec = makeExec();
  onProgress = vi.fn<(report: ActionsReport) => void>();
});

describe('runPlan: ход плана', () => {
  it('все шаги по порядку; $N подставляется итогом', async () => {
    const report = await run([createWork, createAgent('Alice'), createAgent('Bob'), createRoom]);
    expect(report).toMatchObject({ proposalId: 'p1', status: 'done', failedStep: null, reason: null, notes: [] });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(report.steps.map((step) => step.line)).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
    expect(exec.createWork).toHaveBeenCalledWith({ projectPath: '/p', title: 'Auth refactor', goal: '' });
    expect(exec.createSession).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/p', workId: 'w-2', label: 'Alice', task: 'go', lean: true, model: null }));
    expect(exec.createRoom).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', title: 'QA', members: ['s-01', 's-02'], lead: 's-01' });
    expect(exec.roomMessage).not.toHaveBeenCalled();
  });

  it('роль, провайдер и модель уходят в createSession как есть', async () => {
    const role = { source: 'builtin', name: 'Reviewer' } as unknown as Extract<PreparedStep, { do: 'create_session' }>['role'];
    await run([createWork, createAgent('', { role, provider: 'codex', model: 'gpt-5.5' })]);
    expect(exec.createSession).toHaveBeenCalledWith(expect.objectContaining({ role, provider: 'codex', model: 'gpt-5.5', label: '' }));
  });

  it('падение на шаге 3: 4 и 5 не идут, отчёт называет шаг', async () => {
    exec.sleep.mockRejectedValueOnce(new Error('pty is gone'));
    const report = await run([
      { do: 'wake', session: known('s-06', 'S06 Nik'), text: null },
      { do: 'interrupt', session: known('s-03', 'S03 Ruslan') },
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ]);
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'done', 'failed', 'skipped', 'skipped']);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 3, reason: 'pty is gone' });
    expect(exec.close).not.toHaveBeenCalled();
    expect(exec.resume).toHaveBeenCalledWith(known('s-06', 'S06 Nik').ref, null);
    expect(exec.interrupt).toHaveBeenCalledWith(known('s-03', 'S03 Ruslan').ref);
  });

  it('сверка перед шагом: сессию усыпили руками между предложением и кликом', async () => {
    w1.sessions[0]!.lifecycle = 'sleeping';
    expect(await run([{ do: 'sleep', session: known('s-03', 'S03 Ruslan') }])).toMatchObject({ status: 'stopped', failedStep: 1, reason: 'S03 Ruslan is already asleep' });
    expect(exec.sleep).not.toHaveBeenCalled();
  });

  it('сверка перед шагом: состояние берётся заново для каждого шага', async () => {
    exec.sleep.mockImplementationOnce(async () => {
      w1.sessions[1]!.lifecycle = 'sleeping';
    });
    const report = await run([
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
    ]);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 2, reason: 'S05 Vera is already asleep' });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'failed']);
  });

  it('interrupt: сессия, что ничего не делает, — отказ', async () => {
    expect(await run([{ do: 'interrupt', session: known('s-05', 'S05 Vera') }])).toMatchObject({ reason: 'S05 Vera is not doing anything right now' });
  });

  it('закрытая сессия: wake отвечает «is closed»', async () => {
    w1.sessions[2]!.lifecycle = 'closed';
    expect(await run([{ do: 'wake', session: known('s-06', 'S06 Nik'), text: 'up' }])).toMatchObject({ reason: 'S06 Nik is closed' });
    expect(exec.resume).not.toHaveBeenCalled();
  });

  it('работа ушла из снимка или в архив — шаг не идёт', async () => {
    const step: PreparedStep = { do: 'create_session', work: { projectPath: '/p', workId: 'w-1', title: 'Parley' }, label: 'A', role: null, provider: 'claude', model: null, task: '' };
    w1.work.status = 'archived';
    expect(await run([step])).toMatchObject({ status: 'stopped', reason: 'Work "Parley" is archived' });
    const gone: PreparedStep = { ...step, work: { projectPath: '/p', workId: 'w-7', title: 'Gone' } } as PreparedStep;
    expect(await run([gone])).toMatchObject({ reason: 'Work "Gone" is no longer in Parley' });
    expect(exec.createSession).not.toHaveBeenCalled();
  });

  it('комната в архиве или пропала — add_to_room и письмо не идут', async () => {
    const archived = { projectPath: '/p', workId: 'w-1', roomId: 'r-2', title: 'Old' };
    expect(await run([{ do: 'add_to_room', room: archived, session: known('s-05', 'S05 Vera') }])).toMatchObject({ reason: 'Room "Old" is archived' });
    const gone = { projectPath: '/p', workId: 'w-1', roomId: 'r-7', title: 'Gone' };
    expect(await run([{ do: 'message', room: gone, session: null, text: 'hi', kind: 'note', to: [] }])).toMatchObject({ reason: 'Room "Gone" is no longer in Parley' });
    expect(exec.addMember).not.toHaveBeenCalled();
    expect(exec.roomMessage).not.toHaveBeenCalled();
  });

  it('stop(): шаг не начинается, причина — Parley is stopping', async () => {
    let calls = 0;
    const report = await run([
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ], () => ++calls > 1);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 2, reason: 'Parley is stopping' });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'failed']);
    expect(exec.close).not.toHaveBeenCalled();
  });

  it('ход виден: onProgress получает running у текущего шага', async () => {
    await run([
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ]);
    const seen = onProgress.mock.calls.map(([report]) => report.steps.map((step) => step.status).join(','));
    expect(seen).toContain('running,waiting');
    expect(seen).toContain('done,running');
    expect(seen.at(-1)).toBe('done,done');
    expect(onProgress.mock.calls[0]?.[0].status).toBe('running');
  });
});

describe('runPlan: создание агента', () => {
  it('held у Codex — шаг сделан с пометкой, план идёт дальше', async () => {
    exec.createSession.mockImplementationOnce(async ({ workId }) => {
      w2?.sessions.push(session('s-01', 'Alice', 'pending'));
      return { ref: ref(workId, 's-01'), held: true };
    });
    const report = await run([createWork, createAgent('Alice'), createAgent('Bob'), createRoom]);
    expect(report).toMatchObject({ status: 'done', notes: ['Alice waits for you to trust the folder'] });
  });

  it('имя агента в пометке — из свежего снимка, а не со слов карточки', async () => {
    queue = ['S01 Vera'];
    exec.createSession.mockImplementationOnce(async ({ workId }) => {
      w2?.sessions.push(session('s-01', 'S01 Vera', 'pending'));
      return { ref: ref(workId, 's-01'), held: true };
    });
    const report = await run([createWork, createAgent('Vera')]);
    expect(report).toMatchObject({ status: 'done', notes: ['S01 Vera waits for you to trust the folder'] });
  });

  it('held у wake — та же пометка', async () => {
    exec.resume.mockResolvedValueOnce('held');
    const report = await run([{ do: 'wake', session: known('s-06', 'S06 Nik'), text: 'Carry on.' }]);
    expect(report).toMatchObject({ status: 'done', notes: ['S06 Nik waits for you to trust the folder'] });
    expect(exec.resume).toHaveBeenCalledWith(known('s-06', 'S06 Nik').ref, 'Carry on.');
  });

  it('queued у создания агента — шаг сделан с пометкой очереди, план идёт дальше', async () => {
    exec.createSession.mockImplementationOnce(async ({ workId }) => {
      w2?.sessions.push(session('s-01', 'Alice', 'pending'));
      return { ref: ref(workId, 's-01'), held: false, queued: 'machine-limit' };
    });
    const report = await run([createWork, createAgent('Alice')]);
    expect(report).toMatchObject({ status: 'done', notes: ['Alice is queued for a free agent slot; it starts by itself'] });
  });

  it('queued у wake — пометка очереди с просьбой повторить текст', async () => {
    exec.resume.mockResolvedValueOnce('queued');
    const report = await run([{ do: 'wake', session: known('s-06', 'S06 Nik'), text: 'Carry on.' }]);
    expect(report).toMatchObject({ status: 'done', notes: ['S06 Nik is queued for a free agent slot; send the text again after it starts'] });
    expect(exec.resume).toHaveBeenCalledWith(known('s-06', 'S06 Nik').ref, 'Carry on.');
  });

  it('упавший запуск — остановка с пометкой о записи pending', async () => {
    exec.createSession.mockImplementationOnce(async () => {
      w2?.sessions.push(session('s-01', 'Alice', 'pending'));
      throw new Error('claude did not start');
    });
    const report = await run([createWork, createAgent('Alice'), createAgent('Bob')]);
    expect(report).toMatchObject({
      status: 'stopped', failedStep: 2, reason: 'claude did not start; Alice was created but did not start; it is in Parley as pending',
    });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'failed', 'skipped']);
  });

  it('упавший запуск без новой записи — просто причина', async () => {
    exec.createSession.mockRejectedValueOnce(new Error('no such provider'));
    expect(await run([createWork, createAgent('Alice')])).toMatchObject({ reason: 'no such provider' });
  });

  it('запись, что была до шага, не считается созданной им', async () => {
    const step: PreparedStep = { do: 'create_session', work: { projectPath: '/p', workId: 'w-1', title: 'Parley' }, label: 'A', role: null, provider: 'claude', model: null, task: '' };
    exec.createSession.mockRejectedValueOnce(new Error('boom'));
    expect(await run([step])).toMatchObject({ reason: 'boom' });
  });
});

describe('runPlan: комнаты и письма', () => {
  it('задача комнаты уходит письмом note без адресатов', async () => {
    await run([createWork, createAgent('Alice'), createAgent('Bob'), { ...createRoom, task: 'Start with tests.' } as PreparedStep]);
    expect(exec.roomMessage).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', roomId: 'r-9', to: [], text: 'Start with tests.', kind: 'note' });
  });

  it('сбой письма с задачей — шаг упал, комната осталась', async () => {
    exec.roomMessage.mockRejectedValueOnce(new Error('mail is down'));
    const report = await run([createWork, createAgent('Alice'), createAgent('Bob'), { ...createRoom, task: 'Go.' } as PreparedStep]);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 4, reason: 'room "QA" was created, but its task was not sent: mail is down' });
  });

  it('письмо в комнату шага: $N комнаты, адресаты $N из to', async () => {
    const report = await run([
      createWork, createAgent('Alice'), createAgent('Bob'), createRoom,
      { do: 'message', room: { step: 4 }, session: null, text: 'Status?', kind: 'question', to: [made(3, 'agent "Bob" from step 3'), known('s-05', 'S05 Vera')] },
    ]);
    expect(report.status).toBe('done');
    expect(exec.roomMessage).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', roomId: 'r-9', to: ['s-02', 's-05'], text: 'Status?', kind: 'question' });
  });

  it('письмо в известную комнату', async () => {
    const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Auth' };
    await run([{ do: 'message', room, session: null, text: 'Note.', kind: 'note', to: [known('s-03', 'S03 Ruslan')] }]);
    expect(exec.roomMessage).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: ['s-03'], text: 'Note.', kind: 'note' });
  });

  it('адресат письма закрыт к клику — шаг не идёт', async () => {
    w1.sessions[1]!.lifecycle = 'closed';
    const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Auth' };
    expect(await run([{ do: 'message', room, session: null, text: 'Note.', kind: 'note', to: [known('s-05', 'S05 Vera')] }])).toMatchObject({ reason: 'S05 Vera is closed' });
    expect(exec.roomMessage).not.toHaveBeenCalled();
  });

  it('письмо сессии: живой и спящей — через sessionMessage; строка в ответе — отказ', async () => {
    const report = await run([{ do: 'message', room: null, session: known('s-06', 'S06 Nik'), text: 'Wake up.', kind: null, to: [] }]);
    expect(report.status).toBe('done');
    expect(exec.sessionMessage).toHaveBeenCalledWith(known('s-06', 'S06 Nik').ref, 'S06 Nik', 'Wake up.');
    exec.sessionMessage.mockResolvedValueOnce('S06 Nik is not reachable');
    expect(await run([{ do: 'message', room: null, session: known('s-06', 'S06 Nik'), text: 'Hi.', kind: null, to: [] }])).toMatchObject({ failedStep: 1, reason: 'S06 Nik is not reachable' });
  });

  it('письмо закрытой сессии — отказ при сверке', async () => {
    w1.sessions[2]!.lifecycle = 'closed';
    expect(await run([{ do: 'message', room: null, session: known('s-06', 'S06 Nik'), text: 'Hi.', kind: null, to: [] }])).toMatchObject({ reason: 'S06 Nik is closed' });
    expect(exec.sessionMessage).not.toHaveBeenCalled();
  });

  it('созданные планом агенты ещё не в снимке — комната из них всё равно создаётся', async () => {
    // Наблюдатель за файлами отстаёт: работа и сессии записаны на диск, но снимок их не видит.
    exec.createWork.mockImplementationOnce(async () => 'w-2');
    exec.createSession.mockImplementation(async ({ workId }) => ({ ref: ref(workId, `s-0${nextId++}`), held: false }));
    const report = await run([createWork, createAgent('Alice'), createAgent('Bob'), createRoom]);
    expect(report).toMatchObject({ status: 'done', failedStep: null, reason: null });
    expect(exec.createRoom).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', title: 'QA', members: ['s-01', 's-02'], lead: 's-01' });
  });

  it('агент без ярлыка, которого нет в снимке, зовётся именем по умолчанию', async () => {
    exec.createSession.mockImplementationOnce(async ({ workId }) => ({ ref: ref(workId, 's-01'), held: true }));
    const report = await run([createWork, createAgent('')]);
    expect(report).toMatchObject({ status: 'done', notes: [`${defaultSessionName('s-01')} waits for you to trust the folder`] });
  });

  it('созданная планом сессия, которую снимок показывает закрытой, — отказ', async () => {
    exec.createSession.mockImplementationOnce(async ({ workId }) => {
      w2?.sessions.push(session('s-01', 'Alice', 'closed'));
      return { ref: ref(workId, 's-01'), held: false };
    });
    const report = await run([createWork, createAgent('Alice'), { do: 'message', room: null, session: made(2, 'Alice'), text: 'Hi.', kind: null, to: [] }]);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 3, reason: 'Alice is closed' });
    expect(exec.sessionMessage).not.toHaveBeenCalled();
  });

  it('add_to_room: сессия созданная планом, комната известная', async () => {
    const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Auth' };
    const step: PreparedStep = { do: 'create_session', work: { projectPath: '/p', workId: 'w-1', title: 'Parley' }, label: 'Alice', role: null, provider: 'claude', model: null, task: '' };
    const report = await run([step, { do: 'add_to_room', room, session: made(1) }]);
    expect(report.status).toBe('done');
    expect(exec.addMember).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', sessionId: 's-01' });
  });
});

describe('runPlan: ход исполнения и итог (спека автономии §5.3)', () => {
  const traced = async (steps: PreparedStep[], stop: () => boolean | string = () => false, failConfirm: number | null = null) => {
    const marks: string[] = [];
    const started = new Set<number>();
    const partial = new Map<number, string[]>();
    const report = await runPlan('p1', plan(steps), exec, onProgress, stop, {
      started: (step) => {
        started.add(step);
        marks.push(`started:${step}`);
      },
      confirmed: (step) => {
        if (step === failConfirm) throw new Error('database is locked');
        marks.push(`confirmed:${step}`);
      },
      effect: (step, what) => partial.set(step, [...(partial.get(step) ?? []), what]),
    });
    return { report, marks, outcome: planOutcome(report, started, partial) };
  };

  it('один журнал порядка: started → эффект → confirmed; пока эффект удержан, confirmed не записан', async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    exec.sleep.mockImplementation(async () => {
      log.push('effect:1');
      await new Promise<void>((resolve) => { release = resolve; });
      log.push('effect:1 returned');
    });
    exec.close.mockImplementation(async () => {
      log.push('effect:2');
    });
    const running = runPlan('p1', plan([
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ]), exec, onProgress, () => false, { started: (step) => log.push(`started:${step}`), confirmed: (step) => log.push(`confirmed:${step}`) });
    await vi.waitFor(() => expect(log).toContain('effect:1'));
    expect(log).toEqual(['started:1', 'effect:1']);
    release();
    const report = await running;
    expect(log).toEqual(['started:1', 'effect:1', 'effect:1 returned', 'confirmed:1', 'started:2', 'effect:2', 'confirmed:2']);
    expect(planOutcome(report, new Set([1, 2]))).toEqual({ status: 'done', effects: ['line 1', 'line 2'], retry: 'unsafe', reason: null });
  });

  it('пометки шагов входят в причину итога done', async () => {
    exec.createSession.mockResolvedValueOnce({ ref: ref('w-1', 's-07'), held: true });
    const step: PreparedStep = { do: 'create_session', work: { projectPath: '/p', workId: 'w-1', title: 'Parley' }, label: 'Alice', role: null, provider: 'claude', model: null, task: '' };
    const { outcome } = await traced([step]);
    expect(outcome).toMatchObject({ status: 'done', reason: expect.stringContaining('waits for you to trust the folder') });
  });

  it('план из 5 шагов падает на третьем (эффект начат): partial, сделаны 1–2, причина называет шаг; 4–5 не начаты', async () => {
    exec.sleep.mockRejectedValueOnce(new Error('pty is gone'));
    const { report, marks, outcome } = await traced([
      { do: 'wake', session: known('s-06', 'S06 Nik'), text: null },
      { do: 'interrupt', session: known('s-03', 'S03 Ruslan') },
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ]);
    expect(report.status).toBe('stopped');
    expect(marks).toEqual(['started:1', 'confirmed:1', 'started:2', 'confirmed:2', 'started:3']);
    expect(outcome).toEqual({ status: 'partial', effects: ['line 1', 'line 2'], retry: 'unsafe', reason: 'stopped at step 3 of 5: pty is gone; step 3 may have taken effect' });
  });

  it('отказ сверки на первом шаге до эффекта: not_done, повтор разрешён; started не пишется', async () => {
    w1.sessions[0]!.lifecycle = 'sleeping';
    const { marks, outcome } = await traced([{ do: 'sleep', session: known('s-03', 'S03 Ruslan') }]);
    expect(marks).toEqual([]);
    expect(outcome).toEqual({ status: 'not_done', effects: [], retry: 'safe', reason: 'stopped at step 1 of 1: S03 Ruslan is already asleep' });
  });

  it('сбой эффекта первого шага: unknown, повтор запрещён', async () => {
    exec.sleep.mockRejectedValueOnce(new Error('socket closed'));
    const { outcome } = await traced([{ do: 'sleep', session: known('s-05', 'S05 Vera') }]);
    expect(outcome).toEqual({ status: 'unknown', effects: [], retry: 'unsafe', reason: 'stopped at step 1 of 1: socket closed; step 1 may have taken effect' });
  });

  const roomStep: PreparedStep = { do: 'create_room', work: { projectPath: '/p', workId: 'w-1', title: 'Parley' }, title: 'QA', members: [known('s-03', 'S03 Ruslan')], lead: known('s-03', 'S03 Ruslan'), task: 'go' };
  it('комната создана, задача не ушла (первый шаг): partial, созданная комната в effects', async () => {
    exec.roomMessage.mockRejectedValueOnce(new Error('db locked'));
    const { outcome } = await traced([roomStep]);
    expect(outcome).toEqual({ status: 'partial', effects: ['room "QA" created'], retry: 'unsafe', reason: 'stopped at step 1 of 1: room "QA" was created, but its task was not sent: db locked' });
  });
  it('комната создана, задача не ушла (после сделанного шага): partial, в effects и шаг, и комната', async () => {
    exec.roomMessage.mockRejectedValueOnce(new Error('db locked'));
    const { outcome } = await traced([{ do: 'sleep', session: known('s-05', 'S05 Vera') }, roomStep]);
    expect(outcome).toMatchObject({ status: 'partial', effects: ['line 1', 'room "QA" created'], retry: 'unsafe' });
  });
  it('сбой записи confirmed на третьем шаге: шаги 1–3 сделаны и в effects, остановка на шаге 3, следующие не начаты', async () => {
    const steps: PreparedStep[] = [
      { do: 'interrupt', session: known('s-03', 'S03 Ruslan') },
      { do: 'wake', session: known('s-06', 'S06 Nik'), text: null },
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-05', 'S05 Vera') },
    ];
    const { report, outcome } = await traced(steps, () => false, 3);
    expect(report).toMatchObject({ status: 'stopped', failedStep: 3, reason: 'step 3 was done, but Parley could not record it (database is locked); later steps were not started' });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'skipped']);
    expect(exec.close).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'partial', effects: ['line 1', 'line 2', 'line 3'], retry: 'unsafe', reason: 'stopped at step 3 of 4: step 3 was done, but Parley could not record it (database is locked); later steps were not started' });
  });
  it('сбой записи confirmed последнего шага: всё сделано — done с причиной', async () => {
    const { report, outcome } = await traced([{ do: 'sleep', session: known('s-05', 'S05 Vera') }], () => false, 1);
    expect(report.steps.map((step) => step.status)).toEqual(['done']);
    expect(outcome).toEqual({ status: 'done', effects: ['line 1'], retry: 'unsafe', reason: 'step 1 was done, but Parley could not record it (database is locked); later steps were not started' });
  });

  it('stop() со строкой: идущий шаг доводится, следующий не начат, причина — эта строка', async () => {
    let release: () => void = () => {};
    exec.sleep.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    let stopNow: string | false = false;
    const running = traced([
      { do: 'sleep', session: known('s-05', 'S05 Vera') },
      { do: 'close', session: known('s-03', 'S03 Ruslan') },
    ], () => stopNow);
    await vi.waitFor(() => expect(exec.sleep).toHaveBeenCalled());
    stopNow = 'Stopped by the person';
    release();
    const { report, marks, outcome } = await running;
    expect(report).toMatchObject({ status: 'stopped', failedStep: 2, reason: 'Stopped by the person' });
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'failed']);
    expect(exec.close).not.toHaveBeenCalled();
    expect(marks).toEqual(['started:1', 'confirmed:1']);
    expect(outcome).toEqual({ status: 'partial', effects: ['line 1'], retry: 'unsafe', reason: 'stopped at step 2 of 2: Stopped by the person' });
  });
});

describe('политика плана (спека автономии §5.9)', () => {
  it('все нынешние виды шагов — auto', () => {
    const kinds = ['create_work', 'create_session', 'wake', 'interrupt', 'sleep', 'close', 'create_room', 'add_to_room', 'message'];
    expect(Object.keys(STEP_CLASSES).sort()).toEqual([...kinds].sort());
    expect(planClick(kinds.map((kind) => ({ do: kind })))).toBeNull();
  });
  it('неизвестный вид или вид класса click — весь план кликом, причина называет шаг', () => {
    expect(planClick([{ do: 'sleep' }, { do: 'delete_work' }])).toBe('step 2 (delete_work) is not known to run without a click');
    expect(planClick([{ do: 'toString' }])).toBe('step 1 (toString) is not known to run without a click');
    STEP_CLASSES['close'] = 'click';
    try {
      expect(planClick([{ do: 'close' }])).toBe("step 1 (close) always needs the person's click");
    } finally {
      STEP_CLASSES['close'] = 'auto';
    }
  });
});

describe('runPlan: слежение за ответом (спека автономии §6.2)', () => {
  const gave = vi.fn<NonNullable<PlanExecutors['gave']>>();
  let clock = 100;
  beforeEach(() => {
    gave.mockReset();
    clock = 100;
    exec.now = () => clock;
    exec.gave = gave;
  });
  const message = (name: string, id: string): PreparedStep => ({ do: 'message', room: null, session: known(id, name), text: 'Do it.', kind: null, to: [] });

  it('since снят до эффекта; сообщение уходит после успешного шага, с именем и ref', async () => {
    exec.sessionMessage.mockImplementation(async () => {
      clock = 500;
      return null;
    });
    await run([message('S03 Ruslan', 's-03')]);
    expect(gave).toHaveBeenCalledWith({ ref: ref('w-1', 's-03'), name: 'S03 Ruslan', kind: 'prompt', since: 100 });
  });

  it('отказ шага — сообщения нет', async () => {
    exec.sessionMessage.mockResolvedValue('S03 Ruslan can\'t take a message now (busy)');
    await run([message('S03 Ruslan', 's-03')]);
    expect(gave).not.toHaveBeenCalled();
  });

  it('create_session с задачей и wake с текстом — слежение; без задачи и текста, удержанные и письма в комнату — нет', async () => {
    await run([createWork, createAgent('Alice'), createAgent('Bob', { task: '' }), { do: 'wake', session: known('s-06', 'S06 Nik'), text: 'Continue.' }]);
    expect(gave.mock.calls.map(([work]) => work.name)).toEqual(['Alice', 'S06 Nik']);
    gave.mockReset();
    exec.resume.mockResolvedValueOnce('held');
    await run([{ do: 'wake', session: known('s-06', 'S06 Nik'), text: 'Continue.' }]);
    await run([{ do: 'wake', session: known('s-06', 'S06 Nik'), text: null }]);
    await run([{ do: 'message', room: { projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Auth' }, session: null, text: 'Hi.', kind: 'note', to: [] }]);
    expect(gave).not.toHaveBeenCalled();
  });

  it('RW-06: остановка плана на третьем шаге оставляет слежения первых двух', async () => {
    let calls = 0;
    const report = await run([message('S03 Ruslan', 's-03'), message('S05 Vera', 's-05'), message('S06 Nik', 's-06')], () => ++calls > 2);
    expect(report.status).toBe('stopped');
    expect(gave.mock.calls.map(([work]) => work.name)).toEqual(['S03 Ruslan', 'S05 Vera']);
  });
});
