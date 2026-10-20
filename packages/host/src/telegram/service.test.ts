/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, telegramBotId, telegramTokenFingerprint } from '@parley/core';
import type { FeedCard, FeedItem, ParleyConfig, WorkEntry } from '@parley/core';
import type { AssistantProposal, AssistantSettings, AssistantState, SessionRef, WorksSnapshot } from '@parley/protocol';
import type { Client } from '../client.js';
import { HostError } from '../errors.js';
import { createTelegramService } from './service.js';
import type { TelegramService, TelegramServiceDeps } from './service.js';
import { T } from './texts.js';

const voiceMock = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('./voice.js', () => ({ createVoiceTranscriber: () => ({ transcribe: voiceMock.transcribe }) }));

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CHAT = 5001;
const USER = 7001;
const REF: SessionRef = { projectPath: '/p/my_harnas', workId: 'w-01', sessionId: 's-01' };
const WHERE = 'Parley · my_harnas';
const SETTINGS: AssistantSettings = { enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: null };
const IDLE_STATE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };
const AT = '2026-10-20T10:00:00Z';
const PROPOSAL = { id: 'p1', target: 'Backend', where: WHERE, text: 'run the tests', wake: false } as unknown as AssistantProposal;

const PERMISSION = {
  kind: 'permission', id: 'c1', cardId: 'c1', at: AT, state: 'pending', toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [{ type: 'addRules' }], notified: false,
} as unknown as FeedCard;
const QUESTION = {
  kind: 'question', id: 'c2', cardId: 'c2', at: AT, state: 'pending', toolUseId: 't2', toolName: 'AskUserQuestion', toolInput: {},
  questions: [
    { question: 'Which db?', header: null, options: [{ label: 'PG', description: null }, { label: 'SQLite', description: null }], multiSelect: false },
    { question: 'Which ORM?', header: null, options: [{ label: 'Drizzle', description: null }], multiSelect: false },
  ],
} as unknown as FeedCard;

interface Call {
  method: string;
  params: any;
}
type Reply = { status?: number; body: unknown } | undefined;

let home = '';
let journal: Call[];
let replies: Record<string, (params: any, count: number) => Reply>;
let queue: unknown[][];
let waiter: ((updates: unknown[]) => void) | null;
let sendGate: Promise<void> | null;
let openSendGate: () => void;
let snapshotGate: Promise<void> | null;
let openSnapshotGate: () => void;
let conflictMode: boolean;
let outId: number;
let lastOutId: number;
let inId: number;
let updateId: number;
let cfg: ParleyConfig;
let secretValue: string | null;
let snapshot: WorksSnapshot;
let live: Record<string, string>;
let feedItems: FeedItem[];
let feedTerminal: boolean;
let worksListener: ((next: WorksSnapshot, previous: WorksSnapshot) => void) | null;
let activityListener: ((ref: SessionRef, value: any) => void) | null;
let feedClient: Client | null;
let logs: string[];
let service: TelegramService;
let host: { broadcast: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn>; log: any };
let feed: { snapshot: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
let assistant: { ask: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; [key: string]: unknown };
let assistantListener: ((next: AssistantState) => void) | null;
let sendLetter: ReturnType<typeof vi.fn>;
let resolveRoomProposal: ReturnType<typeof vi.fn>;
let secret: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };

const respond = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const method = String(input).split('/').pop() ?? '';
  const params = JSON.parse(String(init?.body ?? '{}'));
  journal.push({ method, params });
  if (method === 'getUpdates') {
    if (params.offset === -1) return respond({ ok: true, result: [] });
    if (conflictMode) return respond({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 409);
    const next = queue.shift();
    if (next !== undefined) return respond({ ok: true, result: next });
    return new Promise<Response>((resolve, reject) => {
      waiter = (updates) => resolve(respond({ ok: true, result: updates }));
      init?.signal?.addEventListener('abort', () => {
        waiter = null;
        reject(new Error('aborted'));
      });
    });
  }
  if (method === 'sendMessage' && sendGate !== null) await sendGate;
  const count = journal.filter((call) => call.method === method).length;
  const custom = replies[method]?.(params, count);
  if (custom !== undefined) return respond(custom.body, custom.status ?? 200);
  if (method === 'sendMessage') {
    lastOutId = outId;
    return respond({ ok: true, result: { message_id: outId++ } });
  }
  return respond({ ok: true, result: method === 'getMe' ? { id: 123456789, username: 'parley_bot' } : true });
}) as typeof fetch;

const gateSends = (): void => {
  sendGate = new Promise<void>((resolve) => (openSendGate = resolve));
};
const ungateSends = (): void => {
  sendGate = null;
  openSendGate();
};
const gateSnapshot = (): void => {
  snapshotGate = new Promise<void>((resolve) => (openSnapshotGate = resolve));
};
const ungateSnapshot = (): void => {
  snapshotGate = null;
  openSnapshotGate();
};

const push = (updates: unknown[]): void => {
  if (waiter !== null) {
    const resolve = waiter;
    waiter = null;
    resolve(updates);
  } else queue.push(updates);
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(20);
};

const textUpdate = (text: string, extra: Record<string, unknown> = {}): unknown => ({
  update_id: updateId++,
  message: { message_id: inId++, date: 0, chat: { id: CHAT, type: 'private' }, from: { id: USER }, text, ...extra },
});
const tap = (messageId: number, data: string, from = USER): unknown => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: { id: from }, message: { message_id: messageId, chat: { id: CHAT, type: 'private' } }, data },
});

