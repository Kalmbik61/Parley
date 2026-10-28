import { describe, expect, it } from 'vitest';
import type { ProviderEntry, RoleSummary, WorkEntry, WorkMap, WorkSession } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { memberOf, preparePlan, stateRefusal, type PlanContext, type PreparedPlan } from './actions.js';
import { targetsOf, type OverviewSource } from './overview.js';

// Работа w-1 «Parley» в /p: четыре сессии разных состояний и две комнаты (как MAP в assistant-service.test.ts).
const MAP = {
  schemaVersion: 2,
  work: { id: 'w-1', title: 'Parley', goal: '', status: 'active' },
  sessions: [
    { id: 's-03', label: 'S03 Ruslan', provider: 'claude', task: 'tests', summary: null, lifecycle: 'active' },
    { id: 's-02', label: 'S02 Anna', provider: 'claude', task: 'docs', summary: null, lifecycle: 'active' },
    { id: 's-04', label: 'S04 Nik', provider: 'claude', task: 'ops', summary: null, lifecycle: 'sleeping' },
    { id: 's-09', label: 'S09 Old', provider: 'claude', task: 'old', summary: null, lifecycle: 'closed' },
  ],
  messages: [],
  rooms: [
    { id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null },
    { id: 'r-2', title: 'Gate', creator: 's-03', members: ['s-03', 's-02'], createdAt: '', lead: 's-03', proposal: null },
  ],
} as unknown as WorkMap;

const LIVE: Record<string, SessionLive> = {
  's-03': { activity: { activity: 'working', waitingFor: null }, metrics: null } as unknown as SessionLive,
  's-02': { activity: { activity: 'idle', waitingFor: null }, metrics: null } as unknown as SessionLive,
};
const source: OverviewSource = {
  entries: [{ projectPath: '/p', map: MAP }] as WorkEntry[],
  live: (ref) => LIVE[ref.sessionId],
  roomTail: () => [],
  home: '/u',
};
const closedId = targetsOf(source, { hidden: true }).find((target) => target.kind === 'session' && target.name === 'S09 Old')?.id ?? '';

const role = (name: string, from: RoleSummary['source'], extra: Partial<RoleSummary> = {}): RoleSummary => ({
  id: `${from}:${name}`, name, description: '', source: from, provider: 'claude', model: null, effort: null, readOnly: false, ...extra,
});
const ROLES = [role('Reviewer', 'builtin', { models: { claude: 'opus', codex: 'gpt-5.5' } }), role('Code Reviewer', 'claude')];
const registry = {
  claude: { id: 'claude', label: 'Claude' },
  codex: { id: 'codex', label: 'Codex' },
} as unknown as Record<string, ProviderEntry>;
const ctx: PlanContext = { source, roles: async () => ROLES, registry, ready: async () => null, fallbackProvider: 'claude' };

const prepared = async (steps: unknown[], context: PlanContext = ctx): Promise<PreparedPlan> => {
  const result = await preparePlan({ steps }, context);
  if ('error' in result) throw new Error(result.error);
  return result.plan;
};

