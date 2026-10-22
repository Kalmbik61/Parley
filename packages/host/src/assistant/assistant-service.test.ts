import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent, ProviderEntry, WorkEntry, WorkMap } from '@parley/core';
import type { AssistantState } from '@parley/protocol';
import { HostError } from '../errors.js';
import { createAssistantService, type AssistantServiceDeps } from './assistant-service.js';
import type { Reminder } from './reminders.js';
import type { TurnEnd, TurnSpec } from './turn.js';

interface FakeTurn { spec: TurnSpec; emit(event: AssistantStreamEvent): void; end(result: TurnEnd): void; cancelled: boolean }

const CLAUDE = { id: 'claude', label: 'Claude', runner: { command: 'claude', mcpConfig: 'json-file', assistantArgs: ['-p', '{prompt}'], assistantResumeArgs: ['-p', '{prompt}', '--resume', '{providerSessionId}'] } } as unknown as ProviderEntry;
const MAP = {
  schemaVersion: 2,
  work: { id: 'w-1', title: 'Parley', goal: '', status: 'active' },
  sessions: [{ id: 's-03', label: 'S03 Ruslan', provider: 'claude', task: 'tests', summary: null, lifecycle: 'active' },
    { id: 's-02', label: 'S02 Anna', provider: 'claude', task: 'docs', summary: null, lifecycle: 'active' },
    { id: 's-09', label: 'S09 Old', provider: 'claude', task: 'old', summary: null, lifecycle: 'closed' },
  ],
  messages: [],
  rooms: [
    { id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null },
    { id: 'r-2', title: 'Gate', creator: 's-03', members: ['s-03', 's-02'], createdAt: '', lead: 's-03', proposal: { id: 'p-01', kind: 'decision', from: 's-03', text: 'Ship it', rev: 2, at: '' } },
    { id: 'r-3', title: 'Quiet', creator: 's-03', members: ['s-03'], createdAt: '', lead: 's-03', proposal: null },
  ],
} as unknown as WorkMap;

let home = '';
let turns: FakeTurn[] = [];
let states: AssistantState[] = [];
let deps: AssistantServiceDeps;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-assistant-'));
  turns = [];
  states = [];
  let token: string | null = null;
  deps = {
    broadcast: (_event, data) => { states.push(data as AssistantState); },
    works: { snapshot: () => ({ entries: [{ projectPath: '/p', map: MAP }] as WorkEntry[], branches: {} }) },
    activity: { get: () => ({ activity: { activity: 'working', waitingFor: null }, metrics: null }) as never },
    send: vi.fn().mockResolvedValue({ inserted: true, submitted: true, reason: null }),
    launch: vi.fn().mockResolvedValue(undefined),
    sendLetter: vi.fn().mockResolvedValue('m-1'),
    createRoom: vi.fn().mockResolvedValue('r-9'),
    resolveRoomProposal: vi.fn().mockResolvedValue('m-2'),
    endpoint: { origin: () => 'http://127.0.0.1:9', setToken: (value) => { token = value; } },
    providers: async () => ({ claude: CLAUDE }),
    ready: async () => null,
    launchEnv: async () => ({}),
    binary: async (command) => `/bin/${command}`,
    reminders: { add: vi.fn(), list: vi.fn().mockReturnValue([]), cancel: vi.fn().mockReturnValue(0) },
    home,
    log: () => {},
    run: (spec, onEvent) => {
      let settle: (end: TurnEnd) => void = () => {};
      const turn: FakeTurn = { spec, emit: onEvent, end: (end) => settle(end), cancelled: false };
      turns.push(turn);
      return { cancel: () => { turn.cancelled = true; settle({ ok: false, kind: 'cancelled', message: 'cancelled' }); }, done: new Promise((resolve) => { settle = resolve; }) };
    },
  };
  void token;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const last = (): AssistantState => states.at(-1)!;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ASK = { text: 'кто работает?', provider: null, model: null, language: 'ru' as const };

describe('assistant-service: ход', () => {
  it('думает → ответ с эмоцией → свободен', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(last()).toMatchObject({ phase: 'thinking', question: 'кто работает?' });
    expect(turns[0]?.spec.command).toBe('/bin/claude');
    expect(turns[0]?.spec.args).toEqual(['-p', 'кто работает?']);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.emit({ type: 'tool', name: 'parley_overview', input: {} });
    expect(last()).toMatchObject({ phase: 'tool', detail: { tool: 'overview', target: null } });
    turns[0]?.emit({ type: 'text', delta: '[[jo' });
    turns[0]?.emit({ type: 'text', delta: 'y]] Работает S03.' });
    expect(last()).toMatchObject({ phase: 'answering', mood: 'joy', answer: 'Работает S03.' });
    turns[0]?.end({ ok: true });
    await flush();
    expect(last()).toMatchObject({ phase: 'idle', answer: 'Работает S03.' });
  });
  it('второй вопрос — --resume с id сессии', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'а комната?' });
    expect(turns[1]?.spec.args).toEqual(['-p', 'а комната?', '--resume', 'sid-1']);
  });
  it('перебивание: старый ход после нового вопроса молчит', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    await service.ask({ ...ASK, text: 'новый' });
    expect(turns[0]?.cancelled).toBe(true);
    turns[0]?.emit({ type: 'text', delta: '[[calm]] старое' });
    expect(last().answer).not.toContain('старое');
    expect(last().question).toBe('новый');
  });
  it('провайдер не готов — offline с причиной, хода нет', async () => {
    const service = createAssistantService({ ...deps, ready: async () => 'Claude CLI is not installed' });
    await service.ask(ASK);
    expect(last()).toMatchObject({ phase: 'offline', error: 'Claude CLI is not installed' });
    expect(turns).toHaveLength(0);
  });
  it('сбой до хода — error с вопросом, новым номером хода и askId: окно узнаёт, что вопрос дошёл', async () => {
    const service = createAssistantService({ ...deps, providers: async () => { throw new Error('providers.json is broken'); } });
    await service.ask({ ...ASK, askId: 'a-1' });
    expect(last()).toMatchObject({ phase: 'error', question: 'кто работает?', turn: 1, askId: 'a-1' });
  });
  it('askId вопроса — в состоянии хода; id процесса хоста один на все состояния', async () => {
    const service = createAssistantService(deps);
    expect(service.state().instance).toMatch(/^[0-9a-f]{16}$/);
    await service.ask({ ...ASK, askId: 'a-1' });
    expect(last()).toMatchObject({ phase: 'thinking', askId: 'a-1', instance: service.state().instance });
    expect(createAssistantService(deps).state().instance).not.toBe(service.state().instance);
  });
  it('отмена, пока ход запускается, — процесс не стартует', async () => {
    let release: (() => void) | null = null;
    const service = createAssistantService({ ...deps, launchEnv: () => new Promise((resolve) => { release = () => resolve({}); }) });
    const asking = service.ask(ASK);
    await vi.waitFor(() => expect(release).not.toBeNull());
    service.cancel();
    release!();
    await asking;
    expect(turns).toHaveLength(0);
    expect(states.some((state) => state.phase === 'thinking')).toBe(false);
  });
  it('бинаря нет — offline', async () => {
    const service = createAssistantService({ ...deps, binary: async () => { throw new Error('not found'); } });
    await service.ask(ASK);
    expect(last().phase).toBe('offline');
  });
  it('лимит — error с эмоцией error', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.end({ ok: false, kind: 'limit', message: "You've hit your limit · resets 3pm" });
    await flush();
    expect(last()).toMatchObject({ phase: 'error', mood: 'error' });
    expect(last().error).toContain('limit');
  });
  it('устаревший --resume — один повтор в новом разговоре', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'old' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    turns[1]?.end({ ok: false, kind: 'resume', message: 'No conversation found' });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    expect(turns[2]?.spec.args).toEqual(['-p', 'дальше']);
  });
  it('повтор без --resume не показывает окну idle посреди хода и не снимает карточку', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'old' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    await service.tool('propose_message', { target: 'Auth', text: 'Пропусти Safari' });
    const before = states.length;
    turns[1]?.end({ ok: false, kind: 'resume', message: 'No conversation found' });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    expect(states.slice(before).some((state) => state.phase === 'idle')).toBe(false);
    expect(last().proposal?.text).toBe('Пропусти Safari');
  });
});