const sent = (): Call[] => journal.filter((call) => call.method === 'sendMessage');
const edits = (): Call[] => journal.filter((call) => call.method === 'editMessageText');
const calls = (method: string): Call[] => journal.filter((call) => call.method === method);
const buttons = (call: Call): Array<{ text: string; callback_data: string }> => (call.params.reply_markup?.inline_keyboard ?? []).flat();
const shortIdOf = (call: Call): string => buttons(call)[0]!.callback_data.split(':')[1]!;

const entry = (over: Record<string, unknown> = {}): WorkEntry =>
  ({
    projectPath: '/p/my_harnas',
    map: {
      work: { id: 'w-01', title: 'Parley' },
      sessions: [{ id: 's-01', label: 'Backend', lifecycle: 'active', result: null }],
      messages: [],
      rooms: [],
      ...over,
    },
  }) as unknown as WorkEntry;
const snap = (over: Record<string, unknown> = {}): WorksSnapshot => ({ entries: [entry(over)], branches: {} }) as unknown as WorksSnapshot;
const letter = (): unknown => ({ id: 'm-01', roomId: null, from: 's-01', to: ['human'], at: AT, text: 'hello', kind: 'note', readBy: {} });
const decisionRoom = (): unknown => ({ id: 'r-01', title: 'Auth', members: ['s-01'], proposal: { id: 'p-01', from: 's-01', text: 'ship it', rev: 0, at: AT } });

const setActivity = (value: string): void => {
  live['s-01'] = value;
  activityListener?.(REF, { activity: { activity: value }, metrics: null });
};
const emitAssistant = (patch: Partial<AssistantState>): void => assistantListener?.({ ...IDLE_STATE, origin: 'telegram', ...patch });
const setWorks = (next: WorksSnapshot): void => {
  const previous = snapshot;
  snapshot = next;
  worksListener?.(next, previous);
};

function make(): TelegramService {
  return createTelegramService({
    home,
    host,
    works: { snapshot: () => snapshot, onChange: (listener: any) => ((worksListener = listener), () => (worksListener = null)) },
    activity: {
      get: (ref: SessionRef) => (live[ref.sessionId] === undefined ? undefined : { activity: { activity: live[ref.sessionId] }, metrics: null }),
      onChange: (listener: any) => ((activityListener = listener), () => (activityListener = null)),
    },
    feed,
    assistant,
    sendLetter,
    resolveRoomProposal,
    config: async () => cfg,
    secret,
    fetch: fakeFetch,
    engine: null,
    macName: 'MacBook',
    log: (line: string) => logs.push(line),
  } as unknown as TelegramServiceDeps);
}

/** Токен задан, владелец привязан, журнал запросов очищен. */
async function bootLinked(): Promise<void> {
  service = make();
  await service.start();
  await service.setToken(TOKEN);
  const link = await service.link();
  push([textUpdate(`/start ${link.code}`, { from: { id: USER, username: 'kalmbik' } })]);
  await settle();
  journal.length = 0;
}

/** Сессия переходит в «нужен ты» с ждущей карточкой ленты; возвращает отправленное сообщение. */
async function blockWith(card: FeedCard): Promise<Call> {
  feedItems = [card];
  setActivity('blocked');
  await settle();
  return sent().at(-1)!;
}

beforeEach(async () => {
  vi.useFakeTimers();
  home = await mkdtemp(path.join(tmpdir(), 'tg-service-'));
  journal = [];
  replies = {};
  queue = [];
  waiter = null;
  sendGate = null;
  snapshotGate = null;
  conflictMode = false;
  outId = 100;
  lastOutId = 0;
  inId = 9000;
  updateId = 1;
  cfg = { ...DEFAULT_CONFIG };
  secretValue = null;
  snapshot = snap();
  live = { 's-01': 'working' };
  feedItems = [];
  feedTerminal = false;
  worksListener = null;
  activityListener = null;
  feedClient = null;
  assistantListener = null;
  voiceMock.transcribe.mockReset();
  logs = [];
  host = { broadcast: vi.fn(), hold: vi.fn(), log: { info: () => {}, warn: () => {}, error: () => {} } };
  feed = {
    snapshot: vi.fn(async () => {
      if (snapshotGate !== null) await snapshotGate;
      return { items: feedItems, revision: 1, schemaVersion: 1, mode: null, ...(feedTerminal ? { decisions: 'terminal' } : {}) };
    }),
    decide: vi.fn(() => ({ applied: true, state: 'allowed' })),
    subscribe: vi.fn((_ref: SessionRef, client: Client) => {
      feedClient = client;
    }),
    unsubscribe: vi.fn(),
  };
  assistant = {
    ask: vi.fn(async () => undefined),
    cancel: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn(async () => ({ applied: true, error: null })),
    onState: (listener: (next: AssistantState) => void) => {
      assistantListener = listener;
      return () => undefined;
    },
    settings: () => SETTINGS,
    state: () => IDLE_STATE,
  };
  sendLetter = vi.fn(async () => 'm-9');
  resolveRoomProposal = vi.fn(async () => 'm-8');
  secret = {
    read: vi.fn(async () => secretValue),
    write: vi.fn(async (token: string) => {
      secretValue = token;
      return '••••AAAA';
    }),
    clear: vi.fn(async () => {
      secretValue = null;
    }),
  };
});

