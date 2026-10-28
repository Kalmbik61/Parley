import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { closeWorkDb, createWork, WorkNotFoundError, writeLetters } from '@parley/core';
import type { AssistantStreamEvent, ProviderEntry, WorkEntry, WorkMap } from '@parley/core';
import type { AssistantState } from '@parley/protocol';
import { HostError } from '../errors.js';
import { createAssistantService, type AssistantServiceDeps } from './assistant-service.js';
import type { Reminder } from './reminders.js';
import type { TurnEnd, TurnSpec } from './turn.js';

interface FakeTurn { spec: TurnSpec; emit(event: AssistantStreamEvent): void; end(result: TurnEnd): void; cancelled: boolean }

const CLAUDE = { id: 'claude', label: 'Claude', runner: { command: 'claude', mcpConfig: 'json-file', assistantArgs: ['-p', '{prompt}'], assistantResumeArgs: ['-p', '{prompt}', '--resume', '{providerSessionId}'] } } as unknown as ProviderEntry;
const CODEX = { id: 'codex', label: 'Codex', runner: { command: 'codex', mcpConfig: 'codex-override', assistantArgs: ['exec', '{prompt}'] } } as unknown as ProviderEntry;
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
    createWork: vi.fn().mockResolvedValue('w-2'),
    createSession: vi.fn().mockResolvedValue({ projectPath: '/p', workId: 'w-1', sessionId: 's-10' }),
    resume: vi.fn().mockResolvedValue('started'),
    interrupt: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    addRoomMember: vi.fn().mockResolvedValue('m-3'),
    roles: async () => [],
    leanAgents: async () => true,
    providerReady: async () => null,
    actionsShown: () => true,
    endpoint: { origin: () => 'http://127.0.0.1:9', setToken: (value) => { token = value; } },
    providers: async () => ({ claude: CLAUDE, codex: CODEX }),
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