describe('assistant-service: инструменты и карточка', () => {
  async function withProposal() {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'Auth', text: 'Пропусти Safari', kind: 'decision' });
    expect(reply.status).toBe(200);
    return service;
  }
  it('overview без разговора — 409, с разговором — текст', async () => {
    const service = createAssistantService(deps);
    expect((await service.tool('parley_overview', {})).status).toBe(409);
    await service.ask(ASK);
    const reply = await service.tool('parley_overview', {});
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('Room "Auth"') } });
  });
  it('propose → карточка; send → письмо в комнату с via', async () => {
    const service = await withProposal();
    const proposal = last().proposal;
    expect(proposal).toMatchObject({ target: 'Auth', kind: 'decision', text: 'Пропусти Safari', wake: false });
    turns[0]?.end({ ok: true });
    await flush();
    expect(last().phase).toBe('awaiting-confirm');
    await expect(service.decide(proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'Пропусти Safari', kind: 'decision' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'sent', phase: 'idle' });
  });
  it('mention в комнату — имена на карточке; send — to и токен @s03 в начале письма', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'Auth', text: 'Пропусти Safari', mention: ['S03'] });
    expect(reply.status).toBe(200);
    expect(last().proposal).toMatchObject({ target: 'Auth', mentions: ['S03 Ruslan'] });
    await service.decide(last().proposal!.id, 'send');
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: ['s-03'], text: '@s03 Пропусти Safari', kind: 'note' });
  });
  it('упоминание, что модель уже вписала в текст (@S03 или @s-03), не повторяется', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    await service.tool('propose_message', { target: 'Auth', text: '@S03, пропусти Safari', mention: ['S03 Ruslan'] });
    await service.decide(last().proposal!.id, 'send');
    expect(deps.sendLetter).toHaveBeenLastCalledWith(expect.objectContaining({ to: ['s-03'], text: '@S03, пропусти Safari' }));
    await service.tool('propose_message', { target: 'Auth', text: 'ок, @s-03', mention: ['S03'] });
    await service.decide(last().proposal!.id, 'send');
    expect(deps.sendLetter).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'ок, @s-03' }));
  });
  it('mention не участника комнаты — 400 со списком участников, карточки нет', async () => {
    const map = { ...MAP, sessions: [...MAP.sessions, { id: 's-05', label: 'S05 Vera', provider: 'claude', task: null, summary: null, lifecycle: 'active' }] } as unknown as WorkMap;
    const service = createAssistantService({ ...deps, works: { snapshot: () => ({ entries: [{ projectPath: '/p', map }] as WorkEntry[], branches: {} }) } });
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'Auth', text: 'x', mention: ['S05'] });
    expect(reply).toMatchObject({ status: 400, body: { error: 'S05 Vera is not in room "Auth"; its members: S03 Ruslan' } });
    expect(last().proposal).toBeNull();
  });
  it('mention у сессии — 400: прямое письмо адресуется целью', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'S03', text: 'x', mention: ['S03'] });
    expect(reply.status).toBe(400);
    expect(last().proposal).toBeNull();
  });
  it('исход карточки уходит модели служебной строкой', async () => {
    const service = await withProposal();
    turns[0]?.end({ ok: true });
    await flush();
    await service.decide(last().proposal!.id, 'cancel');
    await service.ask({ ...ASK, text: 'ладно' });
    expect(turns[1]?.spec.args[1]).toMatch(/^\[system: proposal p1 was cancelled\]\nладно$/);
  });
  it('send сессии, которая уже остановилась — карточка остаётся, причина в ответе', async () => {
    const service = createAssistantService({ ...deps, send: vi.fn().mockRejectedValue(new Error('session is not running')) });
    await service.ask(ASK);
    await service.tool('propose_message', { target: 'S03', text: 'Привет' });
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'session is not running' });
    expect(last().proposal?.id).toBe(id);
  });
  it('устаревшая карточка не применяется', async () => {
    const service = await withProposal();
    await expect(service.decide('p99', 'send')).resolves.toMatchObject({ applied: false });
    expect(deps.sendLetter).not.toHaveBeenCalled();
  });
  it('цель не найдена — 404 и карточки нет', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect((await service.tool('propose_message', { target: 'Billing', text: 'x' })).status).toBe(404);
    expect(last().proposal).toBeNull();
  });
  it('reset снимает карточку и токен', async () => {
    const service = await withProposal();
    service.reset();
    expect(last()).toMatchObject({ proposal: null, phase: 'idle', question: null });
    expect((await service.tool('parley_overview', {})).status).toBe(409);
  });
  it('после тишины (idleMs) разговор забывается', async () => {
    const service = createAssistantService({ ...deps, idleMs: 50 });
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.end({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await service.tool('parley_overview', {})).status).toBe(409);
  });
});