afterEach(async () => {
  await service?.stop();
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('createTelegramService: включение и токен', () => {
  it('выключенный канал не делает запросов и не держит хост; включение через configChanged начинает опрос с offset -1', async () => {
    cfg.telegramEnabled = false;
    secretValue = TOKEN;
    service = make();
    await service.start();
    await settle();
    expect(journal).toEqual([]);
    expect(host.hold).not.toHaveBeenCalled();

    service.configChanged({ ...cfg, telegramEnabled: true });
    await settle();
    expect(calls('getUpdates')[0]?.params.offset).toBe(-1);
  });

  it('setToken с неверной формой — bad_request «Token looks wrong»', async () => {
    service = make();
    await service.start();
    await expect(service.setToken('bad')).rejects.toMatchObject({ code: 'bad_request', message: 'Token looks wrong' });
    expect(journal).toEqual([]);
  });

  it('getMe 401 — bad_request «Telegram rejected the token», секрет не записан', async () => {
    replies.getMe = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    service = make();
    await service.start();
    await expect(service.setToken(TOKEN)).rejects.toMatchObject({ code: 'bad_request', message: 'Telegram rejected the token' });
    expect(secret.write).not.toHaveBeenCalled();
    expect(service.status().token).toBe('none');
  });

  it('удачный setToken пишет секрет, ставит статус token set и имя бота', async () => {
    service = make();
    await service.start();
    const result = await service.setToken(TOKEN);
    expect(result).toEqual({ botUsername: 'parley_bot', hint: '••••AAAA' });
    expect(secret.write).toHaveBeenCalledWith(TOKEN);
    expect(service.status()).toMatchObject({ token: 'set', botUsername: 'parley_bot', hint: '••••AAAA', enabled: true });
    expect(host.broadcast).toHaveBeenCalledWith('telegram.changed', expect.objectContaining({ token: 'set' }));
  });

  it('после start без токена configChanged с теми же настройками канала не шлёт telegram.changed', async () => {
    service = make();
    await service.start();
    service.configChanged({ ...cfg, messageRate: 5 });
    expect(host.broadcast).not.toHaveBeenCalled();
  });

  it('включение telegramEnabled после выключенного шлёт telegram.changed', async () => {
    cfg.telegramEnabled = false;
    service = make();
    await service.start();
    service.configChanged({ ...cfg, telegramEnabled: true });
    expect(host.broadcast).toHaveBeenCalledWith('telegram.changed', expect.objectContaining({ enabled: true }));
  });

  it('configChanged без изменения состояния канала не шлёт telegram.changed', async () => {
    await bootLinked();
    host.broadcast.mockClear();
    service.configChanged({ ...cfg, messageRate: 5 });
    service.configChanged({ ...cfg });
    expect(host.broadcast).not.toHaveBeenCalled();
  });

  it('clearToken стирает секрет и state.json', async () => {
    service = make();
    await service.start();
    await service.setToken(TOKEN);
    const file = path.join(home, 'telegram', 'state.json');
    expect(existsSync(file)).toBe(true);

    await service.clearToken();
    expect(secret.clear).toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    expect(service.status().token).toBe('none');
  });
});

describe('createTelegramService: привязка', () => {
  it('link без токена — conflict «Set the bot token first»', async () => {
    service = make();
    await service.start();
    await expect(service.link()).rejects.toMatchObject({ code: 'conflict', message: 'Set the bot token first' });
  });

  it('link при уже привязанном владельце — conflict «Unlink first», после unlink снова можно', async () => {
    await bootLinked();
    await expect(service.link()).rejects.toMatchObject({ code: 'conflict', message: 'Unlink first' });

    await service.unlink();
    await expect(service.link()).resolves.toMatchObject({ code: expect.any(String) });
  });

  it('/start с кодом от чужого from: владелец записан, команды выставлены, ответ «Linked», хост удержан', async () => {
    service = make();
    await service.start();
    await service.setToken(TOKEN);
    const link = await service.link();
    expect(link.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
    expect(link.deepLink).toBe(`https://t.me/parley_bot?start=${link.code}`);

    push([textUpdate(`/start ${link.code}`, { from: { id: USER, username: 'kalmbik' } })]);
    await settle();
    expect(calls('setMyCommands')[0]?.params.commands.map((c: any) => c.command)).toEqual(['status', 'new', 'help']);
    expect(sent()[0]?.params.text).toBe(T.linked('MacBook'));
    expect(service.status().owner).toMatchObject({ username: 'kalmbik' });
    expect(service.status().pendingLink).toBeNull();
    expect(host.hold).toHaveBeenCalledWith('telegram', true);
  });

  it('пять неверных кодов снимают pendingLink, ответов нет', async () => {
    service = make();
    await service.start();
    await service.setToken(TOKEN);
    await service.link();
    for (let i = 0; i < 5; i += 1) push([textUpdate('/start WRONG-CODE')]);
    await settle();
    expect(sent()).toEqual([]);
    expect(service.status().pendingLink).toBeNull();
    expect(service.status().owner).toBeNull();
  });

  it('чужое сообщение после привязки молчит; чужое нажатие получает только answerCallbackQuery', async () => {
    await bootLinked();
    push([{ update_id: updateId++, message: { message_id: 1, date: 0, chat: { id: 4242, type: 'private' }, from: { id: 999 }, text: 'hi' } }]);
    push([tap(5, 'pc1:abc:a', 999)]);
    await settle();
    expect(sent()).toEqual([]);
    expect(feed.decide).not.toHaveBeenCalled();
    expect(assistant.ask).not.toHaveBeenCalled();
    expect(calls('answerCallbackQuery')).toHaveLength(1);
  });
});

describe('createTelegramService: карточки ленты', () => {
  it('blocked и разрешение в ленте — сообщение с тремя кнопками', async () => {
    await bootLinked();
    const message = await blockWith(PERMISSION);
    expect(message.params.text).toContain('Backend');
    expect(message.params.parse_mode).toBe('HTML');
    expect(buttons(message)).toHaveLength(3);
    expect(feed.subscribe).toHaveBeenCalledWith(REF, expect.anything());
  });

  it('нажатие «Allow» решает карточку и правит сообщение квитанцией без кнопок; повтор — «no longer current»', async () => {
    await bootLinked();
    const message = await blockWith(PERMISSION);
    const data = buttons(message)[0]!.callback_data;

    push([tap(lastOutId, data)]);
    await settle();
    expect(feed.decide).toHaveBeenCalledWith(REF, 'c1', { kind: 'permission', behavior: 'allow' });
    expect(edits()[0]?.params.text).toContain('Allowed');
    expect(edits()[0]?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(feed.unsubscribe).toHaveBeenCalled();

    push([tap(lastOutId, data)]);
    await settle();
    expect(feed.decide).toHaveBeenCalledTimes(1);
    // Честная квитанция остаётся: текст не трогаем, снимаем только кнопки, а человеку отвечаем тостом.
    expect(edits()).toHaveLength(1);
    expect(calls('editMessageReplyMarkup')).toHaveLength(1);
    expect(calls('answerCallbackQuery').at(-1)?.params.text).toBe(T.noLongerCurrent);
  });

  it('decide с applied:false в решённом состоянии закрывает карточку «Answered at your Mac», а не временем нажатия', async () => {
    await bootLinked();
    const message = await blockWith(PERMISSION);
    feed.decide.mockReturnValueOnce({ applied: false, state: 'allowed' });

    push([tap(lastOutId, buttons(message)[1]!.callback_data)]);
    await settle();
    expect(edits()[0]?.params.text).toContain(T.answeredAtMac);
    expect(edits()[0]?.params.text).not.toContain('Allowed at');
  });

  it('decide с applied:false в pending оставляет карточку и отвечает тостом «not ready yet»', async () => {
    await bootLinked();
    const message = await blockWith(PERMISSION);
    feed.decide.mockReturnValueOnce({ applied: false, state: 'pending' });

    push([tap(lastOutId, buttons(message)[0]!.callback_data)]);
    await settle();
    expect(edits()).toEqual([]);
    expect(calls('answerCallbackQuery').at(-1)?.params.text).toBe(T.notReadyYet);

    push([tap(lastOutId, buttons(message)[0]!.callback_data)]);
    await settle();
    expect(edits()[0]?.params.text).toContain('Allowed');
  });

  it('псевдо-клиент: feed.changed с denied закрывает карточку, stale — «expired»', async () => {
    await bootLinked();
    await blockWith(PERMISSION);
    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 2, upsert: [{ ...PERMISSION, state: 'denied' }], removed: [], mode: null } });
    await settle();
    expect(edits()[0]?.params.text).toContain('Denied');
    expect(feed.unsubscribe).toHaveBeenCalled();

    feedItems = [{ ...PERMISSION, cardId: 'c3', id: 'c3' } as FeedCard];
    setActivity('working');
    setActivity('blocked');
    await settle();
    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 3, upsert: [{ ...PERMISSION, cardId: 'c3', id: 'c3', state: 'stale' }], removed: [], mode: null } });
    await settle();
    expect(edits()[1]?.params.text).toContain(T.expired);
  });

  it('вопрос из нескольких частей: decide только после последнего ответа, следующий вопрос — новым сообщением', async () => {
    await bootLinked();
    const first = await blockWith(QUESTION);
    expect(first.params.text).toContain('Which db?');
    const shortId = shortIdOf(first);

    push([tap(lastOutId, `pc1:${shortId}:q0`)]);
    await settle();
    expect(feed.decide).not.toHaveBeenCalled();
    const second = sent().at(-1)!;
    expect(second.params.text).toContain('Which ORM?');

    push([tap(lastOutId, `pc1:${shortId}:q0`)]);
    await settle();
    expect(feed.decide).toHaveBeenCalledTimes(1);
    expect(feed.decide).toHaveBeenCalledWith(REF, 'c2', { kind: 'question', answers: { 'Which db?': 'PG', 'Which ORM?': 'Drizzle' } });
    expect(edits().at(-1)?.params.text).toContain('Answered');
  });

  it('«Other…» просит ответ, следующий текст уходит в feed.decide', async () => {
    await bootLinked();
    const single = { ...QUESTION, questions: [(QUESTION as any).questions[0]] } as FeedCard;
    const message = await blockWith(single);
    const shortId = shortIdOf(message);

    push([tap(lastOutId, `pc1:${shortId}:o`)]);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(T.otherPrompt);
    expect(T.otherPrompt).toContain('/skip');

    push([textUpdate('MySQL')]);
    await settle();
    expect(feed.decide).toHaveBeenCalledWith(REF, 'c2', { kind: 'question', answers: { 'Which db?': 'MySQL' } });
    expect(sent().at(-1)?.params.text).toBe(T.sentAsAnswer('Backend'));
    expect(assistant.ask).not.toHaveBeenCalled();
  });

  it('карточек нет — короткое уведомление «needs you», а Codex без хуков получает карточку без кнопок', async () => {
    await bootLinked();
    feedItems = [{ kind: 'text', id: 'x1', at: AT, messageId: null, text: 'first\nsecond\nthird', streaming: false } as FeedItem];
    setActivity('blocked');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent()[0]?.params.text).toContain(T.needsYou('Backend', WHERE));
    expect(sent()[0]?.params.text).toContain('second\nthird');

    setActivity('working');
    feedTerminal = true;
    feedItems = [{ ...PERMISSION, cardId: 'c5', id: 'c5' } as FeedCard];
    setActivity('blocked');
    await settle();
    expect(sent().at(-1)?.params.reply_markup).toBeUndefined();
    expect(sent().at(-1)?.params.text).toContain(T.waitingAtMac('Backend'));
  });

  it('HTML не разобран (400) — повтор тем же текстом без parse_mode и без тегов', async () => {
    await bootLinked();
    replies.sendMessage = (params) =>
      params.parse_mode === 'HTML' ? { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" } } : undefined;
    await blockWith(PERMISSION);
    const plain = sent().at(-1)!;
    expect(plain.params.parse_mode).toBeUndefined();
    expect(plain.params.text).toContain('Backend');
    expect(plain.params.text).not.toContain('<b>');
  });
});