describe('preparePlan: удачные планы', () => {
  it('работа → три агента с ролями → комната из них → задача — один план', async () => {
    const result = await preparePlan({ steps: [
      { do: 'create_work', project: 'p', title: 'Auth refactor' },
      { do: 'create_session', work: '$1', role: 'reviewer' },
      { do: 'create_session', work: '$1', name: 'Vera', provider: 'codex' },
      { do: 'create_session', work: '$1' },
      { do: 'create_room', work: '$1', title: 'QA', members: ['$2', '$3', '$4'], task: 'Start with tests.' },
    ] }, ctx);
    const { plan } = result as { plan: PreparedPlan };
    expect(plan.view.map((step) => step.line)).toEqual([
      'Create work "Auth refactor" in project p',
      'Create an agent in "Auth refactor" · role Reviewer · Claude Code · opus',
      'Create an agent "Vera" in "Auth refactor" · Codex',
      'Create an agent in "Auth refactor" · Claude Code',
      'Create room "QA" in "Auth refactor" with the agent from step 2, agent "Vera" from step 3, the agent from step 4 (lead the agent from step 2)',
    ]);
    expect(plan.view.map((step) => step.verb)).toEqual(['create_work', 'create_session', 'create_session', 'create_session', 'create_room']);
    expect(plan.view[4]?.text).toBe('Start with tests.');
    expect(plan.text.startsWith('Update Parley to confirm this card.\n1. Create work')).toBe(true);
    expect(plan.target).toBe('5 steps');
    expect(plan.where).toBe('Parley');
    // Что уйдёт в sessions.create: модель роли не передаётся, пока человек не назвал свою.
    expect(plan.steps[1]).toMatchObject({
      do: 'create_session', work: { step: 1 }, label: '', provider: 'claude', model: null, task: '', role: { source: 'builtin', name: 'Reviewer' },
    });
    expect(plan.steps[2]).toMatchObject({ do: 'create_session', label: 'Vera', provider: 'codex', role: null });
    expect(plan.steps[4]).toMatchObject({
      do: 'create_room', work: { step: 1 }, title: 'QA', task: 'Start with tests.',
      members: [{ step: 2 }, { step: 3 }, { step: 4 }], lead: { step: 2 },
    });
  });

  it('одиночные шаги: строки, опасность, ссылки на известные цели', async () => {
    const plan = await prepared([{ do: 'close', session: 'S02' }]);
    expect(plan.view[0]).toEqual({ verb: 'close', line: 'Close S02 Anna for good', text: null, danger: true });
    expect(plan.target).toBe('Close S02 Anna for good');
    expect(plan.where).toBe('Parley · p');
    expect(plan.steps[0]).toEqual({ do: 'close', session: { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-02' }, name: 'S02 Anna' } });
    const lines = (await prepared([
      { do: 'wake', session: 'S04', text: 'Carry on.' },
      { do: 'interrupt', session: 'S03' },
      { do: 'sleep', session: 'S02' },
    ])).view.map((step) => step.line);
    expect(lines).toEqual(['Wake S04 Nik', 'Stop what S03 Ruslan is doing', 'Put S02 Anna to sleep']);
  });

  it('close — danger, текст под шагом режется до 300 у нескольких шагов', async () => {
    const plan = await prepared([{ do: 'close', session: 'S02' }, { do: 'message', target: 'Auth', text: 'x'.repeat(1000) }]);
    expect(plan.view[0]).toMatchObject({ verb: 'close', danger: true, line: 'Close S02 Anna for good' });
    expect(plan.view[1]?.text).toHaveLength(300);
    expect(plan.view[1]?.text?.endsWith('…')).toBe(true);
    expect(plan.steps[1]).toMatchObject({ text: 'x'.repeat(1000) });
  });

  it('у одиночного шага текст режется до 1500', async () => {
    const plan = await prepared([{ do: 'message', target: 'Auth', text: 'y'.repeat(2000) }]);
    expect(plan.view[0]?.text).toHaveLength(1500);
  });

  it('письмо: в комнату с упомянутыми, в спящую сессию, kind по умолчанию', async () => {
    const plan = await prepared([
      { do: 'message', target: 'Gate', text: 'Status?', mention: ['S02'], kind: 'question' },
      { do: 'message', target: 'Auth', text: 'Note.' },
      { do: 'message', target: 'S04', text: 'Wake up.' },
      { do: 'message', target: 'S03', text: 'Hi.' },
    ]);
    expect(plan.view.map((step) => step.line)).toEqual(['Message room "Gate" for S02 Anna', 'Message room "Auth"', 'Message S04 Nik (wakes it)', 'Message S03 Ruslan']);
    expect(plan.steps[0]).toMatchObject({
      do: 'message', kind: 'question', session: null, room: { projectPath: '/p', workId: 'w-1', roomId: 'r-2', title: 'Gate' },
      to: [{ ref: { sessionId: 's-02' }, name: 'S02 Anna' }],
    });
    expect(plan.steps[1]).toMatchObject({ kind: 'note', to: [] });
    expect(plan.steps[2]).toMatchObject({ kind: null, room: null, session: { ref: { sessionId: 's-04' } } });
  });

  it('add_to_room из другой комнаты — пометка «leaves room»', async () => {
    const plan = await prepared([{ do: 'add_to_room', room: 'Auth', session: 'S02' }]);
    expect(plan.view[0]?.line).toBe('Add S02 Anna to room "Auth" (leaves room "Gate")');
    expect(plan.steps[0]).toMatchObject({ do: 'add_to_room', room: { roomId: 'r-1' }, session: { ref: { sessionId: 's-02' } } });
    expect((await prepared([{ do: 'add_to_room', room: 'Auth', session: 'S04' }])).view[0]?.line).toBe('Add S04 Nik to room "Auth"');
  });

  it('комната в известной работе: участники ищутся среди сессий этой работы, ведущий по умолчанию — первый', async () => {
    const plan = await prepared([{ do: 'create_room', work: 'Parley', title: 'QA', members: ['S02', 'S04'], lead: 'S04' }]);
    expect(plan.view[0]?.line).toBe('Create room "QA" in "Parley" with S02 Anna, S04 Nik (lead S04 Nik)');
    expect(plan.steps[0]).toMatchObject({ lead: { ref: { sessionId: 's-04' } }, task: null });
    expect((await prepared([{ do: 'create_room', work: 'Parley', title: 'QA', members: ['S02', 'S04'] }])).view[0]?.line).toContain('(lead S02 Anna)');
  });

  it('агент плана в комнате известной работы, потом письмо в эту комнату с упоминанием', async () => {
    const plan = await prepared([
      { do: 'create_session', work: 'Parley', name: 'Vera' },
      { do: 'create_room', work: 'Parley', title: 'QA', members: ['$1', 'S02'] },
      { do: 'message', target: '$2', text: 'Go.', mention: ['$1'] },
    ]);
    expect(plan.view[2]?.line).toBe('Message room "QA" for agent "Vera" from step 1');
    expect(plan.steps[2]).toMatchObject({ room: { step: 2 }, to: [{ step: 1 }] });
    expect(plan.where).toBe('Parley · p');
  });

  it('«leaves room» учитывает и комнаты, созданные этим же планом', async () => {
    const plan = await prepared([
      { do: 'create_room', work: 'Parley', title: 'QA', members: ['S04'] },
      { do: 'add_to_room', room: 'Auth', session: 'S04' },
    ]);
    expect(plan.view[1]?.line).toBe('Add S04 Nik to room "Auth" (leaves room "QA")');
  });
});

describe('preparePlan: отказы целиком', () => {
  it.each([
    [{ do: 'create_room', work: 'Parley', title: 'X', members: ['$2'] }, 'Step 1: "$2" points to a later step'],
    [{ do: 'sleep', session: 'S04' }, 'Step 1: S04 Nik is already asleep'],
    [{ do: 'wake', session: 'S03' }, 'Step 1: S03 Ruslan is already awake'],
    [{ do: 'interrupt', session: 'S02' }, 'Step 1: S02 Anna is not doing anything right now'],
    [{ do: 'interrupt', session: 'S04' }, 'Step 1: S04 Nik is asleep'],
    [{ do: 'close', session: closedId }, 'Step 1: S09 Old is closed; reopen it in Parley first'],
    [{ do: 'add_to_room', room: 'Auth', session: 'S03' }, 'Step 1: S03 Ruslan is already in room "Auth"'],
    [{ do: 'wake', session: 'Auth' }, 'Step 1: Auth is a room, not a session'],
    [{ do: 'message', target: 'Parley', text: 'x' }, 'Step 1: Parley is a work; message a room or a session'],
    [{ do: 'message', target: 'S03', text: 'x', mention: ['S02'] }, 'Step 1: mention is only for rooms'],
    [{ do: 'message', target: 'Auth', text: 'x', mention: ['S02'] }, 'Step 1: S02 Anna is not in room "Auth"; its members: S03 Ruslan'],
    [{ do: 'message', target: 'Gate', text: 'x', mention: [closedId] }, 'Step 1: S09 Old is not in room "Gate"; its members: S03 Ruslan, S02 Anna'],
    [{ do: 'create_room', work: 'Parley', title: 'X', members: ['S02', 's-02'] }, 'Step 1: S02 Anna is listed twice in members'],
    [{ do: 'create_room', work: 'Parley', title: 'X', members: ['S02'], lead: 'S03' }, 'Step 1: lead S03 Ruslan is not among members'],
    [{ do: 'create_room', work: 'Parley', title: 'X', members: ['S09'] }, 'Step 1: S09 Old is closed'],
    [{ do: 'create_room', work: 'Parley', title: 'X', members: ['nobody'] }, 'Step 1: No session "nobody" in work "Parley". Call parley_overview for the current ids.'],
    [{ do: 'create_session', work: 'Parley', role: 'view' }, 'Step 1: "view" matches several roles: Reviewer (builtin), Code Reviewer (claude). Say which one.'],
    [{ do: 'create_session', work: 'Parley', provider: 'gemini' }, 'Step 1: No provider "gemini". Providers: claude, codex.'],
    [{ do: 'create_work', project: 'nowhere', title: 'X' }, 'Step 1: "nowhere" is not a Parley project; add it in Parley first.'],
  ])('%j', async (step, error) => {
    expect(await preparePlan({ steps: [step] }, ctx)).toEqual({ error });
  });

  it('ссылка не того вида или на шаг, что ничего не создаёт', async () => {
    expect(await preparePlan({ steps: [{ do: 'create_work', project: 'p', title: 'W' }, { do: 'sleep', session: '$1' }] }, ctx))
      .toEqual({ error: 'Step 2: "$1" is a work, not a session' });
    expect(await preparePlan({ steps: [{ do: 'sleep', session: 'S03' }, { do: 'create_room', work: '$1', title: 'X', members: ['S02'] }] }, ctx))
      .toEqual({ error: 'Step 2: "$1" is a sleep step, not a work' });
    expect(await preparePlan({ steps: [{ do: 'create_session', work: '$1' }] }, ctx)).toEqual({ error: 'Step 1: "$1" points to a later step' });
  });

  it('сессия, созданная планом, годится только для комнаты и письма комнате', async () => {
    const head = { do: 'create_session', work: 'Parley', name: 'Vera' };
    expect(await preparePlan({ steps: [head, { do: 'wake', session: '$1' }] }, ctx)).toEqual({ error: 'Step 2: the agent from step 1 is created by this plan' });
    expect(await preparePlan({ steps: [head, { do: 'close', session: '$1' }] }, ctx)).toEqual({ error: 'Step 2: the agent from step 1 is created by this plan' });
    expect(await preparePlan({ steps: [head, { do: 'message', target: '$1', text: 'Hi' }] }, ctx)).toEqual({ error: 'Step 2: give the agent from step 1 its first turn as task' });
  });

  it('агент плана из другой работы в комнату не идёт', async () => {
    const result = await preparePlan({ steps: [
      { do: 'create_work', project: 'p', title: 'Other' },
      { do: 'create_session', work: '$1' },
      { do: 'create_room', work: 'Parley', title: 'X', members: ['$2'] },
    ] }, ctx);
    expect(result).toEqual({ error: 'Step 3: the agent from step 2 is in another work than "Parley"' });
  });

  it('в работе, которую создаёт план, известных сессий нет', async () => {
    const result = await preparePlan({ steps: [
      { do: 'create_work', project: 'p', title: 'Other' },
      { do: 'create_room', work: '$1', title: 'X', members: ['S02'] },
    ] }, ctx);
    expect(result).toEqual({ error: expect.stringMatching(/^Step 2: No session "S02" in work "Other"/) });
  });

  it('21 шаг или пустой план — отказ', async () => {
    expect(await preparePlan({ steps: Array.from({ length: 21 }, () => ({ do: 'sleep', session: 'S03' })) }, ctx)).toEqual({ error: 'A plan has 1 to 20 steps.' });
    expect(await preparePlan({ steps: [] }, ctx)).toEqual({ error: 'A plan has 1 to 20 steps.' });
    expect(await preparePlan({}, ctx)).toEqual({ error: 'A plan has 1 to 20 steps.' });
    expect(await preparePlan(null, ctx)).toEqual({ error: 'A plan has 1 to 20 steps.' });
  });

  it('форма шага: чего не хватает, что длинно, какой глагол', async () => {
    expect(await preparePlan({ steps: [{ do: 'sleep' }] }, ctx)).toEqual({ error: 'Step 1: session is required' });
    expect(await preparePlan({ steps: [{ do: 'wake', session: 'S04' }, { do: 'fly' }] }, ctx)).toEqual({ error: expect.stringMatching(/^Step 2: do must be one of create_work, create_session, /) });
    expect(await preparePlan({ steps: ['sleep'] }, ctx)).toEqual({ error: 'Step 1: a step must be an object' });
    expect(await preparePlan({ steps: [{ do: 'create_work', project: 'p', title: ' ' }] }, ctx)).toEqual({ error: 'Step 1: title is required' });
    expect(await preparePlan({ steps: [{ do: 'create_work', project: 'p', title: 'x'.repeat(81) }] }, ctx)).toEqual({ error: 'Step 1: title must be 1–80 characters' });
    expect(await preparePlan({ steps: [{ do: 'message', target: 'Auth', text: 'x'.repeat(4001) }] }, ctx)).toEqual({ error: 'Step 1: text is longer than 4000 characters' });
    expect(await preparePlan({ steps: [{ do: 'create_room', work: 'Parley', title: 'X', members: [] }] }, ctx)).toEqual({ error: 'Step 1: members is empty; name at least one session of the work' });
    expect(await preparePlan({ steps: [{ do: 'message', target: 'Auth', text: 'x', kind: 'shout' }] }, ctx)).toEqual({ error: 'Step 1: kind must be note, question or decision' });
  });

  it('строки обрезаются по краям', async () => {
    const plan = await prepared([{ do: 'wake', session: '  S04  ', text: '  hello  ' }]);
    expect(plan.steps[0]).toMatchObject({ do: 'wake', text: 'hello' });
  });
});

describe('preparePlan: провайдер и модель', () => {
  it('названная модель подписью уходит значением, показывается она же', async () => {
    const withModels = {
      ...registry,
      claude: { id: 'claude', label: 'Claude', models: [{ id: 'opus', label: 'Opus 4.6' }, { id: 'sonnet', label: 'Sonnet' }] },
    } as unknown as Record<string, ProviderEntry>;
    const plan = await prepared([{ do: 'create_session', work: 'Parley', model: 'Opus 4.6' }], { ...ctx, registry: withModels });
    expect(plan.steps[0]).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(plan.view[0]?.line).toBe('Create an agent in "Parley" · Claude Code · opus');
  });

  it('роли берутся для проекта работы, один раз на проект', async () => {
    const asked: string[] = [];
    const counting: PlanContext = { ...ctx, roles: async (projectPath) => { asked.push(projectPath); return ROLES; } };
    await prepared([
      { do: 'create_session', work: 'Parley', role: 'reviewer' },
      { do: 'create_session', work: 'Parley', role: 'Code Reviewer' },
      { do: 'create_session', work: 'Parley' },
    ], counting);
    expect(asked).toEqual(['/p']);
  });
});

describe('stateRefusal', () => {
  const session = (lifecycle: WorkSession['lifecycle']): WorkSession => ({ id: 's-1', lifecycle }) as unknown as WorkSession;
  const live = (activity: 'working' | 'blocked' | 'unseen' | 'idle'): SessionLive => ({ activity: { activity, waitingFor: null }, metrics: null }) as unknown as SessionLive;
  it.each([
    ['wake', 'sleeping', undefined, null],
    ['wake', 'active', undefined, 'S1 is already awake'],
    ['wake', 'pending', undefined, 'S1 has not started yet'],
    ['wake', 'closed', undefined, 'S1 is closed'],
    ['interrupt', 'active', 'working', null],
    ['interrupt', 'active', 'blocked', null],
    ['interrupt', 'active', 'idle', 'S1 is not doing anything right now'],
    ['interrupt', 'active', 'unseen', 'S1 is not doing anything right now'],
    ['interrupt', 'sleeping', undefined, 'S1 is asleep'],
    ['interrupt', 'pending', undefined, 'S1 has not started yet'],
    ['interrupt', 'closed', undefined, 'S1 is closed'],
    ['sleep', 'active', undefined, null],
    ['sleep', 'sleeping', undefined, 'S1 is already asleep'],
    ['sleep', 'pending', undefined, 'S1 has not started yet'],
    ['sleep', 'closed', undefined, 'S1 is closed'],
    ['close', 'active', undefined, null],
    ['close', 'sleeping', undefined, null],
    ['close', 'pending', undefined, null],
    ['close', 'closed', undefined, 'S1 is closed'],
    ['message', 'active', undefined, null],
    ['message', 'sleeping', undefined, null],
    ['message', 'pending', undefined, 'S1 has not started yet'],
    ['message', 'closed', undefined, 'S1 is closed'],
  ] as const)('%s: %s / %s', (verb, lifecycle, activity, expected) => {
    expect(stateRefusal(verb, 'S1', session(lifecycle), activity === undefined ? undefined : live(activity))).toBe(expected);
  });
  it('сессии нет в карте — закрыта', () => {
    for (const verb of ['wake', 'interrupt', 'sleep', 'close', 'message'] as const) expect(stateRefusal(verb, 'S1', undefined, undefined)).toBe('S1 is closed');
  });
  it('активную сессию, которой нужен человек, прервать можно: она blocked, хотя ход закончен', () => {
    const waiting = { activity: { activity: 'idle', waitingFor: null, need: { kind: 'limit', since: '', detail: null, resetsAt: null } }, metrics: null } as unknown as SessionLive;
    expect(stateRefusal('interrupt', 'S1', session('active'), waiting)).toBeNull();
  });
});

describe('memberOf', () => {
  it('сессия работы по id, имени, первому слову и полному id цели', () => {
    const prefix = 'abc:w-1';
    expect(memberOf(MAP, 's-03', prefix)).toEqual({ session: { id: 's-03', name: 'S03 Ruslan', lifecycle: 'active' } });
    expect(memberOf(MAP, 'S03 Ruslan', prefix)).toMatchObject({ session: { id: 's-03' } });
    expect(memberOf(MAP, 's03', prefix)).toMatchObject({ session: { id: 's-03' } });
    expect(memberOf(MAP, 'session:abc:w-1:s-04', prefix)).toMatchObject({ session: { id: 's-04' } });
    expect(memberOf(MAP, 'session:other:w-1:s-04', prefix)).toMatchObject({ status: 404 });
    expect(memberOf(MAP, 'S09', prefix)).toMatchObject({ session: { lifecycle: 'closed' } });
  });
  it('нет такой — 404 с советом, несколько — 400 со списком', () => {
    expect(memberOf(MAP, 'nobody', 'p')).toEqual({ status: 404, body: { error: 'No session "nobody" in work "Parley". Call parley_overview for the current ids.' } });
    const twins = { ...MAP, sessions: [{ id: 's-01', label: 'Anna', lifecycle: 'active' }, { id: 's-02', label: 'Anna Two', lifecycle: 'active' }] } as unknown as WorkMap;
    expect(memberOf(twins, 'anna', 'p')).toEqual({ status: 400, body: { error: '"anna" matches several sessions of "Parley": Anna, Anna Two' } });
  });
});
