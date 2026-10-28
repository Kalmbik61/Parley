import { describe, expect, it } from 'vitest';
import type { FeedCard, SessionNeed, WorkEntry, WorkMap } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { cardLine, detailText, overviewText, resolveTarget, targetsOf, type OverviewSource } from './overview.js';

function session(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, label, provider: 'claude', task: `task of ${label}`, summary: null, lifecycle: 'active', ...extra };
}
function entry(projectPath: string, workId: string, title: string, overrides: Partial<WorkMap> = {}): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status: 'active' },
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera')],
      messages: [],
      rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05'], createdAt: '', lead: 's-03', proposal: null }],
      ...overrides,
    } as unknown as WorkMap,
  };
}
const live = (activity: string, waitingFor: string | null = null): SessionLive =>
  ({ activity: { activity, waitingFor }, metrics: null }) as unknown as SessionLive;

const needOf = (kind: SessionNeed['kind'], over: Partial<SessionNeed> = {}): SessionNeed => ({
  kind,
  since: '2026-10-21T12:00:00.000Z',
  detail: null,
  resetsAt: null,
  window: null,
  account: null,
  ...over,
});
/** Живая сессия, которой нужен человек: ход закончен (`unseen`/`idle`), а `need` стоит (лимит и вход оставляют ход законченным). */
const liveNeed = (activity: string, need: SessionNeed): SessionLive =>
  ({ activity: { activity, waitingFor: null, need }, metrics: null }) as unknown as SessionLive;

function source(entries: WorkEntry[], states: Record<string, SessionLive>): OverviewSource {
  return {
    entries,
    live: (ref) => states[ref.sessionId],
    roomTail: (item, roomId, count) => item.map.messages.filter((message) => message.roomId === roomId).slice(-count),
  };
}

describe('targetsOf и resolveTarget', () => {
  const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('idle') });
  it('id по проекту, работе и элементу', () => {
    const ids = targetsOf(src).map((target) => target.id);
    expect(ids).toHaveLength(4);
    expect(ids.every((id) => /^(work|room|session):[0-9a-f]{6}:w-1(:|$)/.test(id))).toBe(true);
  });
  it('работа — цель, первая в своей работе; находится по id и точному названию', () => {
    const targets = targetsOf(src);
    expect(targets[0]).toMatchObject({ kind: 'work', name: 'Parley', workId: 'w-1', projectPath: '/p/one' });
    expect(targets[0]?.id).toMatch(/^work:[0-9a-f]{6}:w-1$/);
    expect(resolveTarget(targets, 'Parley')).toEqual({ target: targets[0] });
    expect(resolveTarget(targets, targets[0]?.id ?? '')).toEqual({ target: targets[0] });
  });
  it('находит по id, по имени и по первому слову имени', () => {
    const targets = targetsOf(src);
    const room = targets.find((target) => target.kind === 'room');
    expect(resolveTarget(targets, room?.id ?? '')).toEqual({ target: room });
    expect(resolveTarget(targets, 'auth')).toMatchObject({ target: { kind: 'room', name: 'Auth' } });
    expect(resolveTarget(targets, 'S03')).toMatchObject({ target: { kind: 'session', name: 'S03 Ruslan' } });
  });
  it('неоднозначное имя — ошибка со списком, неизвестное — подсказка', () => {
    const two = targetsOf(source([entry('/p/one', 'w-1', 'Parley'), entry('/p/two', 'w-2', 'Site')], {}));
    expect(resolveTarget(two, 'Auth')).toMatchObject({ error: expect.stringContaining('several') });
    expect(resolveTarget(two, 'Billing')).toMatchObject({ error: expect.stringContaining('parley_overview') });
  });
  it('архивная работа, архивная комната и закрытая сессия — не цели', () => {
    const archived = entry('/p/a', 'w-a', 'Old', { work: { id: 'w-a', title: 'Old', goal: '', status: 'archived' } } as Partial<WorkMap>);
    const roomArchived = entry('/p/b', 'w-b', 'B', {
      rooms: [{ id: 'r-9', title: 'Gone', creator: 's-03', members: [], createdAt: '', lead: null, proposal: null, archivedAt: '2026-10-01' }],
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'closed' })],
    } as unknown as Partial<WorkMap>);
    // Остаётся только цель-работа: комната в архиве, сессия закрыта, архивной работы нет вовсе.
    expect(targetsOf(source([archived, roomArchived], {})).map((target) => target.kind)).toEqual(['work']);
  });
  it('спящая сессия без live — running: false, lifecycle sleeping', () => {
    const sleeping = entry('/p/one', 'w-1', 'Parley', { sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping' })] } as unknown as Partial<WorkMap>);
    const target = targetsOf(source([sleeping], {})).find((item) => item.kind === 'session');
    expect(target).toMatchObject({ running: false, lifecycle: 'sleeping' });
  });
  it('сессия после resume (lifecycle active, activity idle) — running: true', () => {
    const resumed = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('idle') });
    const target = targetsOf(resumed).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(target).toMatchObject({ running: true, lifecycle: 'active' });
  });
  it('живая сессия без выведенной activity — тоже running: true', () => {
    const target = targetsOf(source([entry('/p/one', 'w-1', 'Parley')], {})).find((item) => item.kind === 'session');
    expect(target).toMatchObject({ running: true, lifecycle: 'active' });
  });
});

