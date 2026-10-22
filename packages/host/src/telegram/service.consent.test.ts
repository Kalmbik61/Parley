/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@parley/core';
import type { ParleyConfig } from '@parley/core';
import type { AssistantSettings, AssistantState, ConsentCard, WorksSnapshot } from '@parley/protocol';
import { createTelegramService } from './service.js';
import type { TelegramService, TelegramServiceDeps } from './service.js';
import { T } from './texts.js';

// Карточка согласия на папку в Telegram (спека 2026-10-21, 4.4). Обвязка — как в service.test.ts, только без ленты и комнат.

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CHAT = 5001;
const USER = 7001;
const SETTINGS: AssistantSettings = { enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: null };
const IDLE_STATE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };

const CARD: ConsentCard = {
  id: 'c-01',
  kind: 'folder-trust',
  folder: '/Users/me/code/my_harnas',
  projectPath: '/Users/me/code/my_harnas',
  requestedBy: { source: 'agent', sessionId: 's-03', label: 'S03 Ruslan' },
  at: '2026-10-21T10:00:00Z',
  state: 'pending',
};

interface Call {
  method: string;
  params: any;
}
type Change = { upsert: ConsentCard[]; removed: string[] };

let home: string;
let journal: Call[];
let queue: unknown[][];
let waiter: ((updates: unknown[]) => void) | null;
let sendGate: Promise<void> | null;
let openSendGate: () => void;
let outId: number;
let inId: number;
let updateId: number;
let cfg: ParleyConfig;
let secretValue: string | null;
let pending: ConsentCard[];
let consentListener: ((change: Change) => void) | null;
let consents: { list: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> };
let service: TelegramService;

const respond = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const method = String(input).split('/').pop() ?? '';
  const params = JSON.parse(String(init?.body ?? '{}'));
  journal.push({ method, params });
  if (method === 'getUpdates') {
    if (params.offset === -1) return respond({ ok: true, result: [] });
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
  if (method === 'sendMessage') return respond({ ok: true, result: { message_id: outId++ } });
  return respond({ ok: true, result: method === 'getMe' ? { id: 123456789, username: 'parley_bot' } : true });
}) as typeof fetch;

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
const tap = (messageId: number, data: string): unknown => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: { id: USER }, message: { message_id: messageId, chat: { id: CHAT, type: 'private' } }, data },
});

