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
    activity: { get: () => ({ activity: { activity: 'working', waitingFor: null, exited: false }, metrics: null }) as never },
    send: vi.fn().mockResolvedValue({ inserted: true, submitted: true, reason: null }),
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
    expect(proposal).toMatchObject({ target: 'Auth', kind: 'decision', text: 'Пропусти Safari' });
    turns[0]?.end({ ok: true });
    await flush();
    expect(last().phase).toBe('awaiting-confirm');
    await expect(service.decide(proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'Пропусти Safari', kind: 'decision' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'sent', phase: 'idle' });
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
