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
