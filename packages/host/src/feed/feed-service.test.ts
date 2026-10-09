/**
 * Служба ленты (план 2026-10-01, Task 2, «Тесты»): снимок и дельты по `revision`, пачка 50 мс,
 * кольцо по числу и байтам, сев из журнала, удержание и снятие хуков, решения окна.
 * Приёмник здесь не нужен: запрос хука — заглушка без HTTP (`hookRequest`).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
import {
  FEED_IMAGE_SWEEP_MS,
  FEED_IMAGE_TTL_MS,
  FEED_IMAGES_PER_CALL,
  parleyHome,
  readJsonlRecords,
} from '@parley/core';
import { FEED_SCHEMA_VERSION } from '@parley/protocol';
import type { EventData } from '@parley/protocol';
import { fakeClient, fakeFeedDeps, hookRequest, REF } from '../../test/feed-fakes.js';
import type { FakeFeedDeps } from '../../test/feed-fakes.js';
import { makePng } from '../../test/png.js';
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
    // Один таймер у службы постоянный — уборка старых картинок; он живёт до stop(), а не до конца сессии.
    const permanent = vi.getTimerCount();
    const client = fakeClient();
    service.subscribe(REF, client);
    send(prompt('go'));
    send(pre('t1', 'Bash', { command: 'ls' }));
    const request = send(permission('Bash', { command: 'ls' }));

    fakes.setSessions([]);

    expect(request.responses).toEqual([{}]);
    expect(vi.getTimerCount()).toBe(permanent);
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

  describe('картинки результатов инструментов (план 2026-10-09)', () => {
    const CAPTION = "Took a screenshot of the current page's viewport.";
    const shotCall = (n: number, id: string, png: Buffer, thread = 'th-main') =>
      item(n, thread, {
        type: 'McpToolCall',
        id,
        server: 'chrome-devtools',
        tool: 'take_screenshot',
        arguments: {},
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: CAPTION },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
        },
      });
    const toolsOf = (items: readonly FeedItem[]) => ofKind(items, 'tool');
    let imagesDir: string;

    beforeEach(async () => {
      imagesDir = path.join(await tempRoot(), 'feed-images');
    });

    it('сев из журнала: McpToolCall со скриншотом — ссылка у вызова, файл на месте, base64 в ленте нет', async () => {
      const png = makePng();
      await writeRollout(file, [
        meta('th-main'),
        started(1),
        userMessage(2, 'um1', 'снимок'),
        shotCall(3, 'exec-1', png),
        complete(4),
      ]);
      start({ imagesDir });

      const snapshot = await service.snapshot(REF);

      const tool = toolsOf(snapshot.items)[0];
      expect(tool).toMatchObject({ toolUseId: 'exec-1', name: 'mcp__chrome-devtools__take_screenshot', status: 'done' });
      expect(tool?.response?.text).toBe(`${CAPTION}\n[image png, 1 KB]`);
      const image = tool?.response?.images?.[0];
      expect(image).toMatchObject({ mime: 'image/png', bytes: png.length });
      expect(path.dirname(image?.path ?? '')).toBe(imagesDir);
      expect(readFileSync(image?.path ?? '').equals(png)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain('iVBOR');
    });

    it('дописанная строка с картинкой приходит дельтой со ссылкой (опрос журнала)', async () => {
      const png = makePng(40, 30, 5);
      await writeRollout(file, [meta('th-main'), started(1)]);
      start({ imagesDir });
      const client = fakeClient();
      service.subscribe(REF, client);
      await service.snapshot(REF);

      await appendRollout(file, [shotCall(2, 'exec-2', png)]);
      fakes.emitLog();

      await vi.waitFor(() => {
        const tools = toolsOf(feedChanged(client).flatMap((delta) => delta.upsert));
        expect(tools[0]?.response?.images).toHaveLength(1);
      });
      const delta = feedChanged(client).flatMap((entry) => entry.upsert);
      const image = toolsOf(delta)[0]?.response?.images?.[0];
      expect(readFileSync(image?.path ?? '').equals(png)).toBe(true);
      expect(JSON.stringify(client.sent)).not.toContain('iVBOR');
    });

    it('агент Codex: в карточке вызов без ссылки, но с пометкой; в снимке агента — со ссылкой', async () => {
      const png = makePng(40, 30, 6);
      await writeRollout(file, [meta('th-main'), started(1), subagent(2, 'th-child', 'started')]);
      const childFile = path.join(dir, 'child.jsonl');
      await writeRollout(childFile, [childMeta('th-child', 'th-main', 1), shotCall(3, 'cc-shot', png, 'th-child')]);
      fakes.setChildLogFile('th-child', childFile);
      start({ imagesDir });
      await service.snapshot(REF);

      await vi.waitFor(async () => {
        const card = (await service.snapshot(REF)).items.find((entry) => entry.kind === 'agent');
        expect(card).toMatchObject({ toolCount: 1 });
      });
      const card = (await service.snapshot(REF)).items.find((entry) => entry.kind === 'agent');
      const nested = card?.kind === 'agent' ? card.children[0] : undefined;
      expect(nested?.response?.text).toBe(`${CAPTION}\n[image png, 1 KB]`);
      expect(nested?.response?.images).toBeUndefined();

      const sub = await service.snapshot(REF, 'th-child');
      const own = toolsOf(sub.items).find((tool) => tool.toolUseId === 'cc-shot');
      expect(own?.response?.images?.[0]?.mime).toBe('image/png');
      // Той же картинки с обоих путей — один файл.
      expect(readdirSync(imagesDir)).toHaveLength(1);
      expect(JSON.stringify(sub)).not.toContain('iVBOR');
    });

    it('один журнал читается снова: снимок агента дважды даёт ссылку оба раза', async () => {
      const png = makePng(40, 30, 7);
      await writeRollout(file, [meta('th-main'), started(1), subagent(2, 'th-child', 'started')]);
      const childFile = path.join(dir, 'child.jsonl');
      await writeRollout(childFile, [childMeta('th-child', 'th-main', 1), shotCall(3, 'cc-shot', png, 'th-child')]);
      fakes.setChildLogFile('th-child', childFile);
      start({ imagesDir });

      const first = await service.snapshot(REF, 'th-child');
      const second = await service.snapshot(REF, 'th-child');

      for (const snapshot of [first, second]) {
        expect(toolsOf(snapshot.items)[0]?.response?.images).toHaveLength(1);
      }
      expect(second.items).toEqual(first.items);
    });
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

  it('PostToolUse со скриншотом в tool_response идёт через тот же обход: файл в imagesDir, хук отвечен', async () => {
    const imagesDir = path.join(await tempRoot(), 'feed-images');
    start({ codexApprovals: async () => true, imagesDir });
    const png = makePng();

    const request = send(
      hook('PostToolUse', {
        tool_name: 'mcp__chrome-devtools__take_screenshot',
        tool_use_id: 'exec-1',
        tool_input: {},
        tool_response: [
          { type: 'text', text: 'Took a screenshot' },
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        ],
      }),
    );

    expect(request.responses).toEqual([{}]);
    expect(readdirSync(imagesDir)).toHaveLength(1);
  });
});

describe('картинки результатов инструментов (план 2026-10-09)', () => {
  const SHOT = 'mcp__chrome-devtools__take_screenshot';
  const MIB = 1024 * 1024;
  const imageBlock = (png: Buffer, mime = 'image/png') => ({
    type: 'image',
    source: { type: 'base64', media_type: mime, data: png.toString('base64') },
  });
  let imagesDir: string;

  beforeEach(async () => {
    imagesDir = path.join(await tempRoot(), 'feed-images');
  });

  const imageFiles = (): string[] => (existsSync(imagesDir) ? readdirSync(imagesDir) : []);
  const toolOf = async (id: string) =>
    ofKind((await service.snapshot(REF)).items, 'tool').find((tool) => tool.toolUseId === id);
  const shot = (id: string, response: unknown) => post(id, SHOT, {}, response);

  describe('хук Claude', () => {
    it('PostToolUse с массивом «текст + картинка»: у вызова ссылка на файл в imagesDir, base64 нет ни в ленте, ни в дельте', async () => {
      const png = makePng();
      start({ imagesDir });
      const client = fakeClient();
      service.subscribe(REF, client);
      send(prompt('сними страницу'));
      send(pre('t1', SHOT, {}));

      const request = send(shot('t1', [{ type: 'text', text: 'Took a screenshot' }, imageBlock(png)]));

      // Запись картинки синхронна: хук отвечен сразу, порядок событий не сдвинулся.
      expect(request.responses).toEqual([{}]);
      const tool = await toolOf('t1');
      expect(tool?.response?.text).toBe('Took a screenshot\n[image png, 1 KB]');
      const image = tool?.response?.images?.[0];
      expect(image).toMatchObject({ mime: 'image/png', bytes: png.length });
      expect(path.dirname(image?.path ?? '')).toBe(imagesDir);
      expect(readFileSync(image?.path ?? '').equals(png)).toBe(true);
      expect(ofKind(feedChanged(client).flatMap((delta) => delta.upsert), 'tool').at(-1)?.response?.images).toHaveLength(1);
      const wire = JSON.stringify([await service.snapshot(REF), client.sent]);
      expect(wire).not.toContain('iVBOR');
      expect(wire).not.toContain(png.toString('base64').slice(0, 40));
    });

    it('Read картинки: объект-картинка прямо в tool_response — тоже ссылка', async () => {
      const png = makePng(40, 30, 3);
      start({ imagesDir });
      send(pre('r1', 'Read', { file_path: '/tmp/a.png' }));

      const picture = {
        type: 'image',
        file: { base64: png.toString('base64'), type: 'image/png', originalSize: png.length },
      };
      send(post('r1', 'Read', { file_path: '/tmp/a.png' }, picture));

      const tool = await toolOf('r1');
      expect(tool?.response?.text).toBe('[image png, 1 KB]');
      expect(tool?.response?.images).toHaveLength(1);
      expect(imageFiles()).toHaveLength(1);
    });

    it('больше шести картинок в результате: ссылок шесть, остальные — пометка, файлов ровно шесть', async () => {
      start({ imagesDir });
      const pngs = Array.from({ length: FEED_IMAGES_PER_CALL + 2 }, (_, i) => makePng(40, 30, i + 1));
      send(pre('t1', SHOT, {}));

      send(shot('t1', pngs.map((png) => imageBlock(png))));

      const tool = await toolOf('t1');
      expect(tool?.response?.images).toHaveLength(FEED_IMAGES_PER_CALL);
      expect(tool?.response?.text.split('\n').filter((line) => line === '[image omitted]')).toHaveLength(2);
      expect(imageFiles()).toHaveLength(FEED_IMAGES_PER_CALL);
    });

    it('огромный результат: десять картинок по мегабайту и одна битая — шесть ссылок, остальные пометки, base64 нет, лента жива', async () => {
      start({ imagesDir });
      const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(MIB)]);
      const blocks: unknown[] = Array.from({ length: 10 }, () => imageBlock(jpeg(), 'image/jpeg'));
      // Битая стоит третьей: она места под ссылку не занимает.
      blocks.splice(2, 0, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '!!!not base64!!!' } });
      send(pre('t1', SHOT, {}));

      const request = send(shot('t1', blocks));

      expect(request.responses).toEqual([{}]);
      const tool = await toolOf('t1');
      expect(tool?.response?.images).toHaveLength(FEED_IMAGES_PER_CALL);
      expect(tool?.response?.text.split('\n').filter((line) => line === '[image omitted]')).toHaveLength(5);
      expect(imageFiles()).toHaveLength(FEED_IMAGES_PER_CALL);
      const wire = JSON.stringify(await service.snapshot(REF));
      expect(wire).not.toContain('/9j/');
      expect(wire).not.toContain('!!!not base64!!!');
      send(prompt('дальше'));
      expect((await service.snapshot(REF)).items.at(-1)).toMatchObject({ kind: 'prompt', text: 'дальше' });
    });

    it('хранилище не пишет: картинка — [image omitted], одна строка в консоль с кодом, хук отвечен, лента живёт', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Родитель каталога картинок — обычный файл: создать каталог нельзя.
        const blocker = path.join(await tempRoot(), 'blocker');
        writeFileSync(blocker, 'x');
        start({ imagesDir: path.join(blocker, 'feed-images') });
        const png = makePng();
        send(pre('t1', SHOT, {}));

        const request = send(shot('t1', [{ type: 'text', text: 'Took a screenshot' }, imageBlock(png)]));

        expect(request.responses).toEqual([{}]);
        const tool = await toolOf('t1');
        expect(tool?.response?.text).toBe('Took a screenshot\n[image omitted]');
        expect(tool?.response?.images).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[parley] feed image', 'ENOTDIR');
        expect(JSON.stringify(warn.mock.calls)).not.toContain(png.toString('base64').slice(0, 24));
        send(prompt('дальше'));
        expect((await service.snapshot(REF)).items.at(-1)).toMatchObject({ kind: 'prompt', text: 'дальше' });
      } finally {
        warn.mockRestore();
      }
    });

    it('без imagesDir файлы идут в feed-images дома Parley', async () => {
      const home = path.join(parleyHome(), 'feed-images');
      try {
        start();
        send(pre('t1', SHOT, {}));

        send(shot('t1', [imageBlock(makePng(40, 30, 9))]));

        const image = (await toolOf('t1'))?.response?.images?.[0];
        expect(path.dirname(image?.path ?? '')).toBe(home);
        expect(existsSync(image?.path ?? '')).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('картинка вне результата инструмента (вход вызова) на диск не идёт', async () => {
      start({ imagesDir });
      const input = { content: [imageBlock(makePng())] };

      send(pre('w1', 'Write', input));
      send(post('w1', 'Write', input, 'ok'));

      expect(existsSync(imagesDir)).toBe(false);
    });
  });

  describe('журнал Claude', () => {
    const rec = (value: Record<string, unknown>): string => JSON.stringify({ sessionId: 's', ...value });
    const caption = { type: 'text', text: 'Took a screenshot' };
    const callRecord = rec({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-09T10:00:01.000Z',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: SHOT, input: {} }] },
    });
    /** Результат вызова: картинка и в `toolUseResult`, и в `tool_result.content`, как пишет Claude Code. */
    const resultRecord = (png: Buffer): string =>
      rec({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-10-09T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [caption, imageBlock(png)] }] },
        toolUseResult: [caption, imageBlock(png)],
      });

    async function journal(lines: string[]): Promise<{ root: string; file: string }> {
      const root = path.join(await tempRoot(), 'projects');
      await mkdir(path.join(root, '-proj'), { recursive: true });
      const file = path.join(root, '-proj', 'sess.jsonl');
      await writeFile(file, `${lines.join('\n')}\n`);
      return { root, file };
    }

    it('сев: результат со скриншотом — ссылка, картинка промпта на диск не идёт, а счёт картинок промпта прежний', async () => {
      const png = makePng(40, 30, 1);
      const { root, file } = await journal([
        rec({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-10-09T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'посмотри' }, imageBlock(makePng(40, 30, 2))] },
        }),
        callRecord,
        resultRecord(png),
      ]);
      fakes.setLogFile(file);
      start({ roots: () => [root], imagesDir });

      const snapshot = await service.snapshot(REF);

      expect(ofKind(snapshot.items, 'prompt')[0]).toMatchObject({ text: 'посмотри', images: 1 });
      const tool = ofKind(snapshot.items, 'tool')[0];
      expect(tool?.response?.text).toBe('Took a screenshot\n[image png, 1 KB]');
      const image = tool?.response?.images?.[0];
      expect(readFileSync(image?.path ?? '').equals(png)).toBe(true);
      // Один файл: тот же скриншот в двух местах записи — одно имя, а картинка промпта не сохраняется.
      expect(imageFiles()).toEqual([path.basename(image?.path ?? '')]);
      expect(JSON.stringify(snapshot)).not.toContain('iVBOR');
    });

    it('те же сырые записи читаются дважды (сев и снимок субагента): ссылка оба раза, записи не тронуты', async () => {
      const { root, file } = await journal([]);
      const subagents = path.join(root, '-proj', 'sess', 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(path.join(subagents, 'agent-abc.jsonl'), '');
      const records = [callRecord, resultRecord(makePng(40, 30, 4))].map((line) => JSON.parse(line) as RawRecord);
      const before = structuredClone(records);
      fakes.setLogFile(file);
      start({ roots: () => [root], readRecords: async () => records, imagesDir });

      const main = await service.snapshot(REF);
      const sub = await service.snapshot(REF, 'abc');

      for (const items of [main.items, sub.items]) {
        expect(ofKind(items, 'tool')[0]?.response?.images).toHaveLength(1);
      }
      expect(records).toEqual(before);
      expect(imageFiles()).toHaveLength(1);
    });

    it('хвост журнала читается ради ретраев и прерываний: картинок в нём не ищут, лишних файлов нет', async () => {
      const root = await tempRoot();
      const file = path.join(root, 'log.jsonl');
      await writeFile(file, '');
      fakes.setLogFile(file);
      start({ roots: () => [root], imagesDir });
      send(prompt('go'));
      const startedAt = ofKind((await service.snapshot(REF)).items, 'prompt')[0]?.at ?? '';
      const interrupt = rec({
        type: 'user',
        timestamp: new Date(Date.parse(startedAt) + 1_000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      });

      await writeFile(file, `${resultRecord(makePng(40, 30, 8))}\n${interrupt}\n`);
      fakes.emitLog();

      await vi.waitFor(async () => {
        expect((await service.snapshot(REF)).items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
      });
      expect(imageFiles()).toEqual([]);
    });
  });

  describe('уборка старых файлов', () => {
    const NAME = (letter: string): string => `${letter.repeat(24)}.png`;
    const aged = (file: string, ms: number): void => {
      writeFileSync(file, 'x');
      const time = new Date(Date.now() - ms);
      utimesSync(file, time, time);
    };

    it('при создании службы файлы старше семи суток убираются, свежие остаются', async () => {
      await mkdir(imagesDir, { recursive: true });
      aged(path.join(imagesDir, NAME('a')), FEED_IMAGE_TTL_MS + 60_000);
      aged(path.join(imagesDir, NAME('b')), 60_000);

      start({ imagesDir });

      expect(imageFiles()).toEqual([NAME('b')]);
    });

    it('таймер уборки не держит процесс хоста и взведён на шесть часов', () => {
      const real = globalThis.setInterval;
      const created: Array<{ timer: NodeJS.Timeout; ms: unknown }> = [];
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
        const timer = real(handler, ms);
        created.push({ timer, ms });
        return timer;
      }) as typeof setInterval);
      try {
        start({ imagesDir });
        expect(created.map((entry) => entry.ms)).toEqual([FEED_IMAGE_SWEEP_MS]);
        expect(created[0]?.timer.hasRef()).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('раз в шесть часов уборка повторяется; stop() снимает таймер', async () => {
      vi.useFakeTimers();
      await mkdir(imagesDir, { recursive: true });
      start({ imagesDir });
      aged(path.join(imagesDir, NAME('c')), FEED_IMAGE_TTL_MS + 60_000);

      vi.advanceTimersByTime(FEED_IMAGE_SWEEP_MS - 1);
      expect(imageFiles()).toEqual([NAME('c')]);
      vi.advanceTimersByTime(1);
      expect(imageFiles()).toEqual([]);

      await service.stop();
      expect(vi.getTimerCount()).toBe(0);
      aged(path.join(imagesDir, NAME('d')), FEED_IMAGE_TTL_MS + 60_000);
      vi.advanceTimersByTime(FEED_IMAGE_SWEEP_MS * 2);
      expect(imageFiles()).toEqual([NAME('d')]);
    });
  });
});