describe('assistant-service: спящая сессия', () => {
  const REF = { projectPath: '/p', workId: 'w-1', sessionId: 's-04' };
  let lifecycle = 'sleeping';
  beforeEach(() => { lifecycle = 'sleeping'; });

  // Карта собирается заново при каждом снимке: тест меняет `lifecycle` между предложением и решением.
  const wakeDeps = (): AssistantServiceDeps => {
    const map = (): WorkMap => ({ ...MAP, sessions: [{ id: 's-04', label: 'S04 Ana', provider: 'claude', task: 'docs', summary: null, lifecycle }], rooms: [] }) as unknown as WorkMap;
    return { ...deps, works: { snapshot: () => ({ entries: [{ projectPath: '/p', map: map() }] as WorkEntry[], branches: {} }) } };
  };
  async function withCard(overrides: Partial<AssistantServiceDeps> = {}) {
    const service = createAssistantService({ ...wakeDeps(), ...overrides });
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'S04', text: 'Привет, проснись' });
    return { service, reply };
  }

  it('propose на спящую сессию — карточка с wake: true, отказа нет', async () => {
    const { reply } = await withCard();
    expect(reply.status).toBe(200);
    expect(last().proposal).toMatchObject({ target: 'S04 Ana', kind: null, text: 'Привет, проснись', wake: true });
  });
  it('decide по карточке спящей сессии — resume с текстом первым ходом, send не зовётся, запись в журнале есть', async () => {
    const { service } = await withCard();
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.launch).toHaveBeenCalledWith(REF, 'resume', { by: 'human', prompt: 'Привет, проснись' });
    expect(deps.send).not.toHaveBeenCalled();
    await expect(service.sent(REF)).resolves.toMatchObject([{ text: 'Привет, проснись' }]);
    expect(last()).toMatchObject({ proposal: null, outcome: 'sent' });
  });
  it('propose на сессию, которая ещё не стартовала — 409 и карточки нет', async () => {
    lifecycle = 'pending';
    const { reply } = await withCard();
    expect(reply).toMatchObject({ status: 409, body: { error: 'S04 Ana has not started yet' } });
    expect(last().proposal).toBeNull();
  });
  it('decide: сессия за время ожидания проснулась — обычный send, не launch', async () => {
    const { service } = await withCard();
    lifecycle = 'active';
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.send).toHaveBeenCalledWith({ ref: REF, text: 'Привет, проснись', submit: true });
    expect(deps.launch).not.toHaveBeenCalled();
    await expect(service.sent(REF)).resolves.toMatchObject([{ text: 'Привет, проснись' }]);
  });
  it('decide: сессия за время ожидания закрылась — ошибка, карточка остаётся, ничего не отправлено', async () => {
    const { service } = await withCard();
    const id = last().proposal!.id;
    lifecycle = 'closed';
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'S04 Ana is closed' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(last().proposal?.id).toBe(id);
  });
  it('ошибка подъёма уходит в error карточки, записи в журнале нет', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('too many running sessions'));
    const { service } = await withCard({ launch });
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'too many running sessions' });
    expect(last().proposal?.id).toBe(id);
    await expect(service.sent(REF)).resolves.toEqual([]);
  });
});

