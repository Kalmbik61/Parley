/**
 * Служба ленты (план 2026-10-01, Task 2, «Тесты»): снимок и дельты по `revision`, пачка 50 мс,
 * кольцо по числу и байтам, сев из журнала, удержание и снятие хуков, решения окна.
 * Приёмник здесь не нужен: запрос хука — заглушка без HTTP (`hookRequest`).
 */

import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FeedItem,
  FeedPermissionCard,
  FeedPlanCard,
  FeedQuestionCard,
  RawRecord,
} from '@parley/core';
import { readJsonlRecords } from '@parley/core';
import { FEED_SCHEMA_VERSION } from '@parley/protocol';
import type { EventData } from '@parley/protocol';
import { fakeClient, fakeFeedDeps, hookRequest, REF } from '../../test/feed-fakes.js';
import type { FakeFeedDeps } from '../../test/feed-fakes.js';
import { HostError } from '../errors.js';
import { createFeedService, FEED_MAX_ITEMS, readRecordsTail } from './feed-service.js';
import type { FeedService, FeedServiceOptions } from './feed-service.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../core/src/feed/fixtures',
);

const SESSION = 'c-1';
const prompt = (text: string) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: SESSION,
  prompt: text,
});
const pre = (id: string, name: string, input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  session_id: SESSION,
  tool_name: name,
  tool_input: input,
  tool_use_id: id,
});
const permission = (name: string, input: Record<string, unknown>, suggestions: unknown[] = []) => ({
  hook_event_name: 'PermissionRequest',
  session_id: SESSION,
  tool_name: name,
  tool_input: input,
  permission_suggestions: suggestions,
});
const post = (id: string, name: string, input: Record<string, unknown>, response: unknown) => ({
  hook_event_name: 'PostToolUse',
  session_id: SESSION,
  tool_name: name,
  tool_input: input,
  tool_response: response,
  tool_use_id: id,
});
const display = (messageId: string, index: number, delta: string, final = false) => ({
  hook_event_name: 'MessageDisplay',
  session_id: SESSION,
  message_id: messageId,
  index,
  delta,
  final,
});

