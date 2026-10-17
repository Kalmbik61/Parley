import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent, ProviderEntry, WorkEntry, WorkMap } from '@parley/core';
import type { AssistantState } from '@parley/protocol';
import { createAssistantService, type AssistantServiceDeps } from './assistant-service.js';
import type { TurnEnd, TurnSpec } from './turn.js';

interface FakeTurn { spec: TurnSpec; emit(event: AssistantStreamEvent): void; end(result: TurnEnd): void; cancelled: boolean }

const CLAUDE = { id: 'claude', label: 'Claude', runner: { command: 'claude', mcpConfig: 'json-file', assistantArgs: ['-p', '{prompt}'], assistantResumeArgs: ['-p', '{prompt}', '--resume', '{providerSessionId}'] } } as unknown as ProviderEntry;
const MAP = {
  schemaVersion: 2,
  work: { id: 'w-1', title: 'Parley', goal: '', status: 'active' },
  sessions: [{ id: 's-03', label: 'S03 Ruslan', provider: 'claude', task: 'tests', summary: null, lifecycle: 'active' }],
  messages: [],
  rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null }],
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
    endpoint: { origin: () => 'http://127.0.0.1:9', setToken: (value) => { token = value; } },
    providers: async () => ({ claude: CLAUDE }),
    ready: async () => null,
    launchEnv: async () => ({}),
    binary: async (command) => `/bin/${command}`,
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