describe('createTelegramService: комнаты, письма, помощник', () => {
  it('решение ведущего: карточка Accept/Return, «Return…» ждёт заметку, текст уходит в resolveRoomProposal', async () => {
    await bootLinked();
    setWorks(snap({ rooms: [decisionRoom()] }));
    await settle();
    const card = sent().at(-1)!;
    expect(buttons(card)).toHaveLength(2);
    expect(card.params.text).toContain('Auth');
    const shortId = shortIdOf(card);

    push([tap(lastOutId, `pc1:${shortId}:r`)]);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(T.returnNotePrompt('Backend'));
    expect(T.returnNotePrompt('Backend')).toContain('/skip');

    push([textUpdate('please add tests')]);
    await settle();
    expect(resolveRoomProposal).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/p/my_harnas', workId: 'w-01', roomId: 'r-01', proposalId: 'p-01', action: 'return', note: 'please add tests', rev: 0 }),
    );
    expect(edits().at(-1)?.params.text).toContain('Returned');
    expect(sent().at(-1)?.params.text).toBe(T.sentAsNote('Backend'));
    expect(assistant.ask).not.toHaveBeenCalled();
  });

  it('/skip возвращает без заметки', async () => {
    await bootLinked();
    setWorks(snap({ rooms: [decisionRoom()] }));
    await settle();
    push([tap(lastOutId, `pc1:${shortIdOf(sent().at(-1)!)}:r`)]);
    await settle();

    push([textUpdate('/skip')]);
    await settle();
    expect(resolveRoomProposal).toHaveBeenCalledTimes(1);
    expect(resolveRoomProposal.mock.calls[0]?.[0]).toMatchObject({ action: 'return' });
    expect(resolveRoomProposal.mock.calls[0]?.[0]).not.toHaveProperty('note');
  });

  it('Accept при conflict (решение переделали) — квитанция «Revised»', async () => {
    await bootLinked();
    setWorks(snap({ rooms: [decisionRoom()] }));
    await settle();
    const card = sent().at(-1)!;
    resolveRoomProposal.mockRejectedValueOnce(new HostError('conflict', 'proposal changed'));

    push([tap(lastOutId, `pc1:${shortIdOf(card)}:y`)]);
    await settle();
    expect(edits().at(-1)?.params.text).toContain('Revised');
  });

  it('письмо человеку: уведомление и запись в letters; ответ на него уходит sendLetter с реакцией, обычный текст — помощнику', async () => {
    await bootLinked();
    setWorks(snap({ messages: [letter()] }));
    await settle();
    const notice = sent().at(-1)!;
    expect(notice.params.text).toContain(`Letter from Backend in ${WHERE}`);
    const noticeId = lastOutId;

    push([textUpdate('thanks', { reply_to_message: { message_id: noticeId } })]);
    await settle();
    expect(sendLetter).toHaveBeenCalledWith({ projectPath: '/p/my_harnas', workId: 'w-01', roomId: null, to: ['s-01'], text: 'thanks', kind: 'note' });
    expect(calls('setMessageReaction')).toHaveLength(1);

    push([textUpdate('hello assistant')]);
    await settle();
    expect(assistant.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello assistant' }), 'telegram');
  });

  it('telegramMail false — письмо молчит; telegramFinished false — unseen молчит, true — тихое уведомление', async () => {
    cfg.telegramMail = false;
    await bootLinked();
    setWorks(snap({ messages: [letter()] }));
    setActivity('unseen');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toEqual([]);

    service.configChanged({ ...cfg, telegramFinished: true });
    setActivity('working');
    setActivity('unseen');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.params.text).toContain(T.finished('Backend', WHERE));
    expect(sent()[0]?.params.disable_notification).toBe(true);
  });

  it('напоминание при выключенном помощнике доходит до чата', async () => {
    await bootLinked();
    service.reminderWhileOff({ id: 'rem-1', what: 'check CI' });
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(T.reminderOff('rem-1', 'check CI'));
  });
});