const calls = (method: string): Call[] => journal.filter((call) => call.method === method);
const sent = (): Call[] => calls('sendMessage');
const edits = (): Call[] => calls('editMessageText');
const buttons = (call: Call): Array<{ text: string; callback_data: string }> => (call.params.reply_markup?.inline_keyboard ?? []).flat();
const shortIdOf = (call: Call): string => buttons(call)[0]!.callback_data.split(':')[1]!;
/** id сообщения, под которым хост запомнил карточку (счётчик сообщений общий с приветствием при привязке). */
const messageIdOf = (shortId: string): number => stateFile().cards[shortId].messageId;
const stateFile = (): any => JSON.parse(readFileSync(path.join(home, 'telegram', 'state.json'), 'utf8'));
const auditLines = (): any[] =>
  readFileSync(path.join(home, 'telegram', 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const emit = (change: Partial<Change>): void => consentListener?.({ upsert: [], removed: [], ...change });

function make(): TelegramService {
  const works = { snapshot: () => ({ entries: [], branches: {} }) as unknown as WorksSnapshot, onChange: () => () => undefined };
  const activity = { get: () => undefined, onChange: () => () => undefined };
  const assistant = {
    ask: vi.fn(async () => undefined),
    cancel: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn(async () => ({ applied: true, error: null })),
    onState: () => () => undefined,
    settings: () => SETTINGS,
    state: () => IDLE_STATE,
  };
  const secret = {
    read: vi.fn(async () => secretValue),
    write: vi.fn(async (token: string) => {
      secretValue = token;
      return '••••AAAA';
    }),
    clear: vi.fn(async () => {
      secretValue = null;
    }),
  };
  return createTelegramService({
    home,
    host: { broadcast: vi.fn(), hold: vi.fn(), log: { info: () => {}, warn: () => {}, error: () => {} } },
    works,
    activity,
    assistant,
    consents,
    sendLetter: vi.fn(async () => 'm-9'),
    resolveRoomProposal: vi.fn(async () => 'm-8'),
    config: async () => cfg,
    secret,
    fetch: fakeFetch,
    engine: null,
    macName: 'MacBook',
    log: () => undefined,
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

/** Карточка согласия ушла в чат; возвращает отправленное сообщение. */
async function sendCard(card: ConsentCard = CARD): Promise<Call> {
  emit({ upsert: [card] });
  await settle();
  return sent().at(-1)!;
}

beforeEach(async () => {
  vi.useFakeTimers();
  home = await mkdtemp(path.join(tmpdir(), 'tg-consent-'));
  journal = [];
  queue = [];
  waiter = null;
  sendGate = null;
  outId = 100;
  inId = 9000;
  updateId = 1;
  cfg = { ...DEFAULT_CONFIG };
  secretValue = null;
  pending = [];
  consentListener = null;
  consents = {
    list: vi.fn(() => pending),
    decide: vi.fn(async () => ({ applied: true, state: 'allowed' as ConsentCard['state'] })),
    onChange: vi.fn((listener: (change: Change) => void) => {
      consentListener = listener;
      return () => {
        consentListener = null;
      };
    }),
  };
});

afterEach(async () => {
  await service?.stop();
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('telegram: карточка согласия на папку', () => {
  it('событие consents.changed с ждущей карточкой уходит сообщением с Trust/Deny, запись kind consent в state', async () => {
    await bootLinked();
    const message = await sendCard();
    expect(sent()).toHaveLength(1);
    expect(message.params.chat_id).toBe(CHAT);
    expect(message.params.text).toBe('<b>Trust folder for agents?</b>\n/Users/me/code/my_harnas\nRequested by S03 Ruslan (agent) · my_harnas');
    expect(buttons(message).map((b) => b.text)).toEqual(['Trust', 'Deny']);
    const shortId = shortIdOf(message);
    expect(buttons(message).map((b) => b.callback_data)).toEqual([`pc1:${shortId}:a`, `pc1:${shortId}:d`]);
    expect(stateFile().cards[shortId]).toMatchObject({ kind: 'consent', consentId: 'c-01', chatId: CHAT, messageId: expect.any(Number) });
  });

  it('подпись запросившего: без сессии — только источник; без метки — id сессии', async () => {
    await bootLinked();
    await sendCard({ ...CARD, id: 'c-02', requestedBy: { source: 'launch' } });
    expect(sent().at(-1)!.params.text).toContain('Requested by launch · my_harnas');
    await sendCard({ ...CARD, id: 'c-03', requestedBy: { source: 'resume', sessionId: 's-07' } });
    expect(sent().at(-1)!.params.text).toContain('Requested by s-07 (resume) · my_harnas');
  });

  it('карточка с тем же id повторно — одно сообщение', async () => {
    await bootLinked();
    await sendCard();
    emit({ upsert: [CARD] });
    await settle();
    expect(sent()).toHaveLength(1);
  });

  it('переключатель Send cards выключен — карточка не уходит', async () => {
    cfg = { ...cfg, telegramCards: false };
    await bootLinked();
    emit({ upsert: [CARD] });
    await settle();
    expect(sent()).toHaveLength(0);
  });

  it('согласие не ждёт — не уходит; ждущее на старте канала уходит из consents.list()', async () => {
    await bootLinked();
    emit({ upsert: [{ ...CARD, state: 'allowed' }] });
    await settle();
    expect(sent()).toHaveLength(0);

    // Хост перезапущен: владелец уже привязан, карточка ждёт со времён прошлого запуска.
    await service.stop();
    journal.length = 0;
    pending = [CARD];
    service = make();
    await service.start();
    await settle();
    const message = sent().find((call) => call.params.text.startsWith('<b>Trust folder for agents?</b>'));
    expect(message).toBeDefined();
    expect(stateFile().cards[shortIdOf(message!)]).toMatchObject({ kind: 'consent', consentId: 'c-01' });
  });

  it('нажатие Trust: consents.decide(id, allow), карточка правится в «Trusted ✓», аудит записан', async () => {
    await bootLinked();
    const message = await sendCard();
    const shortId = shortIdOf(message);
    const messageIdBefore = messageIdOf(shortId);
    push([tap(messageIdBefore, `pc1:${shortId}:a`)]);
    await settle();
    expect(consents.decide).toHaveBeenCalledWith('c-01', 'allow');
    expect(T.trusted).toBe('Trusted ✓');
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.params).toMatchObject({ chat_id: CHAT, message_id: messageIdBefore, reply_markup: { inline_keyboard: [] } });
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\nTrusted ✓`);
    expect(stateFile().cards[shortId]).toBeUndefined();
    expect(auditLines().at(-1)).toMatchObject({ kind: 'decision', shortId, result: 'allow' });
  });

  it('нажатие Deny: consents.decide(id, deny), квитанция «Denied»', async () => {
    consents.decide.mockResolvedValue({ applied: true, state: 'denied' });
    await bootLinked();
    const message = await sendCard();
    push([tap(messageIdOf(shortIdOf(message)), `pc1:${shortIdOf(message)}:d`)]);
    await settle();
    expect(consents.decide).toHaveBeenCalledWith('c-01', 'deny');
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\nDenied`);
    expect(auditLines().at(-1)).toMatchObject({ kind: 'decision', result: 'deny' });
  });

  it('decide вернул applied:false — карточка закрыта «Already answered on the Mac.»', async () => {
    consents.decide.mockResolvedValue({ applied: false, state: 'allowed' });
    await bootLinked();
    const message = await sendCard();
    push([tap(messageIdOf(shortIdOf(message)), `pc1:${shortIdOf(message)}:a`)]);
    await settle();
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\n${T.answeredAtMac}`);
    expect(auditLines().at(-1)).toMatchObject({ kind: 'decision', result: 'not applied (allowed)' });
  });

  it('событие решения приходит во время нашего decide — квитанция остаётся «Trusted ✓»', async () => {
    consents.decide.mockImplementation(async () => {
      emit({ upsert: [{ ...CARD, state: 'allowed' }] });
      return { applied: true, state: 'allowed' as ConsentCard['state'] };
    });
    await bootLinked();
    const message = await sendCard();
    push([tap(messageIdOf(shortIdOf(message)), `pc1:${shortIdOf(message)}:a`)]);
    await settle();
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\nTrusted ✓`);
  });

  it('removed: карточка закрыта «Already answered on the Mac.», повторное событие ничего не делает', async () => {
    await bootLinked();
    const message = await sendCard();
    emit({ removed: ['c-01'] });
    await settle();
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\n${T.answeredAtMac}`);
    expect(stateFile().cards[shortIdOf(message)]).toBeUndefined();
    emit({ removed: ['c-01'] });
    await settle();
    expect(edits()).toHaveLength(1);
  });

  it('решение в другом месте (upsert не pending) закрывает карточку «Already answered on the Mac.»', async () => {
    await bootLinked();
    const message = await sendCard();
    emit({ upsert: [{ ...CARD, state: 'denied' }] });
    await settle();
    expect(edits()[0]!.params.text).toBe(`${message.params.text}\n\n${T.answeredAtMac}`);
  });

  it('решение пришло, пока сообщение ещё уходит — карточка закрывается, как только уйдёт', async () => {
    await bootLinked();
    sendGate = new Promise<void>((resolve) => (openSendGate = resolve));
    emit({ upsert: [CARD] });
    await settle();
    emit({ removed: ['c-01'] });
    sendGate = null;
    openSendGate();
    await settle();
    expect(sent()).toHaveLength(1);
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.params.text).toContain(T.answeredAtMac);
    expect(Object.keys(stateFile().cards)).toEqual([]);
  });

  it('нажатие по карточке, которой нет в записях (хост перезапущен), — «no longer current», consents.decide не зовётся', async () => {
    await bootLinked();
    push([tap(100, 'pc1:gone1234:a')]);
    await settle();
    expect(consents.decide).not.toHaveBeenCalled();
    expect(calls('answerCallbackQuery').at(-1)!.params.text).toBe(T.noLongerCurrent);
  });
});