describe('assistant-service: эмоции по предложениям (F3)', () => {
  /** Строка Claude прогоняется через `parse` хода, как у настоящего процесса: так видны и начала блоков. */
  const line = (turn: FakeTurn | undefined, value: unknown): void => {
    for (const event of turn?.spec.parse(JSON.stringify(value)) ?? []) turn?.emit(event);
  };
  const blockStart = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

  it('в answer нет меток, moods — на позициях предложений, mood — первая метка; метка, разрезанная между дельтами, срезана', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'text', delta: '[[joy]] Готово. [[s' });
    turns[0]?.emit({ type: 'text', delta: 'ad]] Но S03 упал. [[calm]] Смотрю.' });
    expect(last()).toMatchObject({ phase: 'answering', mood: 'joy', answer: 'Готово. Но S03 упал. Смотрю.' });
    expect(last().moods).toEqual([{ at: 0, mood: 'joy' }, { at: 8, mood: 'sad' }, { at: 21, mood: 'calm' }]);
    expect(states.some((state) => state.answer.includes('[['))).toBe(false);
  });

  it('первая фраза без метки — mood calm, метки следующих фраз всё равно в moods', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'text', delta: 'Готово. [[sad]] Но S03 упал.' });
    expect(last()).toMatchObject({ mood: 'calm', answer: 'Готово. Но S03 упал.', moods: [{ at: 8, mood: 'sad' }] });
  });

  it('инструмент сбрасывает answer и moods; эмоцию решает текст после него', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'text', delta: '[[sad]] Сейчас посмотрю.' });
    turns[0]?.emit({ type: 'tool', name: 'parley_overview', input: {} });
    expect(last()).toMatchObject({ phase: 'tool', answer: '', moods: [] });
    turns[0]?.emit({ type: 'text', delta: '[[joy]] Все работают.' });
    expect(last()).toMatchObject({ mood: 'joy', answer: 'Все работают.', moods: [{ at: 0, mood: 'joy' }] });
  });

  it('новый ход начинается с пустых moods', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'text', delta: '[[joy]] Да.' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'а ещё?' });
    expect(last()).toMatchObject({ phase: 'thinking', answer: '', moods: [] });
  });

  it('конец хода: недописанная метка уходит текстом', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'text', delta: '[[calm]] Готово. [[jo' });
    expect(last().answer).toBe('Готово. ');
    turns[0]?.end({ ok: true });
    await flush();
    expect(last()).toMatchObject({ phase: 'idle', answer: 'Готово. [[jo', moods: [{ at: 0, mood: 'calm' }] });
  });

  it('новый блок текста без пробела на стыке — хост вставляет один пробел, метка на месте', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    line(turns[0], blockStart);
    line(turns[0], delta('[[calm]] Сейчас посмо'));
    line(turns[0], delta('трю.'));
    line(turns[0], blockStart);
    line(turns[0], delta('[[calm]] В работе'));
    expect(last().answer).toBe('Сейчас посмотрю. В работе');
    expect(last().moods).toEqual([{ at: 0, mood: 'calm' }, { at: 'Сейчас посмотрю. '.length, mood: 'calm' }]);
  });

  it('новый блок уже начинается с пробела — второго пробела нет', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    line(turns[0], blockStart);
    line(turns[0], delta('[[calm]] Сейчас посмотрю.'));
    line(turns[0], blockStart);
    line(turns[0], delta(' [[joy]] В работе'));
    expect(last().answer).toBe('Сейчас посмотрю. В работе');
    expect(last().moods).toEqual([{ at: 0, mood: 'calm' }, { at: 'Сейчас посмотрю. '.length, mood: 'joy' }]);
  });

  it('Codex: каждое сообщение — новый блок, стык получает пробел', async () => {
    const CODEX = { id: 'codex', label: 'Codex', runner: { command: 'codex', mcpConfig: 'codex-override', assistantArgs: ['exec', '{prompt}'] } } as unknown as ProviderEntry;
    const service = createAssistantService({ ...deps, providers: async () => ({ codex: CODEX }) });
    await service.ask(ASK);
    const message = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
    line(turns[0], message('[[calm]] Сейчас посмотрю.'));
    line(turns[0], message('[[joy]] В работе.'));
    expect(last()).toMatchObject({ mood: 'calm', answer: 'Сейчас посмотрю. В работе.', moods: [{ at: 0, mood: 'calm' }, { at: 17, mood: 'joy' }] });
  });
});