/** События пробы как есть, без ответов стенда. */
function probe(name: string): Record<string, unknown>[] {
  return readFileSync(path.join(FIXTURES, `${name}.events.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { ev?: Record<string, unknown> })
    .flatMap((line) => (line.ev === undefined ? [] : [line.ev]));
}

const QUESTIONS = [
  {
    question: 'Which fruit?',
    header: 'Fruit',
    options: [
      { label: 'Apple', description: 'A red or green fruit' },
      { label: 'Pear', description: null },
    ],
    multiSelect: false,
  },
];
const PLAN = {
  plan: '1. Create `hello.txt`.\n2. Write `hi`.\n',
  planFilePath: '~/.claude/plans/p.md',
};

let fakes: FakeFeedDeps;
let service: FeedService;
let tempDirs: string[] = [];

function start(options: FeedServiceOptions = {}): FeedService {
  service = createFeedService(fakes.deps, options);
  return service;
}

function send(body: Record<string, unknown>) {
  const request = hookRequest(body);
  service.onHook(request);
  return request;
}

const feedChanged = (client: ReturnType<typeof fakeClient>): Array<EventData<'feed.changed'>> =>
  client.sent
    .filter((message) => 'event' in message && message.event === 'feed.changed')
    .map((message) => (message as { data: EventData<'feed.changed'> }).data);

const ofKind = <K extends FeedItem['kind']>(items: readonly FeedItem[], kind: K) =>
  items.filter((item): item is Extract<FeedItem, { kind: K }> => item.kind === kind);

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'feed-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  fakes = fakeFeedDeps();
});

it('publishes live API retries from the log once and keeps the turn open', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'log.jsonl');
  await writeFile(file, '');
  fakes.setLogFile(file);
  const time = Date.parse('2026-10-05T10:00:00.000Z');
  start({ roots: () => [root], now: () => time });
  const client = fakeClient();
  service.subscribe(REF, client);
  send(prompt('hello'));
  send(display('answer', 0, 'Partial '));
  await writeFile(file, `${JSON.stringify({
    type: 'system', subtype: 'api_error', uuid: 'retry-6',
    timestamp: new Date(time + 1000).toISOString(),
    error: { status: 429, message: 'Usage limit reached for 5 hour.' },
    retryInMs: 8000, retryAttempt: 6, maxRetries: 10,
  })}\n`);
  fakes.emitLog();
  await vi.waitFor(async () => {
    const snapshot = await service.snapshot(REF);
    expect(ofKind(snapshot.items, 'error')).toHaveLength(1);
  });
  expect(feedChanged(client).flatMap((delta) => delta.upsert)).toContainEqual(
    expect.objectContaining({ kind: 'error', retry: { delayMs: 8000, attempt: 6, maxAttempts: 10 } }),
  );
  fakes.emitLog();
  send(display('answer', 1, 'Recovered', true));
  const snapshot = await service.snapshot(REF);
  expect(ofKind(snapshot.items, 'error')).toHaveLength(1);
  expect(ofKind(snapshot.items, 'turn')).toHaveLength(0);
  expect(ofKind(snapshot.items, 'text')[0]).toMatchObject({ text: 'Partial Recovered' });
  expect(ofKind(snapshot.items, 'error')[0]).toMatchObject({ retry: { resolved: true } });
});

afterEach(async () => {
  await service?.stop();
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('снимок и дельты', () => {
  it('дельты идут подписчику по revision, снимок сбрасывает пачку и продолжает счёт', async () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);

    send(prompt('go'));
    vi.advanceTimersByTime(50);
    send(pre('t1', 'Bash', { command: 'ls' }));
    const snapshot = await service.snapshot(REF);

    const deltas = feedChanged(client);
    expect(deltas.map((delta) => delta.revision)).toEqual([1, 2]);
    expect(deltas[0]?.upsert.map((item) => item.kind)).toEqual(['prompt']);
    expect(deltas[1]?.upsert.map((item) => item.id)).toEqual(['tool:t1']);
    expect(snapshot).toMatchObject({ revision: 2, schemaVersion: FEED_SCHEMA_VERSION });
    expect(snapshot.items.map((item) => item.kind)).toEqual(['prompt', 'tool']);

    send(post('t1', 'Bash', { command: 'ls' }, { stdout: 'a', stderr: '' }));
    vi.advanceTimersByTime(50);
    expect(feedChanged(client).at(-1)?.revision).toBe(3);
  });

  it('пачка 50 мс: несколько MessageDisplay — одна дельта с последней версией текста', () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);

    send(prompt('go'));
    send(display('m1', 0, 'one\n'));
    send(display('m1', 1, 'two\n'));
    vi.advanceTimersByTime(49);
    send(display('m1', 2, 'three\n', true));
    expect(feedChanged(client)).toHaveLength(0);
    vi.advanceTimersByTime(1);

    const deltas = feedChanged(client);
    expect(deltas).toHaveLength(1);
    const texts = ofKind(deltas[0]?.upsert ?? [], 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: 'one\ntwo\nthree\n', streaming: false });
  });

  it('MessageDisplay получает ответ сразу, до отправки пачки', () => {
    vi.useFakeTimers();
    start();
    const request = send(display('m1', 0, 'hi\n'));
    expect(request.responses).toEqual([{}]);
  });

  it('отписка и send() === false снимают подписку', () => {
    vi.useFakeTimers();
    start();
    const slow = fakeClient(() => false);
    const gone = fakeClient();
    service.subscribe(REF, slow);
    service.subscribe(REF, gone);
    service.unsubscribe(REF, gone);

    send(prompt('a'));
    vi.advanceTimersByTime(50);
    send(prompt('b'));
    vi.advanceTimersByTime(50);

    expect(feedChanged(slow)).toHaveLength(1);
    expect(feedChanged(gone)).toHaveLength(0);
  });

  it('снимок и подписка неизвестной сессии — not_found', async () => {
    start();
    const ref = { ...REF, sessionId: 's-99' };
    await expect(service.snapshot(ref)).rejects.toMatchObject({ code: 'not_found' });
    expect(() => service.subscribe(ref, fakeClient())).toThrow(HostError);
  });

  it('клиент отключился от хоста — dropClient снимает его подписки', () => {
    vi.useFakeTimers();
    start();
    const gone = fakeClient();
    const stays = fakeClient();
    service.subscribe(REF, gone);
    service.subscribe(REF, stays);
    service.dropClient(gone);

    send(prompt('a'));
    vi.advanceTimersByTime(50);

    expect(feedChanged(gone)).toHaveLength(0);
    expect(feedChanged(stays)).toHaveLength(1);
  });

  it('сессия пропала из работ: удержанным {}, лента и подписки забыты, таймеры сняты', async () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));

    fakes.setSessions([]);

    expect(request.responses).toEqual([{}]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.snapshot(REF)).rejects.toMatchObject({ code: 'not_found' });

    // Та же сессия заведена заново — лента с чистого листа, старый подписчик ничего не получает.
    fakes.setSessions([{ ref: REF }]);
    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [], revision: 0 });
    send(prompt('again'));
    vi.advanceTimersByTime(50);
    expect(feedChanged(client)).toHaveLength(0);
  });
});

describe('кольцо', () => {
  it('2 001-й элемент вытесняет первый, removed — в дельте', async () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);
    for (let i = 0; i < FEED_MAX_ITEMS; i += 1) send(prompt(`p${i}`));
    vi.advanceTimersByTime(50);
    const first = (await service.snapshot(REF)).items[0];

    send(prompt('last'));
    vi.advanceTimersByTime(50);

    const delta = feedChanged(client).at(-1);
    expect(delta?.removed).toEqual([first?.id]);
    expect(delta?.upsert.map((item) => (item.kind === 'prompt' ? item.text : ''))).toEqual([
      'last',
    ]);
    const snapshot = await service.snapshot(REF);
    expect(snapshot.items).toHaveLength(FEED_MAX_ITEMS);
    expect(snapshot.items.some((item) => item.id === first?.id)).toBe(false);
  });

  it('предел байтов: старые элементы уходят, пока JSON ленты не уложится', async () => {
    start({ maxBytes: 4_000 });
    for (let i = 0; i < 20; i += 1) send(prompt(`${i}:${'x'.repeat(500)}`));

    const { items } = await service.snapshot(REF);
    const bytes = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    expect(bytes).toBeLessThanOrEqual(4_000);
    expect(items.length).toBeGreaterThan(0);
    expect(items.at(-1)).toMatchObject({ kind: 'prompt', text: `19:${'x'.repeat(500)}` });
  });

  it('один элемент тяжелее предела байтов остаётся: лента не пустеет', async () => {
    start({ maxBytes: 100 });
    send(prompt('x'.repeat(500)));
    send(prompt('y'.repeat(500)));

    const { items } = await service.snapshot(REF);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'prompt', text: 'y'.repeat(500) });
  });

  it('вытесненная ждущая карточка отпускает свой хук пустым ответом', () => {
    start({ maxItems: 3 });
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));
    expect(request.responses).toEqual([]);
    send(prompt('a'));
    send(prompt('b'));
    send(prompt('c'));
    expect(request.responses).toEqual([{}]);
  });
});

describe('удержание хуков и решения', () => {
  it('PermissionRequest держится до решения окна; второе решение ничего не шлёт', () => {
    start();
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' },
    ];
    send(prompt('go'));
    expect(send(pre('t1', 'Bash', { command: 'ls' })).responses).toEqual([{}]);
    const request = send(permission('Bash', { command: 'ls' }, suggestions));
    expect(request.responses).toEqual([]);

    const first = service.decide(REF, 'permission:t1', {
      kind: 'permission',
      behavior: 'allow',
      always: true,
    });
    const second = service.decide(REF, 'permission:t1', { kind: 'permission', behavior: 'deny' });

    expect(first).toEqual({ applied: true, state: 'allowed' });
    expect(second).toEqual({ applied: false, state: 'allowed' });
    expect(request.responses).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedPermissions: suggestions },
        },
      },
    ]);
  });

  it('PostToolUse того же вызова: хуку {}, карточка elsewhere, решение после — applied false', async () => {
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));
    send(post('t1', 'Bash', { command: 'ls' }, { stdout: '', stderr: '' }));

    expect(request.responses).toEqual([{}]);
    const card = ofKind((await service.snapshot(REF)).items, 'permission')[0];
    expect(card?.state).toBe('elsewhere');
    expect(service.decide(REF, 'permission:t1', { kind: 'permission', behavior: 'allow' })).toEqual(
      {
        applied: false,
        state: 'elsewhere',
      },
    );
    expect(request.responses).toHaveLength(1);
  });

  it('decide: карточки нет — not_found; решение не того вида — applied false и хук ждёт', () => {
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));

    expect(() =>
      service.decide(REF, 'permission:nope', { kind: 'permission', behavior: 'allow' }),
    ).toThrow(HostError);
    expect(service.decide(REF, 'permission:t1', { kind: 'question', answers: {} })).toEqual({
      applied: false,
      state: 'pending',
    });
    expect(request.responses).toEqual([]);
  });

  it('вопрос: PreToolUse(AskUserQuestion) удержан, ответ несёт полный tool_input и answers', async () => {
    start();
    const input = { questions: QUESTIONS, note: 'n'.repeat(20_000) };
    send(prompt('go'));
    const request = send(pre('q1', 'AskUserQuestion', input));
    expect(request.responses).toEqual([]);

    const card = ofKind((await service.snapshot(REF)).items, 'question')[0] as FeedQuestionCard;
    expect(card.truncated).toBe(true);
    expect(
      service.decide(REF, card.cardId, { kind: 'question', answers: { 'Which fruit?': 'Pear' } }),
    ).toEqual({
      applied: true,
      state: 'answered',
    });
    expect(request.responses).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input, answers: { 'Which fruit?': 'Pear' } },
        },
      },
    ]);
  });

  it('PreToolUse(ExitPlanMode) — {} сразу; PermissionRequest(ExitPlanMode) удержан за карточкой plan', async () => {
    start();
    send(prompt('plan it'));
    expect(send(pre('pl1', 'ExitPlanMode', PLAN)).responses).toEqual([{}]);
    const request = send(permission('ExitPlanMode', PLAN));
    expect(request.responses).toEqual([]);

    const items = (await service.snapshot(REF)).items;
    expect(ofKind(items, 'permission')).toHaveLength(0);
    const plan = ofKind(items, 'plan')[0] as FeedPlanCard;
    expect(plan.cardId).toBe('plan:pl1');

    expect(service.decide(REF, 'plan:pl1', { kind: 'plan', choice: 'auto-accept' })).toEqual({
      applied: true,
      state: 'allowed',
    });
    expect(request.responses).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
          },
        },
      },
    ]);
  });

  it('PermissionRequest(ExitPlanMode) без карточки plan: карточка permission, решение plan не идёт, permission — allow', async () => {
    start();
    send(prompt('go'));
    const request = send(permission('ExitPlanMode', PLAN));
    expect(request.responses).toEqual([]);

    const card = ofKind((await service.snapshot(REF)).items, 'permission')[0] as FeedPermissionCard;
    expect(card.toolName).toBe('ExitPlanMode');
    expect(service.decide(REF, card.cardId, { kind: 'plan', choice: 'auto-accept' })).toEqual({
      applied: false,
      state: 'pending',
    });
    expect(request.responses).toEqual([]);

    expect(service.decide(REF, card.cardId, { kind: 'permission', behavior: 'allow' })).toEqual({
      applied: true,
      state: 'allowed',
    });
    expect(request.responses).toEqual([
      { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    ]);
  });

  it('карточка плана до PermissionRequest: решать нечем — applied false, состояние pending', () => {
    start();
    send(pre('pl1', 'ExitPlanMode', PLAN));
    expect(service.decide(REF, 'plan:pl1', { kind: 'plan', choice: 'manual' })).toEqual({
      applied: false,
      state: 'pending',
    });
  });

  it('проба p4 целиком: вопросы и план удержаны, PostToolUse снимает их {}, прочее — {} сразу', () => {
    start();
    const held: Array<{ event: unknown; request: ReturnType<typeof hookRequest> }> = [];
    for (const body of probe('p4-questions-plan')) {
      const request = send({ ...body, session_id: SESSION });
      if (request.responses.length === 0) held.push({ event: body['hook_event_name'], request });
    }
    // Первый вопрос и второй — PreToolUse, план — PermissionRequest; все сняты своим PostToolUse.
    expect(held.map((item) => item.event)).toEqual([
      'PreToolUse',
      'PreToolUse',
      'PermissionRequest',
    ]);
    for (const { request } of held) expect(request.responses).toEqual([{}]);
  });

  it('таймаут часа: хуку {}, карточка stale (фальшивые таймеры)', async () => {
    vi.useFakeTimers();
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));

    vi.advanceTimersByTime(3_600_000);

    expect(request.responses).toEqual([{}]);
    const card = ofKind((await service.snapshot(REF)).items, 'permission')[0] as FeedPermissionCard;
    expect(card.state).toBe('stale');
  });

  it('CLI закрыл удержанный запрос сам — карточка elsewhere, решение не применяется', async () => {
    start();
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));
    request.abandon();

    expect(ofKind((await service.snapshot(REF)).items, 'permission')[0]?.state).toBe('elsewhere');
    expect(
      service.decide(REF, 'permission:t1', { kind: 'permission', behavior: 'allow' }).applied,
    ).toBe(false);
  });

  it('активность стала idle — ждущая карточка elsewhere, хуку {}; удержанный вопрос не трогается', async () => {
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const bash = send(permission('Bash', { command: 'ls' }));
    const question = send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));

    fakes.emitActivity(REF, 'working');
    fakes.emitActivity(REF, 'idle');

    expect(bash.responses).toEqual([{}]);
    expect(question.responses).toEqual([]);
    const items = (await service.snapshot(REF)).items;
    expect(ofKind(items, 'permission')[0]?.state).toBe('elsewhere');
    expect(ofKind(items, 'question')[0]?.state).toBe('pending');
  });

  it('удержанный вопрос: службе активности — questionHeld(ref, true) один раз; ответ окна — false', () => {
    start();
    const held = vi.mocked(fakes.deps.activity.questionHeld);
    send(prompt('go'));
    const request = send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));
    expect(request.responses).toEqual([]);
    expect(held.mock.calls).toEqual([[REF, true]]);

    service.decide(REF, 'question:q1', { kind: 'question', answers: { 'Which fruit?': 'Pear' } });
    expect(held.mock.calls).toEqual([
      [REF, true],
      [REF, false],
    ]);
  });

  it('вопрос: CLI закрыл запрос сам — questionHeld(ref, false)', () => {
    start();
    const held = vi.mocked(fakes.deps.activity.questionHeld);
    send(prompt('go'));
    const request = send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));
    request.abandon();
    expect(held.mock.calls).toEqual([
      [REF, true],
      [REF, false],
    ]);
  });

  it('вопрос: таймаут часа — questionHeld(ref, false)', () => {
    vi.useFakeTimers();
    start();
    const held = vi.mocked(fakes.deps.activity.questionHeld);
    send(prompt('go'));
    send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));
    vi.advanceTimersByTime(3_600_000);
    expect(held.mock.calls).toEqual([
      [REF, true],
      [REF, false],
    ]);
  });

  it('вопрос: stop() — questionHeld(ref, false)', () => {
    start();
    const held = vi.mocked(fakes.deps.activity.questionHeld);
    send(prompt('go'));
    send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));
    void service.stop();
    expect(held.mock.calls).toEqual([
      [REF, true],
      [REF, false],
    ]);
  });

  it('удержанный PermissionRequest службу активности не трогает: диалог показывает сам CLI', () => {
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    send(permission('Bash', { command: 'ls' }));
    expect(fakes.deps.activity.questionHeld).not.toHaveBeenCalled();
  });

  it('pty.exit: висящим {}, карточки stale, ход закрыт чертой', async () => {
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));

    fakes.emitExit(REF);

    expect(request.responses).toEqual([{}]);
    const items = (await service.snapshot(REF)).items;
    expect(ofKind(items, 'permission')[0]?.state).toBe('stale');
    expect(ofKind(items, 'tool')[0]?.status).toBe('rejected');
    expect(items.at(-1)?.kind).toBe('turn');
  });

  it('stop(): всем удержанным {}, новые события — {} сразу', () => {
    start();
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));
    void service.stop();

    expect(request.responses).toEqual([{}]);
    expect(send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS })).responses).toEqual([{}]);
  });

  it('stop() снимает таймеры пачки и удержания', () => {
    vi.useFakeTimers();
    start();
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    send(permission('Bash', { command: 'ls' }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    void service.stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('сев из журнала', () => {
  /** Корень истории Claude с журналом сессии и журналом субагента p6b. */
  async function history(): Promise<{ root: string; session: string }> {
    const dir = await tempRoot();
    const root = path.join(dir, 'projects');
    const session = path.join(root, '-proj', 'sess.jsonl');
    await mkdir(path.join(root, '-proj', 'sess', 'subagents'), { recursive: true });
    await copyFile(path.join(FIXTURES, 'transcript-p6b-subagents.jsonl'), session);
    await copyFile(
      path.join(FIXTURES, 'transcript-p6b-agent-ad2fe21e96ffde3ba.jsonl'),
      path.join(root, '-proj', 'sess', 'subagents', 'agent-ad2fe21e96ffde3ba.jsonl'),
    );
    await copyFile(
      path.join(FIXTURES, 'transcript-p5b-write.jsonl'),
      path.join(root, '-proj', 'write.jsonl'),
    );
    return { root, session };
  }

  function countingReader() {
    const files: string[] = [];
    const read = async (file: string): Promise<RawRecord[]> => {
      files.push(file);
      return (await readJsonlRecords(file)).records;
    };
    return { files, read };
  }

  /** Читатель, который считает дочитанные журналы: сев вне снимка идёт в фоне, и ждать надо его конца. */
  function finishingReader() {
    let finished = 0;
    const read = async (file: string): Promise<RawRecord[]> => {
      const { records } = await readJsonlRecords(file);
      finished += 1;
      return records;
    };
    return { finished: () => finished, read };
  }

  it('GLM snapshot seeds the Claude Code transcript and its subagent feed', async () => {
    const { root, session } = await history();
    fakes.setSessions([{ ref: REF, provider: 'glm' }]);
    fakes.setLogFile(session);
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });

    const snapshot = await service.snapshot(REF);
    expect(snapshot.items.length).toBeGreaterThan(0);
    const agent = await service.snapshot(REF, 'ad2fe21e96ffde3ba');
    expect(agent.items.length).toBeGreaterThan(0);
    expect(reader.files).toHaveLength(2);
  });

  it('GLM transcript discovered after subscription seeds and sends a delta', async () => {
    const { root } = await history();
    fakes.setSessions([{ ref: REF, provider: 'glm' }]);
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });
    const client = fakeClient();
    service.subscribe(REF, client);
    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [] });

    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    fakes.emitLog();
    await vi.waitFor(() => expect(feedChanged(client)).toHaveLength(1));
    expect(ofKind(feedChanged(client)[0]?.upsert ?? [], 'tool').length).toBeGreaterThan(0);
    expect(reader.files).toHaveLength(1);
  });

  it('снимок без живых событий сеет из журнала один раз: вызовы и дифф на месте', async () => {
    const { root } = await history();
    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });

    const first = await service.snapshot(REF);
    const second = await service.snapshot(REF);

    expect(reader.files).toHaveLength(1);
    const tools = ofKind(first.items, 'tool');
    expect(tools.some((tool) => tool.patch?.some((hunk) => hunk.lines.includes('+gamma')))).toBe(
      true,
    );
    expect(first.revision).toBe(0);
    expect(second.items).toEqual(first.items);
  });

  it('журнал ещё не известен индексу — следующий снимок сеет, когда он появится', async () => {
    const { root } = await history();
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });

    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [], revision: 0 });
    expect(reader.files).toHaveLength(0);

    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    const seeded = await service.snapshot(REF);
    expect(reader.files).toHaveLength(1);
    expect(ofKind(seeded.items, 'tool').length).toBeGreaterThan(0);
  });

  it('журнал появился у индекса после снимка — лента сеется и уходит подписчику дельтой', async () => {
    const { root } = await history();
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });
    const client = fakeClient();
    service.subscribe(REF, client);
    // Окно подключилось раньше, чем индекс журналов построился: снимок пуст, второй оно не попросит.
    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [], revision: 0 });

    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    fakes.emitLog();
    await vi.waitFor(() => expect(feedChanged(client)).toHaveLength(1));

    const delta = feedChanged(client)[0];
    expect(delta?.revision).toBe(1);
    expect(ofKind(delta?.upsert ?? [], 'tool').length).toBeGreaterThan(0);
    const snapshot = await service.snapshot(REF);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.items).toEqual(delta?.upsert);
    // Следующие изменения журналов ленту заново не сеют и ничего не шлют.
    fakes.emitLog();
    await service.snapshot(REF);
    expect(reader.files).toHaveLength(1);
    expect(feedChanged(client)).toHaveLength(1);
  });

  it('поздний сев без подписчиков дельту не шлёт: посеянное отдаёт следующий снимок', async () => {
    const { root } = await history();
    const reader = finishingReader();
    start({ roots: () => [root], readRecords: reader.read });
    await service.snapshot(REF);

    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    fakes.emitLog();
    await vi.waitFor(() => expect(reader.finished()).toBe(1));

    const snapshot = await service.snapshot(REF);
    expect(snapshot.revision).toBe(0);
    expect(ofKind(snapshot.items, 'tool').length).toBeGreaterThan(0);
    expect(reader.finished()).toBe(1);
  });

  it('процесс сессии запущен — лента сеется до живых событий: история цела, даже если чат открыли позже', async () => {
    const { root } = await history();
    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    const reader = finishingReader();
    start({ roots: () => [root], readRecords: reader.read });

    fakes.emitStart(REF);
    await vi.waitFor(() => expect(reader.finished()).toBe(1));
    send(prompt('live'));

    const snapshot = await service.snapshot(REF);
    expect(reader.finished()).toBe(1);
    expect(ofKind(snapshot.items, 'tool').length).toBeGreaterThan(0);
    expect(snapshot.items.at(-1)).toMatchObject({ kind: 'prompt', text: 'live' });
  });

  it('запуск раньше индекса журналов: лента сеется, когда журнал появится, и живое идёт следом', async () => {
    const { root } = await history();
    const reader = finishingReader();
    start({ roots: () => [root], readRecords: reader.read });

    fakes.emitStart(REF);
    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    fakes.emitLog();
    await vi.waitFor(() => expect(reader.finished()).toBe(1));
    send(prompt('live'));

    const snapshot = await service.snapshot(REF);
    expect(ofKind(snapshot.items, 'tool').length).toBeGreaterThan(0);
    expect(snapshot.items.at(-1)).toMatchObject({ kind: 'prompt', text: 'live' });
  });

  it('запуск сессии Codex ленту не заводит и журнал не читает', async () => {
    const { root } = await history();
    fakes = fakeFeedDeps([{ ref: REF, provider: 'codex' }]);
    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    const reader = finishingReader();
    start({ roots: () => [root], readRecords: reader.read });

    fakes.emitStart(REF);
    fakes.emitLog();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reader.finished()).toBe(0);
  });

  it('журнал оборван посреди хода — сев закрывает ход чертой interrupted, идущий вызов отклонён', async () => {
    const dir = await tempRoot();
    const root = path.join(dir, 'projects');
    await mkdir(path.join(root, '-proj'), { recursive: true });
    const file = path.join(root, '-proj', 'broken.jsonl');
    const record = (value: Record<string, unknown>) => JSON.stringify({ sessionId: 's', ...value });
    await writeFile(
      file,
      [
        record({ type: 'user', uuid: 'u1', timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: 'сделай' } }),
        record({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-10-02T10:00:05.000Z',
          message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 600' } }] },
        }),
      ].join('\n'),
    );
    fakes.setLogFile(file);
    start({ roots: () => [root] });

    const snapshot = await service.snapshot(REF);

    expect(snapshot.items.map((item) => item.kind)).toEqual(['prompt', 'tool', 'turn']);
    expect(ofKind(snapshot.items, 'tool')[0]).toMatchObject({ status: 'rejected' });
    expect(snapshot.items.at(-1)).toMatchObject({
      kind: 'turn',
      interrupted: true,
      at: '2026-10-02T10:00:05.000Z',
      durationMs: 5000,
    });
  });

  it('живые события уже были — журнал не читается', async () => {
    const { root } = await history();
    fakes.setLogFile(path.join(root, '-proj', 'write.jsonl'));
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });
    send(prompt('live'));

    const snapshot = await service.snapshot(REF);
    expect(reader.files).toHaveLength(0);
    expect(snapshot.items.map((item) => item.kind)).toEqual(['prompt']);
  });

  it('журнала нет или он вне корней — пустая лента без ошибки и без чтения', async () => {
    const { root } = await history();
    const outside = await tempRoot();
    const reader = countingReader();
    start({ roots: () => [root], readRecords: reader.read });

    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [], revision: 0 });

    // Вне корней лежит настоящий журнал — и всё равно не читается.
    const foreign = path.join(outside, 'x.jsonl');
    await copyFile(path.join(FIXTURES, 'transcript-p5b-write.jsonl'), foreign);
    fakes.setLogFile(foreign);
    await service.stop();
    start({ roots: () => [root], readRecords: reader.read });
    await expect(service.snapshot(REF)).resolves.toMatchObject({ items: [], revision: 0 });
    expect(reader.files).toHaveLength(0);
  });

  it('readRecordsTail: только последние записи журнала, по порядку', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'big.jsonl');
    const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ type: 'user', i }));
    await writeFile(file, `${lines.join('\n')}\n`);

    const tail = await readRecordsTail(file, 10);
    expect(tail.map((record) => record['i'])).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 15),
    );
    expect(await readRecordsTail(file, 100)).toHaveLength(25);
  });

  it('снимок субагента по agentId — из его журнала, revision 0', async () => {
    const { root, session } = await history();
    fakes.setLogFile(session);
    start({ roots: () => [root] });

    const snapshot = await service.snapshot(REF, 'ad2fe21e96ffde3ba');
    expect(snapshot.revision).toBe(0);
    expect(ofKind(snapshot.items, 'tool').length).toBeGreaterThan(0);
  });

  it('субагент: путь вне корней, нет файла или кривой id — not_found, файл не читается', async () => {
    const { root, session } = await history();
    const reader = countingReader();
    fakes.setLogFile(session);
    start({ roots: () => [path.join(root, 'elsewhere')], readRecords: reader.read });

    await expect(service.snapshot(REF, 'ad2fe21e96ffde3ba')).rejects.toMatchObject({
      code: 'not_found',
    });
    service = createFeedService(fakes.deps, { roots: () => [root], readRecords: reader.read });
    await expect(service.snapshot(REF, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.snapshot(REF, '../sess')).rejects.toMatchObject({ code: 'not_found' });
    expect(reader.files).toHaveLength(0);
  });

  it('снимок субагента режется тем же пределом байтов — остаётся хвост', async () => {
    const { root, session } = await history();
    fakes.setLogFile(session);
    const full = await createFeedService(fakes.deps, { roots: () => [root] }).snapshot(
      REF,
      'ad2fe21e96ffde3ba',
    );
    const last = full.items.at(-1) as FeedItem;
    const limit = Buffer.byteLength(JSON.stringify(last)) + 10;
    start({ roots: () => [root], maxBytes: limit });

    const cut = await service.snapshot(REF, 'ad2fe21e96ffde3ba');
    const bytes = cut.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    expect(bytes).toBeLessThanOrEqual(limit);
    expect(cut.items.length).toBeLessThan(full.items.length);
    expect(cut.items.at(-1)).toEqual(last);
  });
});

describe('Stop из чата: feed.interrupt (живая проверка 2026-10-02)', () => {
  const ESC = '\x1b';
  const BACKSPACE = '\x7f';
  const INPUT = (text: string) => ['⏺ ответ', '────────', `❯ ${text}`, '────────', '  ⏵⏵ auto mode on'];

  it('ход без ответа CLI бросает молча: лента закрывает его сама и стирает возвращённый в поле текст', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    const client = fakeClient();
    service.subscribe(REF, client);
    send(prompt('Сосчитай от 1 до 40'));
    fakes.setScreen(INPUT('Сосчитай от 1 до 40'));

    service.interrupt(REF);
    expect(fakes.writes).toEqual([ESC]);
    vi.advanceTimersByTime(999);
    expect(fakes.writes).toHaveLength(1);
    vi.advanceTimersByTime(60);

    expect(fakes.writes[1]).toBe(BACKSPACE.repeat('Сосчитай от 1 до 40'.length));
    const snapshot = await service.snapshot(REF);
    expect(snapshot.items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
    expect(feedChanged(client).at(-1)?.upsert.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
  });

  it('за срок пришло событие хода (ответ уже шёл) — ленту не трогаем: ход закроет запись журнала или Stop', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    send(prompt('go'));
    fakes.setScreen(INPUT('go'));

    service.interrupt(REF);
    send(display('m1', 0, 'Отвечаю'));
    vi.advanceTimersByTime(1100);

    expect(fakes.writes).toEqual([ESC]);
    const snapshot = await service.snapshot(REF);
    expect(ofKind(snapshot.items, 'turn')).toHaveLength(0);
  });

  it('экран не показывает текст промпта в поле ввода — ход закрыт, но ничего не стирается', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    send(prompt('длинный вопрос человека'));
    fakes.setScreen(INPUT(''));

    service.interrupt(REF);
    vi.advanceTimersByTime(1100);

    expect(fakes.writes).toEqual([ESC]);
    expect((await service.snapshot(REF)).items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
  });

  it('человек набирает в терминале сам — его строку не стираем', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    send(prompt('вопрос'));
    fakes.setScreen(INPUT('вопрос'));
    fakes.setProcess({ pid: 1, draft: true });

    service.interrupt(REF);
    vi.advanceTimersByTime(1100);

    expect(fakes.writes).toEqual([ESC]);
  });

  it('длинная вставка стоит в поле меткой [Pasted text #N] — стирается; многострочный промпт сверяется по первой строке', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    send(prompt('первая строка\nвторая строка'));
    fakes.setScreen(INPUT('первая строка'));
    service.interrupt(REF);
    vi.advanceTimersByTime(1100);
    expect(fakes.writes[1]).toBe(BACKSPACE.repeat('первая строка\nвторая строка'.length));

    send(prompt('x'.repeat(900)));
    fakes.setScreen(INPUT('[Pasted text #1 +3 lines]'));
    service.interrupt(REF);
    vi.advanceTimersByTime(1100);
    expect(fakes.writes[3]).toBe(BACKSPACE.repeat(900));
  });

  it('хода в ленте нет — только Esc; сессия не запущена — not_found; процесс сменился за срок — ничего', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    service.interrupt(REF);
    vi.advanceTimersByTime(1100);
    expect(fakes.writes).toEqual([ESC]);

    send(prompt('go'));
    fakes.setScreen(INPUT('go'));
    service.interrupt(REF);
    fakes.setProcess({ pid: 2 });
    vi.advanceTimersByTime(1100);
    expect(fakes.writes).toEqual([ESC, ESC]);
    expect(ofKind((await service.snapshot(REF)).items, 'turn')).toHaveLength(0);

    fakes.setProcess(null);
    expect(() => service.interrupt(REF)).toThrow(HostError);
  });

  it('stop() снимает присмотр за Esc', async () => {
    vi.useFakeTimers();
    start({ interruptGraceMs: 1000 });
    send(prompt('go'));
    fakes.setScreen(INPUT('go'));
    service.interrupt(REF);
    await service.stop();
    vi.advanceTimersByTime(1100);
    expect(fakes.writes).toEqual([ESC]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('режим разрешений (план 2026-10-01, решение 4)', () => {
  it('снимок несёт режим из permission_mode события; без событий — null', async () => {
    start();
    await expect(service.snapshot(REF)).resolves.toMatchObject({ mode: null });

    send({ ...prompt('go'), permission_mode: 'plan' });
    await expect(service.snapshot(REF)).resolves.toMatchObject({ mode: 'plan' });
  });

  it('дельта несёт режим; смена режима без элементов тоже уходит дельтой', () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);

    send({ ...prompt('go'), permission_mode: 'default' });
    vi.advanceTimersByTime(50);
    // Событие без новых элементов (PostToolUse без вызова не меняет ленту), но с другим режимом.
    send({ hook_event_name: 'Notification', session_id: SESSION, permission_mode: 'acceptEdits' });
    vi.advanceTimersByTime(50);

    const deltas = feedChanged(client);
    expect(deltas.map((delta) => delta.mode)).toEqual(['default', 'acceptEdits']);
    expect(deltas[1]?.upsert).toEqual([]);
    expect(deltas.map((delta) => delta.revision)).toEqual([1, 2]);
  });

  it('тот же режим дельты не рождает', () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);

    send({ ...prompt('go'), permission_mode: 'default' });
    vi.advanceTimersByTime(50);
    send({ hook_event_name: 'Notification', session_id: SESSION, permission_mode: 'default' });
    vi.advanceTimersByTime(50);

    expect(feedChanged(client)).toHaveLength(1);
  });

  it('noteMode ставит режим и шлёт дельту без элементов', async () => {
    vi.useFakeTimers();
    start();
    const client = fakeClient();
    service.subscribe(REF, client);

    service.noteMode(REF, 'plan');
    vi.advanceTimersByTime(50);

    expect(feedChanged(client)).toEqual([
      { ref: REF, revision: 1, upsert: [], removed: [], mode: 'plan' },
    ]);
    await expect(service.snapshot(REF)).resolves.toMatchObject({ mode: 'plan', revision: 1 });

    service.noteMode(REF, 'plan');
    vi.advanceTimersByTime(50);
    expect(feedChanged(client)).toHaveLength(1);
  });

  it('сев из журнала ставит режим последней записи permission-mode', async () => {
    const dir = await tempRoot();
    const root = path.join(dir, 'projects');
    await mkdir(path.join(root, '-proj'), { recursive: true });
    const file = path.join(root, '-proj', 'write.jsonl');
    await copyFile(path.join(FIXTURES, 'transcript-p5b-write.jsonl'), file);
    fakes.setLogFile(file);
    start({
      roots: () => [root],
      readRecords: async (name) => (await readJsonlRecords(name)).records,
    });

    await expect(service.snapshot(REF)).resolves.toMatchObject({ mode: 'default', revision: 0 });
  });
});

describe('прерывание Esc по записи журнала (решение 5)', () => {
  const interruptRecord = (at: string, suffix = ''): string =>
    `${JSON.stringify({
      type: 'user',
      timestamp: at,
      sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'text', text: `[Request interrupted by user${suffix}]` }] },
    })}\n`;

  async function logUnder(root: string): Promise<string> {
    const file = path.join(root, 'log.jsonl');
    await writeFile(file, '');
    fakes.setLogFile(file);
    return file;
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  it('запись о прерывании новее начала хода: черта interrupted, вызов отклонён, удержанный вопрос — {} и questionHeld(false)', async () => {
    const root = await tempRoot();
    const file = await logUnder(root);
    start({ roots: () => [root] });
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'sleep 9' }));
    const question = send(pre('q1', 'AskUserQuestion', { questions: QUESTIONS }));
    expect(question.responses).toEqual([]);
    const startedAt = ofKind((await service.snapshot(REF)).items, 'prompt')[0]!.at;

    await writeFile(file, interruptRecord(new Date(Date.parse(startedAt) + 1_000).toISOString(), ' for tool use'), { flag: 'a' });
    fakes.emitLog();

    await vi.waitFor(async () => {
      expect((await service.snapshot(REF)).items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
    });
    const { items } = await service.snapshot(REF);
    expect(ofKind(items, 'tool')[0]?.status).toBe('rejected');
    expect(ofKind(items, 'question')[0]?.state).toBe('elsewhere');
    expect(question.responses).toEqual([{}]);
    expect(vi.mocked(fakes.deps.activity.questionHeld).mock.calls.at(-1)).toEqual([REF, false]);

    // Журнал изменился ещё раз — второй черты нет: ход уже закрыт.
    fakes.emitLog();
    await settle();
    expect(ofKind((await service.snapshot(REF)).items, 'turn')).toHaveLength(1);
  });

  it('запись старше начала хода не закрывает ход; журнал вне корней истории не читается', async () => {
    const root = await tempRoot();
    const file = await logUnder(root);
    await writeFile(file, interruptRecord(new Date(Date.now() - 60_000).toISOString()), { flag: 'a' });
    start({ roots: () => [root] });
    send(prompt('go'));
    fakes.emitLog();
    await settle();
    expect(ofKind((await service.snapshot(REF)).items, 'turn')).toHaveLength(0);

    const outside = await tempRoot();
    const foreign = path.join(outside, 'log.jsonl');
    await writeFile(foreign, interruptRecord(new Date(Date.now() + 60_000).toISOString()));
    fakes.setLogFile(foreign);
    fakes.emitLog();
    await settle();
    expect(ofKind((await service.snapshot(REF)).items, 'turn')).toHaveLength(0);
  });
});

describe('лента Codex', () => {
  const stamp = (n: number): string => new Date(Date.UTC(2026, 9, 7, 10, 0, n)).toISOString();
  const line = (n: number, ordinal: number, type: string, payload: Record<string, unknown>) => ({
    timestamp: stamp(n),
    ordinal,
    type,
    payload,
  });
  const meta = (id: string) => line(0, 0, 'session_meta', { id, cwd: '/tmp/p', cli_version: '0.160.0', source: 'cli' });
  const started = (n: number) => line(n, n, 'event_msg', { type: 'task_started', turn_id: 'u1' });
  const complete = (n: number) => line(n, n, 'event_msg', { type: 'task_complete', turn_id: 'u1' });
  const item = (n: number, thread: string, body: Record<string, unknown>) =>
    line(n, n, 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: 'u1', item: body });
  const userMessage = (n: number, id: string, text: string) =>
    item(n, 'th-main', { type: 'UserMessage', id, content: [{ type: 'text', text }] });
  const command = (n: number, id: string, cmd: string, thread = 'th-main') =>
    item(n, thread, {
      type: 'CommandExecution',
      id,
      command: [cmd],
      cwd: '/tmp/p',
      parsed_cmd: [],
      source: 'agent',
      status: 'completed',
      aggregated_output: '',
      exit_code: 0,
    });
  const subagent = (n: number, child: string, kind: string) =>
    item(n, 'th-main', { type: 'SubAgentActivity', id: `sa${n}`, kind, agent_thread_id: child, agent_path: '/root/explorer' });
  const childMeta = (id: string, parent: string, historyStart: number) =>
    line(2, 0, 'session_meta', {
      id,
      parent_thread_id: parent,
      forked_from_id: parent,
      agent_nickname: 'explorer',
      subagent_history_start_ordinal: historyStart,
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/explorer', agent_nickname: 'explorer', agent_role: 'explorer' } } },
    });
  const parentCopy = (n: number) => command(n, `parent_old${n}`, 'ls', 'th-parent');
  const task = (n: number, text: string) =>
    line(n, n, 'response_item', {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/explorer',
      content: [{ type: 'input_text', text }],
    });

  const body = (rows: object[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const writeRollout = (file: string, rows: object[]) => writeFile(file, body(rows));
  const appendRollout = (file: string, rows: object[]) => writeFile(file, body(rows), { flag: 'a' });

  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await tempRoot();
    file = path.join(dir, 'main.jsonl');
    fakes = fakeFeedDeps([{ ref: REF, provider: 'codex' }]);
    fakes.setLogFile(file);
  });

  it('снимок — лента из журнала Codex', async () => {
    await writeRollout(file, [meta('th-main'), started(1), userMessage(2, 'um1', 'Почини тесты'), command(3, 'c1', 'ls'), complete(4)]);
    start();
    const snapshot = await service.snapshot(REF);
    expect(snapshot.items.map((entry) => entry.kind)).toEqual(['prompt', 'tool', 'turn']);
  });

  it('дописанные строки приходят дельтой по изменению журналов', async () => {
    await writeRollout(file, [meta('th-main'), started(1)]);
    start();
    const client = fakeClient();
    service.subscribe(REF, client);
    await service.snapshot(REF);
    await appendRollout(file, [userMessage(2, 'um1', 'go')]);
    fakes.emitLog();
    await vi.waitFor(() =>
      expect(feedChanged(client).flatMap((delta) => delta.upsert.map((entry) => entry.kind))).toContain('prompt'),
    );
  });

  it('рестарт хоста посреди хода: процесса нет — ход закрыт Interrupted; процесс жив — не закрыт (Review Focus 5)', async () => {
    await writeRollout(file, [meta('th-main'), started(1), userMessage(2, 'um1', 'go'), command(3, 'c1', 'sleep 100')]);
    fakes.setProcess(null);
    start();
    const dead = await service.snapshot(REF);
    expect(dead.items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
    await service.stop();
    fakes = fakeFeedDeps([{ ref: REF, provider: 'codex' }]);
    fakes.setLogFile(file);
    fakes.setProcess({ pid: 42 });
    start();
    const alive = await service.snapshot(REF);
    expect(alive.items.some((entry) => entry.kind === 'turn')).toBe(false);
  });

  it('агент Codex: карточка, сведения и вызовы из его журнала; снимок агента — его лента', async () => {
    await writeRollout(file, [meta('th-main'), started(1), subagent(2, 'th-child', 'started')]);
    const childFile = path.join(dir, 'child.jsonl');
    await writeRollout(childFile, [childMeta('th-child', 'th-main', 3), parentCopy(1), parentCopy(2), task(3, 'Найди newAgent'), command(4, 'cc1', 'rg newAgent', 'th-child')]);
    fakes.setChildLogFile('th-child', childFile);
    start();
    await service.snapshot(REF);
    await vi.waitFor(async () => {
      const card = (await service.snapshot(REF)).items.find((entry) => entry.kind === 'agent');
      expect(card).toMatchObject({ prompt: 'Найди newAgent', toolCount: 1 });
    });
    const sub = await service.snapshot(REF, 'th-child');
    expect(sub.items.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'cc1')).toBe(true);
  });

  it('Stop у Codex — только Esc, без стирания промпта', () => {
    fakes.setProcess({ pid: 42 });
    start();
    service.interrupt(REF);
    expect(fakes.writes).toEqual(['\x1b']);
  });
});

describe('хуки Codex', () => {
  const CODEX_SESSION = 'th-main';
  const hook = (name: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: name,
    session_id: CODEX_SESSION,
    ...extra,
  });
  const permissionBash = (command: string) =>
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command } });

  beforeEach(() => {
    fakes = fakeFeedDeps([{ ref: REF, provider: 'codex' }]);
  });

  it('первый хук сессии Codex — decisions window; PermissionRequest удерживается и отвечается решением окна', async () => {
    start({ codexApprovals: async () => true });
    const client = fakeClient();
    service.subscribe(REF, client);
    send(hook('SessionStart', { source: 'startup' }));
    const held = send(permissionBash('touch ~/x'));
    const snapshot = await service.snapshot(REF);
    expect(snapshot.decisions).toBe('window');
    const card = snapshot.items.find((entry) => entry.kind === 'permission');
    expect(held.responses).toEqual([]);
    service.decide(REF, (card as { cardId: string }).cardId, { kind: 'permission', behavior: 'allow' });
    expect(held.responses).toEqual([
      { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    ]);
  });

  it('дельта несёт decisions, когда пришёл первый хук', async () => {
    start({ codexApprovals: async () => true });
    const client = fakeClient();
    service.subscribe(REF, client);
    await service.snapshot(REF);
    send(hook('SessionStart', { source: 'startup' }));
    await vi.waitFor(() => {
      expect(feedChanged(client).some((data) => data.decisions === 'window')).toBe(true);
    });
  });

  it('хуков нет за 15 с после старта процесса — decisions terminal, лента на журнале работает', async () => {
    vi.useFakeTimers();
    try {
      start({ codexHookGraceMs: 15_000, codexApprovals: async () => true });
      fakes.emitStart(REF);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await service.snapshot(REF)).decisions).toBe('terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('сессии ещё нет в карте работ на старте процесса — таймер доверия взводится, когда она появилась', async () => {
    vi.useFakeTimers();
    try {
      fakes = fakeFeedDeps([]);
      start({ codexHookGraceMs: 15_000, codexApprovals: async () => true });
      fakes.emitStart(REF);
      await vi.advanceTimersByTimeAsync(1_000);
      fakes.setSessions([{ ref: REF, provider: 'codex' }]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await service.snapshot(REF)).decisions).toBe('terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('настройка codexApprovals выключена — таймера доверия нет, decisions не задан', async () => {
    vi.useFakeTimers();
    try {
      start({ codexHookGraceMs: 15_000, codexApprovals: async () => false });
      fakes.emitStart(REF);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await service.snapshot(REF)).decisions).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('хук пришёл раньше срока — терминалом сессия не становится', async () => {
    vi.useFakeTimers();
    try {
      start({ codexHookGraceMs: 15_000, codexApprovals: async () => true });
      fakes.emitStart(REF);
      await vi.advanceTimersByTimeAsync(1_000);
      send(hook('SessionStart', { source: 'startup' }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await service.snapshot(REF)).decisions).toBe('window');
    } finally {
      vi.useRealTimers();
    }
  });

  it('удержание PermissionRequest Codex — не дольше 590 с, потом карточка stale и пустой ответ', async () => {
    vi.useFakeTimers();
    try {
      start({ codexApprovals: async () => true });
      send(hook('SessionStart'));
      const held = send(permissionBash('ls'));
      vi.advanceTimersByTime(590_000);
      expect(held.responses).toEqual([{}]);
      const card = (await service.snapshot(REF)).items.find((entry) => entry.kind === 'permission');
      expect(card).toMatchObject({ state: 'stale' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('хук без карточки получает пустой ответ сразу', () => {
    start({ codexApprovals: async () => true });
    const request = send(hook('SessionStart'));
    expect(request.responses).toEqual([{}]);
  });

  it('Codex закрыл запрос сам — карточка elsewhere', async () => {
    start({ codexApprovals: async () => true });
    const request = send(permissionBash('ls'));
    request.abandon();
    const card = (await service.snapshot(REF)).items.find((entry) => entry.kind === 'permission');
    expect(card).toMatchObject({ state: 'elsewhere' });
  });
});