describe('assistant-service: комната и решение ведущего', () => {
  async function started() {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    return service;
  }
  const ROOM = { work: 'Parley', title: 'Auth rework', members: ['S03', 'S02'], task: 'Разберите вход' };

  it('propose_room → карточка room; send создаёт комнату, шлёт задачу и закрывает исходом done', async () => {
    const service = await started();
    const reply = await service.tool('propose_room', ROOM);
    expect(reply.status).toBe(200);
    expect(last().proposal).toMatchObject({ action: 'room', target: 'Auth rework', title: 'Auth rework', members: ['S03 Ruslan', 'S02 Anna'], lead: 'S03 Ruslan', task: 'Разберите вход' });
    expect((last().proposal as { text: string }).text.startsWith('Create room "Auth rework" with S03 Ruslan, S02 Anna')).toBe(true);
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.createRoom).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', title: 'Auth rework', members: ['s-03', 's-02'], lead: 's-03' });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-9', to: [], text: 'Разберите вход', kind: 'note' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'done' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    expect(turns[1]?.spec.args.join(' ')).toContain('room "Auth rework" created');
  });
  it('propose_room: lead из участников, без задачи письмо не шлётся', async () => {
    const service = await started();
    await service.tool('propose_room', { work: 'Parley', title: 'Docs', members: ['S03', 'S02'], lead: 'S02' });
    expect(last().proposal).toMatchObject({ lead: 'S02 Anna', task: null });
    await service.decide(last().proposal!.id, 'send');
    expect(deps.createRoom).toHaveBeenCalledWith(expect.objectContaining({ lead: 's-02' }));
    expect(deps.sendLetter).not.toHaveBeenCalled();
  });
  it('propose_room: участник чужой работы — 404, закрытый — 409, повтор и чужой lead — 400; карточки нет', async () => {
    const other = { ...MAP, work: { ...MAP.work, id: 'w-2', title: 'Other' }, sessions: [{ id: 's-07', label: 'S07 Zed', provider: 'claude', task: 'x', summary: null, lifecycle: 'active' }], rooms: [] } as unknown as WorkMap;
    deps.works = { snapshot: () => ({ entries: [{ projectPath: '/p', map: MAP }, { projectPath: '/q', map: other }] as WorkEntry[], branches: {} }) };
    const service = await started();
    expect((await service.tool('propose_room', { ...ROOM, members: ['S03', 'S07'] })).status).toBe(404);
    expect(await service.tool('propose_room', { ...ROOM, members: ['S03', 'S09'] })).toMatchObject({ status: 409, body: { error: 'S09 Old is closed' } });
    expect((await service.tool('propose_room', { ...ROOM, members: ['S03', 'S03'] })).status).toBe(400);
    expect((await service.tool('propose_room', { ...ROOM, lead: 'S09' })).status).toBe(400);
    expect((await service.tool('propose_room', { ...ROOM, members: ['S03'], lead: 'S02' })).status).toBe(400);
    expect((await service.tool('propose_room', { ...ROOM, title: ' ' })).status).toBe(400);
    expect((await service.tool('propose_room', { ...ROOM, task: 'я'.repeat(4001) })).status).toBe(400);
    expect((await service.tool('propose_room', { ...ROOM, work: 'Auth' })).status).toBe(404);
    expect(last().proposal).toBeNull();
  });
  it('propose_room: полный id сессии чужой работы с тем же s-03 — 404, карточки нет; свой полный id принимается', async () => {
    const service = await started();
    const overview = JSON.stringify((await service.tool('parley_overview', {})).body);
    const own = /session:[0-9a-f]{6}:w-1:s-03/.exec(overview)?.[0];
    expect(own).toBeDefined();
    const foreign = own!.replace(':w-1:', ':w-2:');
    const refused = await service.tool('propose_room', { ...ROOM, members: [foreign] });
    expect(refused).toMatchObject({ status: 404, body: { error: expect.stringContaining('No session') } });
    expect((refused.body as { error: string }).error).toContain('in work "Parley"');
    expect(last().proposal).toBeNull();
    expect((await service.tool('propose_room', { ...ROOM, members: [own!] })).status).toBe(200);
  });
  it('createRoom бросил — decide вернул ошибку, карточка на месте', async () => {
    deps.createRoom = vi.fn().mockRejectedValue(new Error('S02 is closed'));
    const service = await started();
    await service.tool('propose_room', ROOM);
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'S02 is closed' });
    expect(last().proposal?.id).toBe(id);
    expect(deps.sendLetter).not.toHaveBeenCalled();
  });
  it('комната создана, а задача не ушла — карточка закрыта (повтор создал бы вторую), ошибка в окно', async () => {
    deps.sendLetter = vi.fn().mockRejectedValue(new Error('inbox full'));
    const service = await started();
    await service.tool('propose_room', ROOM);
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'Room created, but the task was not sent: inbox full' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'done' });
  });
  it('propose_message в работу — 400', async () => {
    const service = await started();
    expect(await service.tool('propose_message', { target: 'Parley', text: 'x' })).toMatchObject({ status: 400 });
    expect(last().proposal).toBeNull();
  });

  it('propose_room_decision return с пояснением → карточка; send зовёт resolveRoomProposal, исход done', async () => {
    const service = await started();
    const reply = await service.tool('propose_room_decision', { target: 'Gate', choice: 'return', note: 'add tests' });
    expect(reply.status).toBe(200);
    expect(last().proposal).toMatchObject({ action: 'room-decision', target: 'Gate', text: 'Return Gate: Ship it', choice: 'return', note: 'add tests', proposal: { proposalId: 'p-01', rev: 2, kind: 'decision', from: 'S03 Ruslan', text: 'Ship it' } });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.resolveRoomProposal).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-2', proposalId: 'p-01', action: 'return', note: 'add tests', rev: 2 });
    expect(last()).toMatchObject({ proposal: null, outcome: 'done' });
  });
  it('решение со встроенным планом: карточка и decide несут planId и planRev плана', async () => {
    const room = (MAP as unknown as { rooms: Array<{ id: string; proposal: Record<string, unknown> }> }).rooms.find((candidate) => candidate.id === 'r-2')!;
    const original = room.proposal;
    room.proposal = { ...original, plan: { id: 'pl-01', roomId: 'r-2', rev: 4, mode: 'checklist', status: 'proposed', goal: 'New goal', items: [], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null } };
    try {
      const service = await started();
      await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept' });
      expect(last().proposal).toMatchObject({ action: 'room-decision', proposal: { planId: 'pl-01', planRev: 4 } });
      await service.decide(last().proposal!.id, 'send');
      expect(deps.resolveRoomProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'p-01', action: 'accept', rev: 2, planId: 'pl-01', planRev: 4 }));
    } finally {
      room.proposal = original;
    }
  });
  it('accept игнорирует note', async () => {
    const service = await started();
    await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept', note: 'неважно' });
    expect(last().proposal).toMatchObject({ choice: 'accept', note: null });
    await service.decide(last().proposal!.id, 'send');
    expect(deps.resolveRoomProposal).toHaveBeenCalledWith(expect.not.objectContaining({ note: expect.anything() }));
  });
  it('ведущий переделал решение (conflict) — исход cancelled, «look again», заметка про revised', async () => {
    deps.resolveRoomProposal = vi.fn().mockRejectedValue(new HostError('conflict', 'the proposal was revised'));
    const service = await started();
    await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'The lead revised the decision — look again' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'cancelled' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    expect(turns[1]?.spec.args.join(' ')).toContain('revised');
  });
  it('иная ошибка решения — карточка остаётся', async () => {
    deps.resolveRoomProposal = vi.fn().mockRejectedValue(new HostError('bad_request', 'nothing to resolve'));
    const service = await started();
    await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept' });
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'nothing to resolve' });
    expect(last().proposal?.id).toBe(id);
  });
  it('комната без слота — 409; не комната — 404; неверный choice — 400', async () => {
    const service = await started();
    expect(await service.tool('propose_room_decision', { target: 'Quiet', choice: 'accept' })).toMatchObject({ status: 409, body: { error: 'Quiet has no decision waiting' } });
    expect((await service.tool('propose_room_decision', { target: 'S03', choice: 'accept' })).status).toBe(404);
    expect((await service.tool('propose_room_decision', { target: 'Gate', choice: 'later' })).status).toBe(400);
  });
});