describe('assistant-service: род голоса (G1)', () => {
  const MIRROR = { enabled: true, provider: 'claude', model: null, language: 'ru', voiceModel: null };
  /** Провайдер с системным промптом в аргументах: так виден род, который ушёл модели. */
  const PROMPTED = {
    ...CLAUDE,
    runner: { ...CLAUDE.runner, assistantArgs: ['-p', '{prompt}', '--system-prompt', '{systemPrompt}'], assistantResumeArgs: ['-p', '{prompt}', '--resume', '{providerSessionId}', '--system-prompt', '{systemPrompt}'] },
  } as unknown as ProviderEntry;
  const prompted = () => createAssistantService({ ...deps, providers: async () => ({ claude: PROMPTED }) });
  const systemPrompt = (index: number): string => turns[index]?.spec.args.at(-1) ?? '';
  async function answered(service: ReturnType<typeof createAssistantService>, index: number): Promise<void> {
    turns[index]?.emit({ type: 'session', id: 'sid-1' });
    turns[index]?.end({ ok: true });
    await flush();
  }

  it('без voiceGender в зеркале (и без зеркала) — род female', async () => {
    const service = prompted();
    await service.ask(ASK);
    expect(systemPrompt(0)).toContain('You speak as a female assistant');
    await answered(service, 0);
    service.configure(MIRROR);
    await service.ask({ ...ASK, text: 'дальше' });
    expect(systemPrompt(1)).toContain('You speak as a female assistant');
    expect(turns[1]?.spec.args[1]).toBe('дальше');
  });

  it('род из зеркала уходит в промпт', async () => {
    const service = prompted();
    service.configure({ ...MIRROR, voiceGender: 'neutral' });
    await service.ask(ASK);
    expect(systemPrompt(0)).toContain('Your voice has no grammatical gender');
  });

  it('смена рода в живом разговоре — следующий ход любого происхождения получает строку, разговор тот же', async () => {
    const service = prompted();
    service.configure({ ...MIRROR, voiceGender: 'female' });
    await service.ask(ASK);
    await answered(service, 0);
    service.configure({ ...MIRROR, voiceGender: 'male' });
    await service.ask({ ...ASK, text: 'что нового?' }, 'telegram');
    expect(turns[1]?.spec.args.slice(0, 4)).toEqual(['-p', '[system: voice changed — speak as male]\nчто нового?', '--resume', 'sid-1']);
    expect(systemPrompt(1)).toContain('You speak as a male assistant');
    await answered(service, 1);
    await service.ask({ ...ASK, text: 'а сейчас?' });
    expect(turns[2]?.spec.args[1]).toBe('а сейчас?');
  });

  it('вопрос из Telegram при male в зеркале не переключает род и не даёт лишней строки', async () => {
    const service = prompted();
    service.configure({ ...MIRROR, voiceGender: 'male' });
    await service.ask(ASK);
    await answered(service, 0);
    service.configure({ ...MIRROR, voiceGender: 'male' });
    await service.ask({ ...ASK, text: 'что нового?' }, 'telegram');
    expect(turns[1]?.spec.args[1]).toBe('что нового?');
    expect(systemPrompt(1)).toContain('You speak as a male assistant');
  });

  it('смена рода без живого разговора — строки нет: новый разговор начнётся с нового рода', async () => {
    const service = prompted();
    await service.ask(ASK);
    await answered(service, 0);
    service.reset();
    service.configure({ ...MIRROR, voiceGender: 'male' });
    await service.ask({ ...ASK, text: 'привет' });
    expect(turns[1]?.spec.args[1]).toBe('привет');
    expect(systemPrompt(1)).toContain('You speak as a male assistant');
  });

  it('строка рода и заметка о карточке идут вместе', async () => {
    const service = prompted();
    await service.ask(ASK);
    await service.tool('propose_message', { target: 'Auth', text: 'Пропусти Safari' });
    await answered(service, 0);
    await service.decide(last().proposal!.id, 'cancel');
    service.configure({ ...MIRROR, voiceGender: 'male' });
    await service.ask({ ...ASK, text: 'ладно' });
    expect(turns[1]?.spec.args[1]).toBe('[system: voice changed — speak as male]\n[system: proposal p1 was cancelled]\nладно');
  });
});