describe('overviewText', () => {
  it('ждущие человека — первыми, с тем, чего ждут', () => {
    const text = overviewText(source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('blocked', 'Bash: rm -rf dist') }));
    expect(text).toContain('Work "Parley"');
    expect(text).toContain('Room "Auth"');
    expect(text.indexOf('Session S05 Vera')).toBeLessThan(text.indexOf('Session S03 Ruslan'));
    expect(text).toContain('waiting for: Bash: rm -rf dist');
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] claude · needs you · /);
    expect(text).toContain('1 need the person');
  });
  it('сессия с need (лимит) — ждущая, хотя activity говорит unseen: слово вида и причина вместо слова состояния', () => {
    const text = overviewText(source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': liveNeed('unseen', needOf('limit')) }));
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] claude · limit — Hit its Claude Code usage limit; the reset time is unknown · /);
    expect(text).not.toContain('done · unseen');
    expect(text).toContain('1 need the person');
    // Ждущая — первой, перед работающей.
    expect(text.indexOf('Session S05 Vera')).toBeLessThan(text.indexOf('Session S03 Ruslan'));
  });
  it('need у сессии с activity idle (вход): тоже ждущая, причина называет аккаунт по реестру', () => {
    const providers = { 'custom-x': { id: 'custom-x', label: 'Claude Code X' } };
    const account = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera', { provider: 'custom-x' })],
    } as unknown as Partial<WorkMap>);
    const text = overviewText({
      ...source([account], { 's-03': live('idle'), 's-05': liveNeed('idle', needOf('sign-in', { account: 'auth', detail: 'Not logged in' })) }),
      providers,
    });
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] custom-x · sign-in — Signed out of Claude Code X: Not logged in · /);
    expect(text).toContain('1 need the person');
    expect(text).not.toMatch(/Session S05 Vera[^\n]* idle/);
  });
  it('need у спящей сессии не считается: запись активности могла остаться от прошлого процесса', () => {
    const sleeping = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping' }), session('s-05', 'S05 Vera')],
    } as unknown as Partial<WorkMap>);
    const text = overviewText(source([sleeping], { 's-03': liveNeed('idle', needOf('limit')), 's-05': live('idle') }));
    expect(text).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · asleep · /);
    expect(text).not.toContain('need the person');
  });
  it('у сессии — её комната: модель пишет агенту через неё с упоминанием; вне комнаты — без пометки', () => {
    const rooms = [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null }];
    const text = overviewText(source([entry('/p/one', 'w-1', 'Parley', { rooms } as Partial<WorkMap>)], { 's-03': live('working'), 's-05': live('idle') }));
    expect(text).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · working · in room "Auth" · task/);
    expect(text).not.toMatch(/Session S05 Vera[^\n]*in room/);
  });
  it('слова состояний — из единой таблицы: idle у resume, asleep у спящей без live', () => {
    const mixed = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping' }), session('s-05', 'S05 Vera')],
    } as unknown as Partial<WorkMap>);
    const text = overviewText(source([mixed], { 's-05': live('idle') }));
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] claude · idle · /);
    expect(text).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · asleep · /);
    expect(text.indexOf('Session S05 Vera')).toBeLessThan(text.indexOf('Session S03 Ruslan'));
  });
  it('завершённая сессия с итогом называется по итогу, а не asleep', () => {
    const finished = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping', result: 'done' })],
    } as unknown as Partial<WorkMap>);
    expect(overviewText(source([finished], {}))).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · done · /);
  });
  it('пусто — так и говорит', () => {
    expect(overviewText(source([], {}))).toBe('No works are open in Parley right now.');
  });
  // 12 работ по 8 сессий (task 150 знаков, summary 200) и 3 комнаты; s-07 каждой работы — blocked.
  const levelLabels = ['S01 Anna', 'S02 Boris', 'S03 Ruslan', 'S04 Dina', 'S05 Vera', 'S06 Oleg', 'S07 Lena', 'S08 Igor'];
  const levelSessions = levelLabels.map((label, index) =>
    session(`s-0${index + 1}`, label, { task: `task of ${label}`.padEnd(150, '.'), summary: `summary of ${label}`.padEnd(200, '.') }),
  );
  const levelStates: Record<string, SessionLive> = {
    's-01': live('idle'), 's-02': live('idle'), 's-03': live('working'), 's-04': live('idle'),
    's-05': live('idle'), 's-06': live('idle'), 's-07': live('blocked', 'Bash: rm'), 's-08': live('idle'),
  };
  const levelRooms = [
    { id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05', 's-07'], createdAt: '', lead: null, proposal: null },
    { id: 'r-2', title: 'Ship', creator: 's-01', members: ['s-01'], createdAt: '', lead: 's-01', proposal: { id: 'p-01', from: 's-01', text: 'Accept the change', rev: 1, at: '' } },
    { id: 'r-3', title: 'Empty', creator: 's-03', members: [], createdAt: '', lead: null, proposal: null },
  ];
  const src = source(
    Array.from({ length: 12 }, (_, index) =>
      entry(`/p/proj-${index + 1}`, `w-${index + 1}`, `Work ${index + 1}`, { sessions: levelSessions, rooms: levelRooms } as unknown as Partial<WorkMap>),
    ),
    levelStates,
  );
  // Одна открытая работа с закрытой сессией и архивной комнатой и одна архивная работа.
  const hiddenSrc = source(
    [
      entry('/p/open', 'w-1', 'Open', {
        sessions: [session('s-03', 'S03 Ruslan'), session('s-09', 'S09 Old', { lifecycle: 'closed' })],
        rooms: [
          { id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null },
          { id: 'r-9', title: 'Gone', creator: 's-03', members: [], createdAt: '', lead: null, proposal: null, archivedAt: '2026-10-01' },
        ],
      } as unknown as Partial<WorkMap>),
      entry('/p/old', 'w-2', 'Old', { work: { id: 'w-2', title: 'Old', goal: '', status: 'archived' } } as Partial<WorkMap>),
    ],
    {},
  );

  it('обзор без потерь: 12 работ по 8 сессий и 3 комнаты — все id в тексте', () => {
    const text = overviewText(src);
    for (const target of targetsOf(src)) expect(text).toContain(`[${target.id}]`);
    expect(text).not.toContain('not shown');
  });
  it('ступень 1: у простаивающих нет task, у работающих есть', () => {
    const full = overviewText(src, Number.POSITIVE_INFINITY);
    const one = overviewText(src, full.length - 1);
    expect(one).toContain('task: task of S03 Ruslan'); // working
    expect(one).not.toContain('task: task of S05 Vera'); // idle
  });
  it('ступень 2: task остаётся только у ждущих человека', () => {
    const one = overviewText(src, overviewText(src, Number.POSITIVE_INFINITY).length - 1);
    const two = overviewText(src, one.length - 1);
    expect(two).not.toContain('task: task of S03 Ruslan');
    expect(two).toContain('task: task of S07 Lena');
  });
  it('ступень 3: сжатые строки, ждущие и решения ведущих — целиком', () => {
    const three = overviewText(src, 1);
    expect(three).toMatch(/^ {2}Session S05 Vera \[session:[0-9a-f]{6}:w-1:s-05\] claude · idle · in room "Auth"$/m);
    expect(three).toMatch(/^ {2}Room "Auth" \[room:[0-9a-f]{6}:w-1:r-1\]: 3 members, 1 working, 1 need the person$/m);
    expect(three).toContain('waiting for: Bash: rm');
    expect(three).toContain('waits: decision from');
  });
  it('строка о скрытом: закрытые, архивные комнаты и работы', () => {
    expect(overviewText(hiddenSrc)).toMatch(/Also 1 closed session, 1 archived room, 1 archived work — use parley_find with include_closed/);
    expect(overviewText(src)).not.toContain('Also ');
  });
  it('нет открытых работ, но есть архивные — пустой обзор и строка о скрытом', () => {
    const onlyOld = source([entry('/p/old', 'w-2', 'Old', { work: { id: 'w-2', title: 'Old', goal: '', status: 'archived' } } as Partial<WorkMap>)], {});
    expect(overviewText(onlyOld)).toMatch(/^No works are open in Parley right now\.\n\nAlso 1 archived work — use parley_find/);
  });
  it('две папки с одним именем — у работы родительская папка', () => {
    const text = overviewText({ ...source([entry('/u/me/Desktop/scanum', 'w-1', 'A'), entry('/u/me/work/scanum', 'w-2', 'B')], {}), home: '/u/me' });
    expect(text).toContain('(project scanum in ~/Desktop)');
    expect(text).toContain('(project scanum in ~/work)');
    expect(overviewText(source([entry('/p/parley', 'w-1', 'A')], {}))).toContain('(project parley)');
  });
});