describe('assistant-service: решение по карточке агента', () => {
  const card = (cardId: string, command: string, suggestions: unknown[] = []) => ({ kind: 'permission', cardId, id: cardId, state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command }, suggestions, notified: false });
  let snapshots: Record<string, { items: unknown[]; decisions?: 'window' | 'terminal' }>;
  let snapshot: ReturnType<typeof vi.fn>;
  let decide: ReturnType<typeof vi.fn>;

  async function started(opts: { blocked?: string[] } = {}) {
    snapshot = vi.fn(async (ref: { sessionId: string }) => snapshots[ref.sessionId] ?? { items: [] });
    decide = vi.fn().mockResolvedValue({ applied: true, state: 'allowed' });
    // Ждущей считается только сессия, которую активность показывает как blocked.
    const blocked = opts.blocked ?? ['s-03'];
    const service = createAssistantService({
      ...deps,
      activity: { get: (ref) => ({ activity: { activity: blocked.includes(ref.sessionId) ? 'blocked' : 'working', waitingFor: null }, metrics: null }) as never },
      feed: { snapshot, decide } as never,
    });
    await service.ask(ASK);
    return service;
  }
  beforeEach(() => {
    snapshots = { 's-03': { items: [card('c1', 'rm -rf dist')] } };
  });

  it('parley_overview опрашивает ленту только у blocked-сессии и показывает ждущую карточку', async () => {
    const service = await started();
    const reply = await service.tool('parley_overview', {});
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', sessionId: 's-03' }, undefined, 'attention');
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('waits: permission — Bash: rm -rf dist') } });
  });
  it('parley_overview: сессия с need (лимит) — ждущая, причина с именем провайдера; детали — то же (итоговое ревью, находка 1)', async () => {
    const need = { kind: 'limit', since: '2026-10-22T10:00:00.000Z', detail: null, resetsAt: null, window: null, account: null };
    const service = createAssistantService({
      ...deps,
      activity: { get: (ref) => ({ activity: { activity: ref.sessionId === 's-03' ? 'unseen' : 'working', waitingFor: null, need: ref.sessionId === 's-03' ? need : null }, metrics: null }) as never },
      providers: async () => ({ claude: { ...CLAUDE, label: 'Claude Code 2' } }),
    });
    await service.ask(ASK);
    const overview = (await service.tool('parley_overview', {})).body as { text: string };
    expect(overview.text).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · limit — Hit its Claude Code usage limit; the reset time is unknown · /);
    expect(overview.text).not.toContain('done · unseen');
    const detail = (await service.tool('parley_detail', { target: 'S03' })).body as { text: string };
    expect(detail.text).toContain('claude · limit — Hit its Claude Code usage limit; the reset time is unknown');
  });
  it('parley_overview: сбой ленты — обзор без карточек, не ошибка', async () => {
    const service = await started();
    snapshot.mockRejectedValue(new Error('no feed'));
    const reply = await service.tool('parley_overview', {});
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).not.toContain('(card ');
  });
  it('propose_decision → карточка с summary и деталями; send зовёт feed.decide, исход done', async () => {
    const service = await started();
    const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    expect(reply.status).toBe(200);
    expect(last().proposal).toMatchObject({
      action: 'decision',
      target: 'S03 Ruslan',
      card: { cardId: 'c1', kind: 'permission', summary: 'Bash: rm -rf dist', detail: 'rm -rf dist' },
      decision: { kind: 'permission', behavior: 'allow' },
    });
    expect(last().proposal?.text).toContain('rm -rf dist');
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(decide).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', sessionId: 's-03' }, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'done' });
  });
  it('always без suggestions снимается, ответ модели говорит про разовое разрешение', async () => {
    const service = await started();
    const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow', always: true } });
    expect(JSON.stringify(reply.body)).toContain('one-time');
    expect(last().proposal).toMatchObject({ decision: { kind: 'permission', behavior: 'allow' } });
    expect((last().proposal as { decision: object }).decision).not.toHaveProperty('always');
  });
  it('always с suggestions остаётся', async () => {
    snapshots['s-03'] = { items: [card('c1', 'ls', [{ type: 'addRules' }])] };
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow', always: true } });
    expect(last().proposal).toMatchObject({ decision: { kind: 'permission', behavior: 'allow', always: true } });
  });
  it('две ждущие карточки — 409 со списком cardId — summary; с card выбирается нужная', async () => {
    snapshots['s-03'] = { items: [card('c1', 'rm -rf dist'), card('c2', 'git push')] };
    const service = await started();
    const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    expect(reply.status).toBe(409);
    expect(JSON.stringify(reply.body)).toContain('c1 — Bash: rm -rf dist');
    expect(JSON.stringify(reply.body)).toContain('c2 — Bash: git push');
    expect(last().proposal).toBeNull();
    const picked = await service.tool('propose_decision', { target: 'S03', card: 'c2', decision: { kind: 'permission', behavior: 'deny' } });
    expect(picked.status).toBe(200);
    expect(last().proposal).toMatchObject({ card: { cardId: 'c2' } });
  });
  it('нет ждущей карточки нужного вида — 409', async () => {
    const service = await started();
    const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'plan', choice: 'manual' } });
    expect(reply).toMatchObject({ status: 409, body: { error: 'S03 Ruslan is not waiting for a plan' } });
  });
  it('decisions: terminal — 409 «answers at your Mac only»', async () => {
    snapshots['s-03'] = { items: [card('c1', 'ls')], decisions: 'terminal' };
    const service = await started();
    const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    expect(reply).toMatchObject({ status: 409, body: { error: 'S03 Ruslan answers at your Mac only' } });
  });
  it('неверное решение — 400; комната вместо сессии — 404', async () => {
    const service = await started();
    expect((await service.tool('propose_decision', { target: 'S03', decision: { kind: 'plan', choice: 'edit' } })).status).toBe(400);
    expect((await service.tool('propose_decision', { target: 'Auth', decision: { kind: 'permission', behavior: 'allow' } })).status).toBe(404);
  });
  it('Review Focus 1: feed.decide вернул applied: false — исход cancelled, «Already answered», заметка модели', async () => {
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    decide.mockResolvedValue({ applied: false, state: 'allowed' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'Already answered' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'cancelled' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    expect(turns[1]?.spec.args.join(' ')).toContain('already answered');
  });
  it('feed.decide бросил — карточка остаётся, ошибка в окно', async () => {
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    decide.mockRejectedValue(new Error('boom'));
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: false, error: 'boom' });
    expect(last().proposal).not.toBeNull();
  });
  it('текст карточки решения начинается с глагола: Allow / Deny / Accept plan / Approve each edit', async () => {
    snapshots['s-03'] = { items: [card('c1', 'ls'), { kind: 'plan', cardId: 'pl', id: 'pl', state: 'pending', plan: 'step 1\nstep 2' }] };
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    expect(last().proposal?.text).toMatch(/^Allow S03 Ruslan: Bash: ls/);
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'deny' } });
    expect(last().proposal?.text).toMatch(/^Deny S03 Ruslan: /);
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'plan', choice: 'auto-accept' } });
    expect(last().proposal?.text).toMatch(/^Accept plan S03 Ruslan: Plan/);
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'plan', choice: 'manual' } });
    expect(last().proposal?.text).toMatch(/^Approve each edit S03 Ruslan: Plan/);
  });
  describe('вопросы агента', () => {
    const question = (cardId: string, questions: Array<{ question: string; options: string[]; multiSelect?: boolean }>) => ({
      kind: 'question', cardId, id: cardId, state: 'pending', toolUseId: null,
      questions: questions.map((item) => ({ question: item.question, header: null, multiSelect: item.multiSelect ?? false, options: item.options.map((label) => ({ label, description: null })) })),
    });
    const ONE = question('q1', [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }]);
    const TWO = question('q2', [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }, { question: 'Which tags?', options: ['a', 'b', 'c'], multiSelect: true }]);

    it('номер вопроса переводится в его текст; ответ по метке без учёта регистра берётся в её написании; текст карточки показывает ответ', async () => {
      snapshots['s-03'] = { items: [ONE] };
      const service = await started();
      const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { Q1: 'sqlite' } } });
      expect(reply.status).toBe(200);
      expect(last().proposal).toMatchObject({ decision: { kind: 'question', answers: { 'Which DB?': 'SQLite' } } });
      expect(last().proposal?.text).toMatch(/^Answer S03 Ruslan: Question: Which DB\?/);
      expect(last().proposal?.text).toMatch(/\nA: SQLite$/);
    });
    it('несколько вопросов: ключ — номер или точный текст, multiSelect нормализуется по частям, строки A1/A2', async () => {
      snapshots['s-03'] = { items: [TWO] };
      const service = await started();
      const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { '1': 'Postgres', 'Which tags?': 'B, a' } } });
      expect(reply.status).toBe(200);
      expect(last().proposal).toMatchObject({ decision: { kind: 'question', answers: { 'Which DB?': 'Postgres', 'Which tags?': 'b, a' } } });
      expect(last().proposal?.text).toMatch(/\nA1: Postgres\nA2: b, a$/);
    });
    it('чужой ключ — 400, в сообщении вопросы и варианты; карточки нет', async () => {
      snapshots['s-03'] = { items: [ONE] };
      const service = await started();
      const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { 'Какая база?': 'Postgres' } } });
      expect(reply.status).toBe(400);
      expect(JSON.stringify(reply.body)).toContain('1. \\"Which DB?\\" — options: Postgres | SQLite (free text allowed)');
      expect(last().proposal).toBeNull();
    });
    it('два вопроса, ответ только на один — 400', async () => {
      snapshots['s-03'] = { items: [TWO] };
      const service = await started();
      const reply = await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { '1': 'Postgres' } } });
      expect(reply.status).toBe(400);
      expect(JSON.stringify(reply.body)).toContain('2. \\"Which tags?\\"');
      expect((await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { '1': 'Postgres', '2': '  ' } } })).status).toBe(400);
    });
    it('свободный текст остаётся как есть', async () => {
      snapshots['s-03'] = { items: [ONE] };
      const service = await started();
      await service.tool('propose_decision', { target: 'S03', decision: { kind: 'question', answers: { '1': 'MySQL, пожалуй' } } });
      expect(last().proposal).toMatchObject({ decision: { answers: { 'Which DB?': 'MySQL, пожалуй' } } });
    });
    it('parley_detail сессии показывает ждущую карточку с вариантами', async () => {
      snapshots['s-03'] = { items: [TWO] };
      const service = await started();
      const reply = await service.tool('parley_detail', { target: 'S03' });
      const text = (reply.body as { text: string }).text;
      expect(text).toContain('Waiting:');
      expect(text).toContain('(card q2)');
      expect(text).toContain('Q1: Which DB?');
      expect(text).toContain('- SQLite');
      expect(text).toContain('Q2: Which tags?');
    });
  });
  it('feed.decide: хук ещё не удержан (state pending) — карточка остаётся, текст «not ready»', async () => {
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    decide.mockResolvedValue({ applied: false, state: 'pending' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: false, error: 'The agent is not ready for the answer yet — try again' });
    expect(last().proposal).not.toBeNull();
    decide.mockResolvedValue({ applied: true, state: 'allowed' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
  });
  it('feed.decide: карточка устарела (state stale) — исход cancelled, «Expired»', async () => {
    const service = await started();
    await service.tool('propose_decision', { target: 'S03', decision: { kind: 'permission', behavior: 'allow' } });
    decide.mockResolvedValue({ applied: false, state: 'stale' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'Expired — the request is no longer open' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'cancelled' });
  });
  it('detail инструмента propose_decision — propose', async () => {
    const service = await started();
    turns[0]?.emit({ type: 'tool', name: 'propose_decision', input: {} });
    expect(last()).toMatchObject({ phase: 'tool', detail: { tool: 'propose', target: null } });
    void service;
  });
});