describe('assistant-service: письма комнаты из базы работы', () => {
  // Спека хранилища 6.2: последние письма `parley_detail` берутся из базы, а не из снимка хоста.
  it('parley_detail комнаты показывает последние десять писем из базы, а не из снимка', async () => {
    const project = path.join(home, 'project');
    await mkdir(project);
    await mkdir(path.join(home, 'store'));
    const previous = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = path.join(home, 'store');
    try {
      const workId = (await createWork(project, { title: 'Parley' })).work.id;
      writeLetters(project, workId, (letters) => {
        for (let n = 1; n <= 12; n += 1) letters.add({ roomId: 'r-1', from: 's-03', to: [], text: `письмо ${n}`, kind: 'note' });
      });
      const map = { ...MAP, work: { ...MAP.work, id: workId } } as unknown as WorkMap;
      const service = createAssistantService({ ...deps, works: { snapshot: () => ({ entries: [{ projectPath: project, map }] as WorkEntry[], branches: {} }) } });
      await service.ask(ASK);
      const reply = await service.tool('parley_detail', { target: 'Auth' });
      const shown = (reply.body as { text: string }).text.split('\n').filter((line) => line.includes('(note):'));
      expect(shown).toHaveLength(10);
      expect(shown[0]).toContain('письмо 3');
      expect(shown.at(-1)).toContain('письмо 12');
    } finally {
      if (previous === undefined) delete process.env['PARLEY_HOME'];
      else process.env['PARLEY_HOME'] = previous;
    }
  });

  it('parley_detail комнаты работы, которой уже нет в базе, — ответ без хвоста писем, не сбой', async () => {
    // В снимке хоста работа есть (`MAP`), в базе её нет: чтение хвоста бросает `WorkNotFoundError`, и хвоста просто нет.
    const service = createAssistantService(deps);
    await service.ask(ASK);

    const reply = await service.tool('parley_detail', { target: 'Auth' });

    expect(reply.status).toBe(200);
    const { text } = reply.body as { text: string };
    expect(text).toContain('Room "Auth"');
    expect(text).not.toContain('Last messages:');
  });

  it('сбой чтения хвоста, не связанный с пропавшей работой, идёт наружу', async () => {
    const previous = process.env['PARLEY_HOME'];
    const service = createAssistantService(deps);
    await service.ask(ASK);
    // Дом — путь внутри обычного файла: базу не открыть, и это не `WorkNotFoundError`.
    const blocker = path.join(home, 'blocker');
    await writeFile(blocker, 'файл на месте каталога');
    closeWorkDb();
    process.env['PARLEY_HOME'] = path.join(blocker, 'home');
    try {
      const thrown = await service.tool('parley_detail', { target: 'Auth' }).then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(WorkNotFoundError);
    } finally {
      if (previous === undefined) delete process.env['PARLEY_HOME'];
      else process.env['PARLEY_HOME'] = previous;
      closeWorkDb();
    }
  });
});