describe('createTelegramService: перехват, отвязка, перезапуск', () => {
  it('409 — polling conflict, broadcast, дальше ничего не отправляется; takeOver снова опрашивает с offset -1', async () => {
    await bootLinked();
    conflictMode = true;
    push([]);
    await settle();
    expect(service.status().polling).toBe('conflict');
    expect(host.broadcast).toHaveBeenCalledWith('telegram.changed', expect.objectContaining({ polling: 'conflict' }));
    expect(host.hold).toHaveBeenLastCalledWith('telegram', false);

    setActivity('blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toEqual([]);

    conflictMode = false;
    journal.length = 0;
    await service.takeOver();
    await settle();
    expect(calls('getUpdates')[0]?.params.offset).toBe(-1);
    expect(service.status().polling).toBe('ok');
  });

  it('unlink правит открытые карточки в «Unlinked», снимает удержание и владельца', async () => {
    await bootLinked();
    await blockWith(PERMISSION);

    await service.unlink();
    await settle();
    expect(edits().some((call) => call.params.text.includes('Unlinked'))).toBe(true);
    expect(host.hold).toHaveBeenLastCalledWith('telegram', false);
    expect(service.status().owner).toBeNull();
  });

  it('configChanged(false) останавливает опрос и снимает удержание', async () => {
    await bootLinked();
    service.configChanged({ ...cfg, telegramEnabled: false });
    await settle();
    expect(service.status()).toMatchObject({ enabled: false, polling: 'off' });
    expect(host.hold).toHaveBeenLastCalledWith('telegram', false);
    const before = journal.length;
    setActivity('blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(journal.length).toBe(before);
  });

  it('карточки прошлого запуска закрываются квитанцией «restarted», хост удержан', async () => {
    secretValue = TOKEN;
    mkdirSync(path.join(home, 'telegram'), { recursive: true });
    writeFileSync(
      path.join(home, 'telegram', 'state.json'),
      JSON.stringify({
        version: 1,
        botId: telegramBotId(TOKEN),
        tokenFingerprint: telegramTokenFingerprint(TOKEN),
        botUsername: 'parley_bot',
        owner: { userId: USER, chatId: CHAT, username: null, linkedAt: AT },
        pendingLink: null,
        offset: null,
        seen: [],
        cards: { old1: { kind: 'feed', ref: REF, cardId: 'c9', cardKind: 'permission', sessionName: 'Backend', chatId: CHAT, messageId: 77, at: new Date().toISOString(), question: 0 } },
        letters: {},
      }),
    );
    service = make();
    await service.start();
    await settle();
    expect(edits()[0]?.params).toMatchObject({ chat_id: CHAT, message_id: 77, reply_markup: { inline_keyboard: [] } });
    expect(edits()[0]?.params.text).toContain(T.restarted);
    expect(host.hold).toHaveBeenCalledWith('telegram', true);
  });

  it('токен не попадает ни в одну строку log, даже когда сеть падает с адресом в тексте', async () => {
    await bootLinked();
    replies.sendMessage = () => {
      throw new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
    };
    await blockWith(PERMISSION);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logs.some((line) => line.includes('job dropped'))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('AAAAAAAAAAAAAAAA');
    }
    expect(JSON.stringify(service.status())).not.toContain(TOKEN);
  });
});

describe('createTelegramService: очередь, гонки, отвязка', () => {
  it('409 при карточке в очереди освобождает подписку и повод: после takeOver карточка уходит', async () => {
    await bootLinked();
    gateSends();
    service.reminderWhileOff({ id: 'r1', what: 'x' });
    await settle();
    feedItems = [PERMISSION];
    setActivity('blocked');
    await settle();
    expect(feed.subscribe).toHaveBeenCalled();

    conflictMode = true;
    push([]);
    await settle();
    expect(service.status().polling).toBe('conflict');
    expect(feed.unsubscribe).toHaveBeenCalledWith(REF, expect.anything());

    ungateSends();
    await settle();
    conflictMode = false;
    journal.length = 0;
    await service.takeOver();
    await settle();
    setActivity('working');
    setActivity('blocked');
    await settle();
    expect(sent().some((call) => call.params.reply_markup !== undefined)).toBe(true);
  });

  it('закрытие первой карточки сессии не снимает подписку, пока вторая ещё отправляется', async () => {
    await bootLinked();
    await blockWith(PERMISSION);
    feed.unsubscribe.mockClear();
    gateSends();
    feedItems = [PERMISSION, QUESTION];
    setActivity('working');
    setActivity('blocked');
    await settle();

    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 2, upsert: [{ ...PERMISSION, state: 'denied' }], removed: [], mode: null } });
    await settle();
    expect(feed.unsubscribe).not.toHaveBeenCalled();

    ungateSends();
    await settle();
    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 3, upsert: [{ ...QUESTION, state: 'answered' }], removed: [], mode: null } });
    await settle();
    expect(feed.unsubscribe).toHaveBeenCalledTimes(1);
    expect(edits().at(-1)?.params.text).toContain('Answered');
  });

  it('карточка закрыта событием ленты во время findCard: запись не воскресает, следующий текст идёт помощнику', async () => {
    await bootLinked();
    const single = { ...QUESTION, questions: [(QUESTION as any).questions[0]] } as FeedCard;
    const message = await blockWith(single);
    const shortId = shortIdOf(message);

    gateSnapshot();
    push([tap(lastOutId, `pc1:${shortId}:o`)]);
    await settle();
    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 2, upsert: [{ ...single, state: 'answered' }], removed: [], mode: null } });
    await settle();
    const editsBefore = edits().length;
    const sentBefore = sent().length;

    ungateSnapshot();
    await settle();
    expect(sent()).toHaveLength(sentBefore);
    expect(edits()).toHaveLength(editsBefore);

    push([textUpdate('what now')]);
    await settle();
    expect(assistant.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'what now' }), 'telegram');
  });

  it('unlink: стоявшая в очереди карточка не уходит и не записывается, письма забыты', async () => {
    await bootLinked();
    setWorks(snap({ messages: [letter()] }));
    await settle();
    journal.length = 0;

    gateSends();
    service.reminderWhileOff({ id: 'r1', what: 'x' });
    await settle();
    feedItems = [PERMISSION];
    setActivity('blocked');
    await settle();

    const done = service.unlink();
    ungateSends();
    await settle();
    await done;
    expect(sent().some((call) => call.params.reply_markup !== undefined)).toBe(false);
    expect(sent().map((call) => call.params.text)).toContain(T.unlinked);
    const file = JSON.parse(readFileSync(path.join(home, 'telegram', 'state.json'), 'utf8'));
    expect(file.cards).toEqual({});
    expect(file.letters).toEqual({});
    expect(file.owner).toBeNull();
  });

  it('setToken во время обработки апдейта: устаревший апдейт не двигает offset', async () => {
    await bootLinked();
    let release = (): void => {};
    assistant.ask.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    push([textUpdate('hi')]);
    await settle();

    await service.setToken('987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    release();
    await settle();
    const file = JSON.parse(readFileSync(path.join(home, 'telegram', 'state.json'), 'utf8'));
    expect(file.offset).toBeNull();
  });

  it('HostError из sendLetter становится уведомлением «Could not do that»', async () => {
    await bootLinked();
    setWorks(snap({ messages: [letter()] }));
    await settle();
    const noticeId = lastOutId;
    sendLetter.mockRejectedValueOnce(new HostError('bad_request', 'room is archived'));

    push([textUpdate('thanks', { reply_to_message: { message_id: noticeId } })]);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(T.couldNot('room is archived'));
  });

  it('takeOver пересчитывает базу поводов: письмо, пришедшее во время конфликта, не всплывает', async () => {
    await bootLinked();
    conflictMode = true;
    push([]);
    await settle();
    setWorks(snap({ messages: [letter()] }));
    conflictMode = false;
    await service.takeOver();
    await settle();
    journal.length = 0;

    setWorks(snap({ messages: [letter()], rooms: [] }));
    await settle();
    expect(sent()).toEqual([]);
  });

  it('повторное включение канала закрывает старые карточки квитанцией «no longer current»', async () => {
    await bootLinked();
    await blockWith(PERMISSION);
    journal.length = 0;

    service.configChanged({ ...cfg, telegramEnabled: false });
    service.configChanged({ ...cfg, telegramEnabled: true });
    await settle();
    expect(edits()[0]?.params.text).toContain(T.noLongerCurrent);
    expect(edits()[0]?.params.text).not.toContain(T.restarted);
  });
});