describe('detailText', () => {
  it('сессия — последний ответ', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('idle') });
    const target = targetsOf(src).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(detailText(src, target!, 'Тесты зелёные.')).toContain('Last reply: Тесты зелёные.');
  });
  it('сессия с need — слово вида и причина, как в обзоре', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': liveNeed('unseen', needOf('limit')) });
    const target = targetsOf(src).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(detailText(src, target!, null)).toContain('claude · limit — Hit its Claude Code usage limit; the reset time is unknown');
  });
  it('комната — последние сообщения', () => {
    const map = entry('/p/one', 'w-1', 'Parley', {
      messages: [{ id: 'm1', roomId: 'r-1', from: 'human', to: [], at: '2026-10-15T10:00:00Z', text: 'Как дела?', kind: 'question', readBy: {} }],
    } as unknown as Partial<WorkMap>);
    const src = source([map], {});
    const room = targetsOf(src).find((item) => item.kind === 'room');
    expect(detailText(src, room!, null)).toContain('Как дела?');
  });
});

const permissionCard = {
  kind: 'permission', id: 'c12', cardId: 'c12', at: '', state: 'pending', toolUseId: null, toolName: 'Bash',
  toolInput: { command: 'rm -rf dist' }, suggestions: [], notified: false,
} as unknown as FeedCard;
const questionCard = {
  kind: 'question', id: 'c13', cardId: 'c13', at: '', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion',
  toolInput: {}, questions: [{ question: 'Первая строка?\nвторая', options: [] }],
} as unknown as FeedCard;
const planCard = {
  kind: 'plan', id: 'c14', cardId: 'c14', at: '', state: 'pending', toolUseId: null, toolName: 'ExitPlanMode',
  toolInput: {}, plan: 'a\nb\nc', planFilePath: null,
} as unknown as FeedCard;