describe('assistant-service: чтение', () => {
  // Закрытая сессия `s-09` из MAP: в обзоре её нет, id строится как у targetsOf — по хешу пути проекта.
  const closedId = `session:${createHash('sha1').update('/p').digest('hex').slice(0, 6)}:w-1:s-09`;
  const feed = (items: unknown[]): AssistantServiceDeps['feed'] => ({ snapshot: vi.fn(async () => ({ items })), decide: vi.fn() }) as never;

  it('parley_find: пустой запрос — 400, имя проекта — работа', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(await service.tool('parley_find', { query: '  ' })).toEqual({ status: 400, body: { error: 'query is empty' } });
    expect(await service.tool('parley_find', { query: 'Parley' })).toMatchObject({ status: 200, body: { text: expect.stringContaining('Work "Parley"') } });
  });
  it('parley_find: закрытая сессия находится только с include_closed', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const plain = await service.tool('parley_find', { query: 'Old' });
    expect((plain.body as { text: string }).text).toBe('Nothing found for "Old".');
    expect(await service.tool('parley_find', { query: 'Old', include_closed: true })).toMatchObject({ status: 200, body: { text: expect.stringContaining('S09 Old') } });
  });
  it('parley_room читает письма из базы работы целиком', async () => {
    const project = path.join(home, 'project');
    await mkdir(project);
    await mkdir(path.join(home, 'store'));
    const previous = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = path.join(home, 'store');
    try {
      const workId = (await createWork(project, { title: 'Parley' })).work.id;
      writeLetters(project, workId, (letters) => {
        letters.add({ roomId: 'r-1', from: 's-03', to: [], text: 'короткое письмо', kind: 'note' });
        letters.add({ roomId: 'r-1', from: 's-03', to: [], text: 'д'.repeat(4500), kind: 'note' });
      });
      const map = { ...MAP, work: { ...MAP.work, id: workId } } as unknown as WorkMap;
      const service = createAssistantService({ ...deps, works: { snapshot: () => ({ entries: [{ projectPath: project, map }] as WorkEntry[], branches: {} }) } });
      await service.ask(ASK);
      const reply = await service.tool('parley_room', { target: 'Auth' });
      expect(reply.status).toBe(200);
      const { text } = reply.body as { text: string };
      expect(text).toContain('короткое письмо');
      expect(text).toContain(`${'д'.repeat(3999)}…`);
      expect(text).not.toContain('д'.repeat(4000));
      expect(text).toContain('This is the beginning of the room.');
    } finally {
      if (previous === undefined) delete process.env['PARLEY_HOME'];
      else process.env['PARLEY_HOME'] = previous;
      closeWorkDb();
    }
  });
  it('parley_room: работы нет в базе — комната без писем, не сбой', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const reply = await service.tool('parley_room', { target: 'Auth' });
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('No messages yet.') } });
  });
  it('parley_room и parley_session: чужая цель и плохой курсор — 400', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(await service.tool('parley_room', { target: 'S03' })).toEqual({ status: 400, body: { error: 'S03 Ruslan is not a room' } });
    expect(await service.tool('parley_room', { target: 'Auth', before: 'm-3' })).toEqual({ status: 400, body: { error: 'before must be the number from the last reply' } });
    expect(await service.tool('parley_room', { target: 'Auth', before: 0 })).toMatchObject({ status: 400 });
    expect(await service.tool('parley_session', { target: 'Auth' })).toEqual({ status: 400, body: { error: 'Auth is not a session' } });
  });
  it('parley_session: закрытая сессия по id читается, лента — из feed.snapshot', async () => {
    const service = createAssistantService({ ...deps, feed: feed([{ kind: 'text', id: 'text:#1', at: '', messageId: null, text: 'done', streaming: false }]) });
    await service.ask(ASK);
    const reply = await service.tool('parley_session', { target: closedId });
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('Agent: done') } });
  });
  it('parley_session: лента не читается — шапка и «нет истории», не ошибка', async () => {
    const service = createAssistantService({ ...deps, feed: { snapshot: vi.fn().mockRejectedValue(new Error('no feed')), decide: vi.fn() } as never });
    await service.ask(ASK);
    const reply = await service.tool('parley_session', { target: closedId });
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('No history for this session yet.') } });
  });
  it('parley_session: курсора нет в ленте — 400 с советом', async () => {
    const service = createAssistantService({ ...deps, feed: feed([{ kind: 'text', id: 'text:#1', at: '', messageId: null, text: 'done', streaming: false }]) });
    await service.ask(ASK);
    const reply = await service.tool('parley_session', { target: closedId, before: 'text:#99' });
    expect(reply).toMatchObject({ status: 400, body: { error: expect.stringContaining('without before') } });
  });
  it('parley_detail по id закрытой сессии — не 404', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect((await service.tool('parley_detail', { target: closedId })).status).toBe(200);
  });
  it('ход дольше минуты не обрывается; таймаут называет свою длину', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(turns[0]?.spec.timeoutMs).toBe(180_000);
    turns[0]?.end({ ok: false, kind: 'timeout', message: '' });
    await flush();
    expect(last().error).toBe('No answer in 180 s');
  });
  it('подпись: parley_room — detail с именем комнаты, parley_find — overview', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'tool', name: 'parley_room', input: { target: 'Auth' } });
    expect(last().detail).toEqual({ tool: 'detail', target: 'Auth' });
    turns[0]?.emit({ type: 'tool', name: 'parley_find', input: { query: 'x' } });
    expect(last().detail).toEqual({ tool: 'overview', target: null });
  });
});