describe('createTelegramService: финальное ревью', () => {
  it('карточка, появившаяся в ленте только к 1500 мс, уходит с кнопками, а уведомление без кнопок не шлётся', async () => {
    await bootLinked();
    setActivity('blocked');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent()).toEqual([]);

    feedItems = [PERMISSION];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent().some((call) => call.params.reply_markup !== undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent().filter((call) => call.params.reply_markup === undefined)).toEqual([]);
  });

  it('второй запрос подряд при том же blocked приходит второй карточкой', async () => {
    await bootLinked();
    await blockWith(PERMISSION);
    feedItems = [PERMISSION, QUESTION];
    setActivity('blocked');
    await settle();
    expect(sent()).toHaveLength(2);
    expect(sent().at(-1)?.params.text).toContain('Which db?');
  });

  it('решение пришло, пока сообщение карточки ещё в очереди: карточка закрывается сразу после отправки', async () => {
    await bootLinked();
    gateSends();
    feedItems = [PERMISSION];
    setActivity('blocked');
    await settle();
    feedClient!.send({ event: 'feed.changed', data: { ref: REF, revision: 2, upsert: [{ ...PERMISSION, state: 'allowed' }], removed: [], mode: null } });
    expect(edits()).toEqual([]);

    ungateSends();
    await settle();
    expect(edits()[0]?.params.text).toContain('Allowed');
    expect(edits()[0]?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(feed.unsubscribe).toHaveBeenCalledWith(REF, expect.anything());
  });

  it('карточка помощника, закрытая до отправки, правится квитанцией сразу после отправки', async () => {
    await bootLinked();
    gateSends();
    emitAssistant({ phase: 'awaiting-confirm', proposal: PROPOSAL });
    await settle();
    emitAssistant({ phase: 'idle', proposal: null, outcome: 'sent' });
    expect(edits()).toEqual([]);

    ungateSends();
    await settle();
    expect(edits()[0]?.params.text).toContain('Sent');
  });

  it('pa1 на чужом сообщении не зовёт assistant.decide, на записанном — зовёт', async () => {
    await bootLinked();
    emitAssistant({ phase: 'awaiting-confirm', proposal: PROPOSAL });
    await settle();
    const recorded = lastOutId;

    push([tap(recorded + 50, 'pa1:p1:send')]);
    await settle();
    expect(assistant.decide).not.toHaveBeenCalled();
    expect(calls('answerCallbackQuery').at(-1)?.params.text).toBe(T.noLongerCurrent);
    expect(calls('editMessageReplyMarkup')[0]?.params.message_id).toBe(recorded + 50);

    push([tap(recorded, 'pa1:p1:send')]);
    await settle();
    expect(assistant.decide).toHaveBeenCalledWith('p1', 'send');
  });

  it('/help не обещает /unlink, называет /new и отвязку на Mac; /start владельца даёт ту же справку', async () => {
    await bootLinked();
    push([textUpdate('/help')]);
    await settle();
    const help = sent().at(-1)?.params.text as string;
    expect(help).toContain('/new');
    expect(help).toContain('Settings → Notifications → Telegram');
    expect(help).not.toContain('/unlink');

    push([textUpdate('/start')]);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(help);
    expect(assistant.ask).not.toHaveBeenCalled();
  });

  it('/skip снимает ожидание «Other…» и говорит об этом, следующий текст идёт помощнику', async () => {
    await bootLinked();
    const single = { ...QUESTION, questions: [(QUESTION as any).questions[0]] } as FeedCard;
    const message = await blockWith(single);
    push([tap(lastOutId, `pc1:${shortIdOf(message)}:o`)]);
    await settle();

    push([textUpdate('/skip')]);
    await settle();
    expect(sent().at(-1)?.params.text).toBe(T.waitCancelled);

    push([textUpdate('what is going on')]);
    await settle();
    expect(feed.decide).not.toHaveBeenCalled();
    expect(assistant.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'what is going on' }), 'telegram');
  });

  it('нажатие кнопки обрабатывается, пока голосовое ещё расшифровывается', async () => {
    await bootLinked();
    const message = await blockWith(PERMISSION);
    let finish: (value: { text: string }) => void = () => {};
    voiceMock.transcribe.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    push([{ update_id: updateId++, message: { message_id: inId++, date: 0, chat: { id: CHAT, type: 'private' }, from: { id: USER }, voice: { file_id: 'f1', duration: 3 } } }]);
    push([tap(lastOutId, buttons(message)[0]!.callback_data)]);
    await settle();
    expect(feed.decide).toHaveBeenCalledTimes(1);

    finish({ text: 'build it' });
    await settle();
    expect(assistant.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'build it' }), 'telegram');
  });

  it('второе нажатие по тому же вопросу, пока следующий вопрос уходит, игнорируется', async () => {
    await bootLinked();
    const message = await blockWith(QUESTION);
    const data = `pc1:${shortIdOf(message)}:q0`;
    gateSends();
    push([tap(lastOutId, data)]);
    push([tap(lastOutId, data)]);
    await settle();
    ungateSends();
    await settle();
    expect(sent().filter((call) => String(call.params.text).includes('Which ORM?'))).toHaveLength(1);
    expect(feed.decide).not.toHaveBeenCalled();
  });

  it('setToken с тем же токеном не перезапускает опрос и не закрывает карточки', async () => {
    await bootLinked();
    await blockWith(PERMISSION);
    journal.length = 0;

    await service.setToken(TOKEN);
    await settle();
    expect(edits()).toEqual([]);
    expect(calls('getUpdates').filter((call) => call.params.offset === -1)).toEqual([]);
    expect(service.status().token).toBe('set');
  });

  it('письмо длиннее лимита уходит с хвостом «truncated», /new закрывает карточку помощника', async () => {
    await bootLinked();
    setWorks(snap({ messages: [{ ...(letter() as object), text: 'x'.repeat(3000) }] }));
    await settle();
    expect(sent().at(-1)?.params.text).toContain('truncated');

    emitAssistant({ phase: 'awaiting-confirm', proposal: PROPOSAL });
    await settle();
    journal.length = 0;
    push([textUpdate('/new')]);
    await settle();
    expect(assistant.reset).toHaveBeenCalled();
    expect(edits()[0]?.params.text).toContain(T.noLongerCurrent);
  });

  it('unlink не ждёт опустошения очереди', async () => {
    await bootLinked();
    gateSends();
    service.reminderWhileOff({ id: 'r1', what: 'x' });
    await settle();
    await service.unlink();
    ungateSends();
    await settle();
    expect(service.status().owner).toBeNull();
  });

  it('тот же токен после остановки опроса (409) снова запускает опрос с offset -1', async () => {
    await bootLinked();
    conflictMode = true;
    push([]);
    await settle();
    expect(service.status().polling).toBe('conflict');

    conflictMode = false;
    journal.length = 0;
    await service.setToken(TOKEN);
    await settle();
    expect(calls('getUpdates')[0]?.params.offset).toBe(-1);
    expect(service.status().polling).toBe('ok');
  });

  it('текст сразу после голосового не обгоняет расшифровку: помощник получает сначала её, потом текст', async () => {
    await bootLinked();
    let finish: (value: { text: string }) => void = () => {};
    voiceMock.transcribe.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    push([{ update_id: updateId++, message: { message_id: inId++, date: 0, chat: { id: CHAT, type: 'private' }, from: { id: USER }, voice: { file_id: 'f1', duration: 3 } } }]);
    push([textUpdate('and then this')]);
    await settle();
    expect(assistant.ask).not.toHaveBeenCalled();

    finish({ text: 'first the voice' });
    await settle();
    expect(assistant.ask.mock.calls.map((call) => (call[0] as { text: string }).text)).toEqual(['first the voice', 'and then this']);
  });
});