describe('cardLine', () => {
  it('разрешение, вопрос и план', () => {
    expect(cardLine(permissionCard, '/p/one')).toBe('permission — Bash: rm -rf dist (card c12)');
    expect(cardLine(questionCard, '/p/one')).toBe('question — Первая строка? (card c13)');
    expect(cardLine(planCard, '/p/one')).toBe('plan — 3 lines (card c14)');
  });
});

describe('overviewText: ждущие карточки и решения комнат', () => {
  const blocked = { 's-03': live('working'), 's-05': live('blocked', 'Bash: rm -rf dist') };
  it('строка работы несёт id работы', () => {
    expect(overviewText(source([entry('/p/one', 'w-1', 'Parley')], {}))).toMatch(/Work "Parley" \[work:[0-9a-f]{6}:w-1\] \(project one\)/);
  });
  it('у blocked-сессии с cards — строка waits: с карточкой', () => {
    const src = { ...source([entry('/p/one', 'w-1', 'Parley')], blocked), cards: () => [permissionCard] };
    const text = overviewText(src);
    expect(text).toContain('waiting for: Bash: rm -rf dist');
    expect(text).toContain('waits: permission — Bash: rm -rf dist (card c12)');
  });
  it('карточек не больше трёх; без cards или с undefined — только waiting for', () => {
    const many = { ...source([entry('/p/one', 'w-1', 'Parley')], blocked), cards: () => [permissionCard, questionCard, planCard, permissionCard] };
    expect(overviewText(many).match(/waits: /g)).toHaveLength(3);
    expect(overviewText(source([entry('/p/one', 'w-1', 'Parley')], blocked))).not.toContain('waits:');
    const none = { ...source([entry('/p/one', 'w-1', 'Parley')], blocked), cards: () => undefined };
    expect(overviewText(none)).not.toContain('waits:');
  });
  it('карточки не-blocked сессии не показываются', () => {
    const src = { ...source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working') }), cards: () => [permissionCard] };
    expect(overviewText(src)).not.toContain('waits:');
  });
  const proposal = (kind?: 'completion') => ({ ...(kind === undefined ? {} : { kind }), id: 'p-03', from: 's-03', text: 'Принять '.repeat(60), rev: 1, at: '' });
  const withProposal = (kind?: 'completion') =>
    entry('/p/one', 'w-1', 'Parley', {
      rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05'], createdAt: '', lead: 's-03', proposal: proposal(kind) }],
    } as unknown as Partial<WorkMap>);
  it('комната со слотом proposal — waits: decision from … до 200 знаков; completion — completion from', () => {
    const text = overviewText(source([withProposal()], {}));
    expect(text).toContain('waits: decision from S03 Ruslan (p-03, rev 1): Принять');
    const line = text.split('\n').find((item) => item.includes('Room "Auth"')) ?? '';
    expect(line.split('waits: ')[1]?.length).toBeLessThan(260);
    expect(overviewText(source([withProposal('completion')], {}))).toContain('waits: completion from S03 Ruslan (p-03, rev 1)');
  });
  it('detailText комнаты показывает решение до 1500 знаков', () => {
    const src = source([withProposal()], {});
    const room = targetsOf(src).find((item) => item.kind === 'room');
    const text = detailText(src, room!, null);
    expect(text).toContain('Decision from S03 Ruslan (p-03, rev 1): Принять');
    expect(text.split('Decision from ')[1]?.length).toBeGreaterThan(300);
  });
  it('detailText сессии с ждущей карточкой — раздел Waiting: со строкой карточки и вариантами', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('blocked'), 's-05': live('idle') });
    const target = targetsOf(src).find((item) => item.kind === 'session' && item.name.startsWith('S03'));
    const card = {
      kind: 'question', id: 'q1', cardId: 'q1', at: '', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
      questions: [{ question: 'Which db?', header: null, multiSelect: false, options: [{ label: 'pg', description: null }, { label: 'sqlite', description: null }] }],
    } as unknown as FeedCard;
    const text = detailText(src, target!, null, [card]);
    expect(text).toContain('Waiting:');
    expect(text).toContain('question — Which db? (card q1)');
    expect(text).toContain('- sqlite');
    expect(detailText(src, target!, null)).not.toContain('Waiting:');
  });
  it('detailText работы — её снимок', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], {});
    expect(detailText(src, targetsOf(src)[0]!, null)).toContain('Room "Auth"');
  });
});