describe('assistant-service: напоминания', () => {
  const REMINDER: Reminder = { id: 'r1', what: 'check the release room', at: '2026-10-19T12:00:00.000Z', every: null, createdAt: '2026-10-19T11:55:00.000Z', askedAt: '2026-10-19T11:55:00.000Z' };
  const clock = (at: number): string => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

  it('schedule_check → ответ «Scheduled r1 for HH:mm (in 5 minutes)»', async () => {
    const at = Date.UTC(2026, 9, 19, 12, 0, 0);
    const add = vi.fn().mockReturnValue({ ...REMINDER, at: new Date(at + 5 * 60_000).toISOString() });
    const service = createAssistantService({ ...deps, now: () => at, reminders: { ...deps.reminders, add } });
    await service.ask(ASK);
    const reply = await service.tool('schedule_check', { in_minutes: 5, what: 'check the release room' });
    expect(add).toHaveBeenCalledWith({ what: 'check the release room', inMinutes: 5, now: at });
    expect(reply).toEqual({ status: 200, body: { text: `Scheduled r1 for ${clock(at + 5 * 60_000)} (in 5 minutes)` } });
  });
  it('schedule_check меньше минуты — «in less than a minute»', async () => {
    const at = Date.UTC(2026, 9, 19, 12, 0, 0);
    const add = vi.fn().mockReturnValue({ ...REMINDER, at: new Date(at + 20_000).toISOString() });
    const service = createAssistantService({ ...deps, now: () => at, reminders: { ...deps.reminders, add } });
    await service.ask(ASK);
    const reply = await service.tool('schedule_check', { in_minutes: 1, what: 'x' });
    expect(reply).toEqual({ status: 200, body: { text: `Scheduled r1 for ${clock(at + 20_000)} (in less than a minute)` } });
  });
  it('list_reminders: напоминание не сегодня — после времени «tomorrow»', async () => {
    const now = new Date(2026, 9, 19, 23, 30).getTime();
    const later = new Date(2026, 9, 20, 7, 0).getTime();
    const list = vi.fn().mockReturnValue([{ ...REMINDER, at: new Date(later).toISOString() }]);
    const service = createAssistantService({ ...deps, now: () => now, reminders: { ...deps.reminders, list } });
    await service.ask(ASK);
    expect(await service.tool('list_reminders', {})).toEqual({ status: 200, body: { text: `r1 — ${clock(later)} tomorrow — check the release room` } });
  });
  it('schedule_check: ошибка хранилища — 400 с текстом', async () => {
    const service = createAssistantService({ ...deps, reminders: { ...deps.reminders, add: vi.fn().mockReturnValue({ error: 'Too many reminders (10 at most)' }) } });
    await service.ask(ASK);
    expect(await service.tool('schedule_check', { in_minutes: 5, what: 'x' })).toEqual({ status: 400, body: { error: 'Too many reminders (10 at most)' } });
    expect((await service.tool('schedule_check', { in_minutes: '5', what: 'x' })).status).toBe(400);
  });
  it('list_reminders и cancel_reminder', async () => {
    const list = vi.fn().mockReturnValue([{ ...REMINDER, every: 10 }, { ...REMINDER, id: 'r2', what: 'once' }]);
    const cancel = vi.fn().mockReturnValue(2);
    const service = createAssistantService({ ...deps, now: () => Date.parse(REMINDER.at), reminders: { ...deps.reminders, list, cancel } });
    await service.ask(ASK);
    const time = clock(Date.parse(REMINDER.at));
    expect(await service.tool('list_reminders', {})).toEqual({ status: 200, body: { text: `r1 — ${time} — every 10 min — check the release room\nr2 — ${time} — once` } });
    expect(await service.tool('cancel_reminder', { id: '*' })).toEqual({ status: 200, body: { text: 'Cancelled 2 reminder(s)' } });
    expect(cancel).toHaveBeenCalledWith('*');
    list.mockReturnValue([]);
    expect(await service.tool('list_reminders', {})).toEqual({ status: 200, body: { text: 'No reminders scheduled' } });
  });
  it('срабатывание во время хода ждёт его конца, потом ход с origin reminder; вопрос человека — снова island', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(last().origin).toBe('island');
    let result: string | null = null;
    const firing = service.onReminder(REMINDER, false).then((value) => { result = value; });
    await flush();
    await flush();
    expect(turns).toHaveLength(1);
    expect(result).toBeNull();
    turns[0]?.end({ ok: true });
    await firing;
    expect(result).toBe('fired');
    expect(turns).toHaveLength(2);
    expect(turns[1]?.spec.args[1]).toBe('[reminder r1, asked at 2026-10-19T11:55:00.000Z] Check: check the release room');
    expect(last()).toMatchObject({ phase: 'thinking', origin: 'reminder' });
    turns[1]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'ещё' });
    expect(last()).toMatchObject({ phase: 'thinking', origin: 'island' });
  });
  it('поздний и последний вызовы помечены в тексте; без вопросов человека язык en', async () => {
    const service = createAssistantService({ ...deps, now: () => Date.parse('2026-10-19T12:00:00.000Z') });
    const last24: Reminder = { ...REMINDER, every: 600, at: '2026-10-20T10:00:00.000Z', createdAt: '2026-10-19T11:55:00.000Z' };
    expect(await service.onReminder(last24, true)).toBe('fired');
    expect(turns[0]?.spec.args[1]).toBe('[reminder r1, asked at 2026-10-19T11:55:00.000Z, late, last check] Check: check the release room');
  });
  it('нет готового провайдера — skipped, хода нет', async () => {
    const service = createAssistantService({ ...deps, ready: async () => 'Claude CLI is not installed' });
    expect(await service.onReminder(REMINDER, false)).toBe('skipped');
    expect(turns).toHaveLength(0);
  });
});