describe('assistant-service: план действий', () => {
  // Закрытая сессия `s-09` из MAP: id строится как у targetsOf — по хешу пути проекта.
  const closedS09Id = `session:${createHash('sha1').update('/p').digest('hex').slice(0, 6)}:w-1:s-09`;
  const asked = async (over: Partial<AssistantServiceDeps> = {}) => {
    const service = createAssistantService({ ...deps, ...over });
    await service.ask(ASK);
    return service;
  };
  const order = (fn: unknown): number => (fn as Mock).mock.invocationCallOrder[0] ?? 0;

  it('propose_actions → карточка actions с шагами; Send старого окна — отказ, карточка остаётся', async () => {
    const service = await asked();
    expect((await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }] })).status).toBe(200);
    expect(last().proposal).toMatchObject({ action: 'actions', steps: [{ verb: 'interrupt', line: 'Stop what S03 Ruslan is doing', danger: false }] });
    expect(await service.decide('p1', 'send')).toEqual({ applied: false, error: 'Update Parley to confirm this card' });
    expect(service.state().proposal).not.toBeNull();
    expect(deps.interrupt).not.toHaveBeenCalled();
  });
  it('клик с action: actions — шаги идут, отчёт и заметка модели', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }, { do: 'sleep', session: 'S03' }] });
    expect(await service.decide('p1', 'send', 'actions')).toEqual({ applied: true, error: null });
    await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'done' }));
    expect(order(deps.interrupt)).toBeLessThan(order(deps.stopSession));
    expect(last()).toMatchObject({ proposal: null, outcome: 'done' });
    await service.ask({ ...ASK, text: 'дальше' });
    expect(turns.at(-1)?.spec.args[1]).toMatch(/^\[system: proposal p1 was done\]/);
  });
  it('ход плана виден: сначала все шаги waiting, потом running у текущего', async () => {
    let release: () => void = () => {};
    (deps.interrupt as Mock).mockImplementation(() => undefined);
    (deps.stopSession as Mock).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }, { do: 'sleep', session: 'S03' }] });
    await service.decide('p1', 'send', 'actions');
    expect(states.find((state) => state.report?.status === 'running')?.report?.steps.map((step) => step.status)).toEqual(['waiting', 'waiting']);
    await vi.waitFor(() => expect(last().report?.steps.map((step) => step.status)).toEqual(['done', 'running']));
    release();
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
  });
  it('двойное подтверждение — план выполняется один раз', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    const [first, second] = await Promise.all([service.decide('p1', 'send', 'actions'), service.decide('p1', 'send', 'actions')]);
    expect([first.applied, second.applied].sort()).toEqual([false, true]);
    expect([first, second].find((result) => !result.applied)?.error).toBe('This card is no longer current');
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
    expect(deps.stopSession).toHaveBeenCalledTimes(1);
  });
  it('второй план, пока идёт первый, — 409', async () => {
    (deps.stopSession as Mock).mockImplementation(() => new Promise(() => {})); // первый план висит
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    await service.decide('p1', 'send', 'actions');
    expect(await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }] })).toEqual({ status: 409, body: { error: 'A plan is still running; wait until it ends' } });
  });
  it('нет окна с признаком и нет Telegram — ошибка модели, карточки нет', async () => {
    const service = await asked({ actionsShown: () => false });
    expect(await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] })).toEqual({
      status: 409,
      body: { error: 'No Parley window can show this card; ask the person to open or update Parley' },
    });
    expect(last().proposal).toBeNull();
  });
  it('план не прошёл проверку — 400 с номером шага, карточки нет', async () => {
    const service = await asked();
    expect(await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }, { do: 'wake', session: 'S02' }] })).toEqual({ status: 400, body: { error: 'Step 2: S02 Anna is already awake' } });
    expect(last().proposal).toBeNull();
  });
  it('«да» словами при карточке actions — системная строка в ходе, не выполнение', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'Да' }, 'telegram');
    expect(turns.at(-1)?.spec.args[1]).toContain('[system: a card with actions is waiting; it is confirmed only by its button]');
    expect(deps.stopSession).not.toHaveBeenCalled();
    expect(service.state().proposal).not.toBeNull();
  });
  it('не «да» при карточке actions и «да» при письме — без системной строки', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'а что в комнате?' });
    expect(turns.at(-1)?.spec.args[1]).not.toContain('confirmed only by its button');
    await service.decide('p1', 'cancel');
    await service.tool('propose_message', { target: 'Auth', text: 'x' });
    await service.ask({ ...ASK, text: 'да' });
    expect(turns.at(-1)?.spec.args[1]).not.toContain('confirmed only by its button');
  });
  it('отмена карточки actions — исход cancelled, шаги не идут', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    await expect(service.decide('p1', 'cancel')).resolves.toEqual({ applied: true, error: null });
    expect(last()).toMatchObject({ proposal: null, outcome: 'cancelled' });
    expect(deps.stopSession).not.toHaveBeenCalled();
  });
  it('падение шага: заметка stopped at step', async () => {
    (deps.stopSession as Mock).mockRejectedValue(new Error('pty is gone'));
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }, { do: 'sleep', session: 'S03' }] });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'stopped', failedStep: 2, reason: 'pty is gone' }));
    await service.ask({ ...ASK, text: 'ну?' });
    expect(turns.at(-1)?.spec.args[1]).toMatch(/^\[system: proposal p1 stopped at step 2 of 2: pty is gone; step 1 done\]/);
  });
  it('падение на первом шаге: no steps done; на третьем — steps 1–2 done', async () => {
    (deps.stopSession as Mock).mockRejectedValue(new Error('boom'));
    const first = await asked();
    await first.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    await first.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report?.status).toBe('stopped'));
    await first.ask({ ...ASK, text: 'ну?' });
    expect(turns.at(-1)?.spec.args[1]).toContain('[system: proposal p1 stopped at step 1 of 1: boom; no steps done]');
    const second = createAssistantService(deps);
    await second.ask(ASK);
    await second.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }, { do: 'interrupt', session: 'S03' }, { do: 'sleep', session: 'S03' }] });
    await second.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'stopped', failedStep: 3 }));
    await second.ask({ ...ASK, text: 'ну?' });
    expect(turns.at(-1)?.spec.args[1]).toContain('stopped at step 3 of 3: boom; steps 1–2 done]');
  });
  it('пометки шагов попадают в заметку модели', async () => {
    (deps.createSession as Mock).mockResolvedValue({ projectPath: '/p', workId: 'w-1', sessionId: 's-03', held: 'folder-trust' });
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'create_session', work: 'Parley' }] });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
    await service.ask({ ...ASK, text: 'ну?' });
    expect(turns.at(-1)?.spec.args[1]).toContain('[system: proposal p1 was done (S03 Ruslan waits for you to trust the folder)]');
  });
  it('create_session: вход sessions.create — без requestedBy, lean из настроек, role и model только когда названы', async () => {
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'create_session', work: 'Parley', name: 'Vera', task: 'Run tests' }] });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
    expect(deps.createSession).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', provider: 'claude', label: 'Vera', task: 'Run tests', parent: null, lean: true });
  });
  it('шаги над комнатой и сессиями уходят в функции хоста с id и текстом', async () => {
    const service = await asked();
    await service.tool('propose_actions', {
      steps: [
        { do: 'add_to_room', room: 'Auth', session: 'S02' },
        { do: 'message', target: 'Auth', text: 'ping', mention: ['S02'] },
        { do: 'message', target: 'S03', text: 'hello' },
        { do: 'close', session: 'S02' },
      ],
    });
    expect(last().proposal).toMatchObject({ action: 'actions', target: '4 steps' });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'done' }));
    expect(deps.addRoomMember).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', sessionId: 's-02' });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: ['s-02'], text: '@s02 ping', kind: 'note' });
    expect(deps.send).toHaveBeenCalledWith({ ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-03' }, text: 'hello', submit: true });
    await expect(service.sent({ projectPath: '/p', workId: 'w-1', sessionId: 's-03' })).resolves.toMatchObject([{ text: 'hello' }]);
    expect(deps.closeSession).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', sessionId: 's-02' });
  });
  it('работа → агент → комната с задачей: ссылки \"$N\" подставляются итогами, роль и модель уходят только когда названы', async () => {
    const entries: WorkEntry[] = [{ projectPath: '/p', map: MAP }] as WorkEntry[];
    const fresh = { ...MAP, work: { id: 'w-2', title: 'Fresh', goal: '', status: 'active' }, sessions: [], rooms: [] } as unknown as WorkMap;
    (deps.createWork as Mock).mockImplementation(async () => {
      entries.push({ projectPath: '/p', map: fresh } as WorkEntry);
      return 'w-2';
    });
    (deps.createSession as Mock).mockImplementation(async () => {
      (fresh.sessions as unknown[]).push({ id: 's-01', label: 'S01 Vera', provider: 'claude', task: 'x', summary: null, lifecycle: 'active' });
      return { projectPath: '/p', workId: 'w-2', sessionId: 's-01' };
    });
    const service = await asked({ works: { snapshot: () => ({ entries, branches: {} }) } });
    await service.tool('propose_actions', {
      steps: [
        { do: 'create_work', project: '/p', title: 'Fresh' },
        { do: 'create_session', work: '$1', name: 'Vera', task: 'Look around' },
        { do: 'create_room', work: '$1', title: 'Duo', members: ['$2'], task: 'Start' },
      ],
    });
    expect(last().proposal).toMatchObject({ action: 'actions', target: '3 steps' });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'done' }));
    expect(deps.createWork).toHaveBeenCalledWith({ projectPath: '/p', title: 'Fresh', goal: '' });
    expect(deps.createSession).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', provider: 'claude', label: 'Vera', task: 'Look around', parent: null, lean: true });
    expect(deps.createRoom).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', title: 'Duo', members: ['s-01'], lead: 's-01' });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-2', roomId: 'r-9', to: [], text: 'Start', kind: 'note' });
  });
  it('роль и модель в sessions.create — когда названы', async () => {
    const reviewer = { id: 'builtin:reviewer', name: 'Reviewer', source: 'builtin', provider: 'claude', models: { claude: 'opus' } };
    const service = await asked({ roles: async () => [reviewer] as never });
    await service.tool('propose_actions', { steps: [{ do: 'create_session', work: 'Parley', role: 'reviewer', model: 'opus' }] });
    expect(last().proposal).toMatchObject({ action: 'actions' });
    await service.decide('p1', 'send', 'actions');
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ role: { source: 'builtin', name: 'reviewer' }, model: 'opus' }));
  });
  it('провайдер по умолчанию — из зеркала окна', async () => {
    const service = await asked();
    service.configure({ enabled: true, provider: null, model: null, language: 'ru', voiceModel: null, defaultProvider: 'codex' });
    await service.tool('propose_actions', { steps: [{ do: 'create_session', work: 'Parley' }] });
    expect(last().proposal).toMatchObject({ steps: [{ line: expect.stringContaining('· Codex') }] });
  });
  it('закрытая цель старой карточки — «reopen it in Parley first»', async () => {
    const service = await asked();
    expect(await service.tool('propose_message', { target: closedS09Id, text: 'hi' })).toEqual({ status: 409, body: { error: 'S09 Old is closed; reopen it in Parley first' } });
    expect(await service.tool('propose_decision', { target: closedS09Id, decision: { kind: 'plan', choice: 'manual' } })).toMatchObject({ status: 409, body: { error: 'S09 Old is closed; reopen it in Parley first' } });
    expect(last().proposal).toBeNull();
  });
  it('reset во время плана не стирает отчёт идущего плана; новый ход после конца плана его убирает', async () => {
    let release: () => void = () => {};
    (deps.stopSession as Mock).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = await asked();
    await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
    await service.decide('p1', 'send', 'actions');
    service.reset();
    expect(last().report).toMatchObject({ proposalId: 'p1', status: 'running' });
    release();
    await vi.waitFor(() => expect(last().report?.status).toBe('done'));
    service.reset();
    expect(last().report).toBeNull();
    await service.ask(ASK);
    expect(last()).toMatchObject({ phase: 'thinking', report: null });
  });
  it('подпись: propose_actions — propose', async () => {
    const service = await asked();
    void service;
    turns[0]?.emit({ type: 'tool', name: 'propose_actions', input: { steps: [] } });
    expect(last().detail).toEqual({ tool: 'propose', target: null });
  });
});