describe('assistant-service: ревью — карточка и напоминания', () => {
  const ROOM = { work: 'Parley', title: 'Auth rework', members: ['S03', 'S02'], task: 'Разберите вход' };
  const started = async (override: Partial<AssistantServiceDeps> = {}) => {
    const service = createAssistantService({ ...deps, ...override });
    await service.ask(ASK);
    return service;
  };
  const REMINDER: Reminder = { id: 'r1', what: 'check', at: '2026-10-19T12:00:00.000Z', every: null, createdAt: '2026-10-19T11:55:00.000Z', askedAt: '2026-10-19T11:55:00.000Z' };

  it('два decide подряд: действие один раз, второй получает «no longer current»', async () => {
    let release: (value: string) => void = () => {};
    deps.createRoom = vi.fn().mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    const service = await started();
    await service.tool('propose_room', ROOM);
    const id = last().proposal!.id;
    const first = service.decide(id, 'send');
    const second = await service.decide(id, 'send');
    expect(second).toEqual({ applied: false, error: 'This card is no longer current' });
    release('r-9');
    await expect(first).resolves.toMatchObject({ applied: true });
    expect(deps.createRoom).toHaveBeenCalledTimes(1);
  });
  it('карточка, предложенная пока createRoom ждёт, переживает settle', async () => {
    let release: (value: string) => void = () => {};
    deps.createRoom = vi.fn().mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    const service = await started();
    await service.tool('propose_room', ROOM);
    const deciding = service.decide(last().proposal!.id, 'send');
    await service.tool('propose_message', { target: 'Auth', text: 'новая' });
    expect(last().proposal?.id).toBe('p2');
    release('r-9');
    await deciding;
    expect(last().proposal?.id).toBe('p2');
    await expect(service.decide('p2', 'cancel')).resolves.toMatchObject({ applied: true });
  });
  it('не вышло — карточка возвращается и её можно решить снова', async () => {
    deps.createRoom = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('r-9');
    const service = await started();
    await service.tool('propose_room', ROOM);
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'boom' });
    await expect(service.decide(id, 'send')).resolves.toMatchObject({ applied: true });
  });
  it('reset во время decide: заметка о карточке не попадает в следующий вопрос', async () => {
    let release: (value: string) => void = () => {};
    deps.createRoom = vi.fn().mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    const service = await started();
    await service.tool('propose_room', ROOM);
    const deciding = service.decide(last().proposal!.id, 'send');
    service.reset();
    release('r-9');
    await deciding;
    await service.ask({ ...ASK, text: 'после сброса' });
    expect(turns.at(-1)?.spec.args.join(' ')).not.toContain('[system: proposal');
  });
  it('conflict: решение уже принято в другом месте — «Already answered»; переделано — «revised»', async () => {
    deps.resolveRoomProposal = vi.fn().mockRejectedValue(new HostError('conflict', 'stale'));
    const answered = { ...MAP, rooms: MAP.rooms.map((room) => (room.id === 'r-2' ? { ...room, proposal: null } : room)) } as unknown as WorkMap;
    let map: WorkMap = MAP;
    const service = await started({ works: { snapshot: () => ({ entries: [{ projectPath: '/p', map }] as WorkEntry[], branches: {} }) } });
    await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept' });
    map = answered;
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'Already answered' });
    map = MAP;
    await service.tool('propose_room_decision', { target: 'Gate', choice: 'accept' });
    await expect(service.decide(last().proposal!.id, 'send')).resolves.toEqual({ applied: true, error: 'The lead revised the decision — look again' });
  });
  it('stop, пока напоминание ждёт ход, — «later», нового хода нет', async () => {
    const service = await started();
    let result: string | null = null;
    const firing = service.onReminder(REMINDER, false).then((value) => { result = value; });
    await flush();
    expect(result).toBeNull();
    service.stop();
    await firing;
    expect(result).toBe('later');
    expect(turns).toHaveLength(1);
  });
  it('хоста ещё нет (endpoint.origin() === null) — напоминание retry: не fired и не потеряно', async () => {
    const service = createAssistantService({ ...deps, endpoint: { origin: () => null, setToken: () => {} } });
    expect(await service.onReminder(REMINDER, false)).toBe('retry');
    expect(turns).toHaveLength(0);
  });
  it('человек спросил, пока запускался ход по напоминанию, — retry, хода по напоминанию нет', async () => {
    let release: (() => void) | null = null;
    let first = true;
    const service = createAssistantService({
      ...deps,
      launchEnv: () => {
        if (!first) return Promise.resolve({});
        first = false;
        return new Promise((resolve) => { release = () => resolve({}); });
      },
    });
    let result: string | null = null;
    const firing = service.onReminder(REMINDER, false).then((value) => { result = value; });
    await vi.waitFor(() => expect(release).not.toBeNull());
    await service.ask(ASK);
    release!();
    await firing;
    expect(result).toBe('retry');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.spec.args[1]).toBe(ASK.text);
  });
  it('stop(), пока ход ещё запускается (launchEnv в пути), — процесс не стартует', async () => {
    let release: (() => void) | null = null;
    const service = createAssistantService({ ...deps, launchEnv: () => new Promise((resolve) => { release = () => resolve({}); }) });
    const asking = service.ask(ASK);
    await vi.waitFor(() => expect(release).not.toBeNull());
    service.stop();
    release!();
    await asking;
    expect(turns).toHaveLength(0);
  });
  it('провайдер сменился вопросом человека, пока напоминание ждало, — ход по новому', async () => {
    const GLM = { ...CLAUDE, id: 'glm', label: 'GLM' } as unknown as ProviderEntry;
    const service = createAssistantService({
      ...deps,
      providers: async () => ({ claude: CLAUDE, glm: GLM }),
      launchEnv: async (entry) => ({ WHO: entry.id }),
    });
    await service.ask({ ...ASK, provider: 'claude' });
    let result: string | null = null;
    const firing = service.onReminder(REMINDER, false).then((value) => { result = value; });
    await flush();
    await service.ask({ ...ASK, text: 'теперь glm', provider: 'glm' });
    turns[1]?.end({ ok: true });
    await firing;
    expect(result).toBe('fired');
    expect(turns.at(-1)?.spec.env['WHO']).toBe('glm');
    expect(turns.at(-1)?.spec.args[1]).toContain('[reminder r1');
  });
});

describe('assistant-service: зеркало настроек, слушатели и telegram', () => {
  const REMINDER: Reminder = { id: 'r1', what: 'check the release room', at: '2026-10-19T12:00:00.000Z', every: 10, createdAt: '2026-10-19T11:55:00.000Z', askedAt: '2026-10-19T11:55:00.000Z' };
  const MIRROR = { enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: null };

  it('onState получает каждое publish; отписка работает', async () => {
    const service = createAssistantService(deps);
    const seen: AssistantState[] = [];
    const off = service.onState((value) => { seen.push(value); });
    await service.ask(ASK);
    expect(seen.length).toBe(states.length);
    expect(seen.at(-1)).toBe(last());
    off();
    const before = seen.length;
    service.reset();
    expect(seen).toHaveLength(before);
  });

  it('configure и settings: до configure — null, после — то, что передали', () => {
    const service = createAssistantService(deps);
    expect(service.settings()).toBeNull();
    service.configure(MIRROR);
    expect(service.settings()).toEqual(MIRROR);
  });

  it('ask(params, telegram) публикует origin telegram; без origin — island', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK, 'telegram');
    expect(last().origin).toBe('telegram');
    await service.ask(ASK);
    expect(last().origin).toBe('island');
  });

  it('напоминание при выключенном помощнике: onReminderWhileOff один раз на id, результат skipped, хода нет', async () => {
    const off = vi.fn();
    const service = createAssistantService({ ...deps, onReminderWhileOff: off });
    service.configure({ ...MIRROR, enabled: false });
    expect(await service.onReminder(REMINDER, false)).toBe('skipped');
    expect(await service.onReminder(REMINDER, false)).toBe('skipped');
    expect(off).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledWith(REMINDER);
    expect(await service.onReminder({ ...REMINDER, id: 'r2' }, false)).toBe('skipped');
    expect(off).toHaveBeenCalledTimes(2);
    expect(turns).toHaveLength(0);
  });

  it('напоминание с зеркалом enabled берёт провайдера, модель и язык из зеркала, а не из последнего вопроса', async () => {
    const GLM = { ...CLAUDE, id: 'glm', label: 'GLM' } as unknown as ProviderEntry;
    const service = createAssistantService({ ...deps, providers: async () => ({ claude: CLAUDE, glm: GLM }), launchEnv: async (entry) => ({ WHO: entry.id }) });
    await service.ask({ ...ASK, provider: 'glm' });
    turns[0]?.end({ ok: true });
    await flush();
    service.configure({ ...MIRROR, provider: 'claude', model: 'opus' });
    expect(await service.onReminder(REMINDER, false)).toBe('fired');
    expect(turns.at(-1)?.spec.env['WHO']).toBe('claude');
    expect(turns.at(-1)?.spec.args[1]).toContain('[reminder r1');
  });
});
