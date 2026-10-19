import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantProposal, AssistantSettings, AssistantState } from '@parley/protocol';
import { createAssistantBridge, type BridgeDeps } from './assistant-bridge.js';
import { T } from './texts.js';

const BASE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };
const SETTINGS: AssistantSettings = { enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: null };
const CARD = { id: 'p-1', action: 'message', kind: 'note' } as unknown as AssistantProposal;

let state: AssistantState;
let settings: AssistantSettings | null;
let listener: ((next: AssistantState) => void) | null;
let cards: boolean;
let service: {
  ask: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
};
let deps: BridgeDeps;
const sendText = vi.fn();
const sendCard = vi.fn();
const closeCard = vi.fn();
const typing = vi.fn();

const emit = (patch: Partial<AssistantState>): void => {
  state = { ...state, ...patch };
  listener?.(state);
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  state = BASE;
  settings = SETTINGS;
  listener = null;
  cards = false;
  for (const fn of [sendText, sendCard, closeCard, typing]) fn.mockReset().mockResolvedValue(undefined);
  service = {
    ask: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn().mockResolvedValue({ applied: true, error: null }),
  };
  deps = {
    assistant: {
      ...service,
      onState: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      settings: () => settings,
      state: () => state,
    } as unknown as BridgeDeps['assistant'],
    sendText,
    sendCard,
    closeCard,
    typing,
    cardsToggle: () => cards,
    log: () => {},
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('assistant-bridge: вход', () => {
  it('текст → ask с настройками из зеркала и origin telegram', async () => {
    const bridge = createAssistantBridge(deps);
    await bridge.onText('hello');
    expect(service.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', provider: 'claude', model: null, language: 'en', askId: expect.any(String) }), 'telegram');
  });

  it('помощник выключен — assistantOff без ask', async () => {
    settings = { ...SETTINGS, enabled: false };
    await createAssistantBridge(deps).onText('hello');
    expect(sendText).toHaveBeenCalledWith(T.assistantOff);
    expect(service.ask).not.toHaveBeenCalled();
  });

  it('4001 знак — tooLong без ask; ровно 4000 проходит', async () => {
    const bridge = createAssistantBridge(deps);
    await bridge.onText('x'.repeat(4001));
    expect(sendText).toHaveBeenCalledWith(T.tooLong);
    expect(service.ask).not.toHaveBeenCalled();
    await bridge.onText('x'.repeat(4000));
    expect(service.ask).toHaveBeenCalledTimes(1);
  });

  it('новый текст во время хода: cancel, затем ask; оборванный ответ в чат не уходит', async () => {
    const bridge = createAssistantBridge(deps);
    emit({ phase: 'answering', origin: 'telegram', answer: 'half', turn: 1 });
    service.cancel.mockImplementation(() => emit({ phase: 'idle' }));
    await bridge.onText('again');
    expect(service.cancel.mock.invocationCallOrder[0]).toBeLessThan(service.ask.mock.invocationCallOrder[0]!);
    await flush();
    expect(sendText).not.toHaveBeenCalled();
    emit({ phase: 'thinking', origin: 'telegram', answer: '', turn: 2 });
    emit({ phase: 'idle', answer: 'fresh', turn: 2 });
    emit({ phase: 'idle', answer: 'fresh', turn: 2 });
    await flush();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('fresh');
  });

  it('отмена с задержкой публикации: оборванный ответ отменённого хода не уходит', async () => {
    const bridge = createAssistantBridge(deps);
    emit({ phase: 'answering', origin: 'telegram', answer: 'half', turn: 1 });
    await bridge.onText('again');
    emit({ phase: 'idle', turn: 1 });
    await flush();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('команды: status спрашивает «What is going on?», new — reset и подтверждение', async () => {
    const bridge = createAssistantBridge(deps);
    await bridge.onCommand('status');
    expect(service.ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'What is going on?' }), 'telegram');
    await bridge.onCommand('new');
    expect(service.reset).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(T.newConversation);
  });

  it('callback: applied → пустой тост, applied:false → noLongerCurrent', async () => {
    const bridge = createAssistantBridge(deps);
    expect(await bridge.onCallback('p-1', 'send')).toBe('');
    expect(service.decide).toHaveBeenCalledWith('p-1', 'send');
    service.decide.mockResolvedValue({ applied: false, error: 'x' });
    expect(await bridge.onCallback('p-1', 'cancel')).toBe(T.noLongerCurrent);
  });
});

describe('assistant-bridge: выход', () => {
  it('ход telegram: typing сразу и раз в 4 с, пока идёт; после конца — стоп', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'thinking', origin: 'telegram' });
    expect(typing).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(typing).toHaveBeenCalledTimes(2);
    emit({ phase: 'idle', answer: 'ok' });
    vi.advanceTimersByTime(12_000);
    expect(typing).toHaveBeenCalledTimes(2);
  });

  it('конец хода telegram — sendText один раз с ответом', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'thinking', origin: 'telegram' });
    emit({ phase: 'answering', answer: 'part' });
    emit({ phase: 'idle', answer: 'Three agents are working.' });
    emit({ phase: 'idle', answer: 'Three agents are working.' });
    await flush();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('Three agents are working.');
  });

  it('ход telegram не дошёл до работы (сбой запуска): ошибка уходит один раз', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'offline', origin: 'telegram', error: 'Claude CLI is not installed', turn: 3 });
    emit({ phase: 'offline', origin: 'telegram', error: 'Claude CLI is not installed', turn: 3 });
    await flush();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('Claude CLI is not installed');
  });

  it('конец хода без ответа — уходит ошибка; ход reminder тоже уходит', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'thinking', origin: 'reminder' });
    emit({ phase: 'error', answer: '', error: 'Something went wrong' });
    await flush();
    expect(sendText).toHaveBeenCalledWith('Something went wrong');
    expect(typing).not.toHaveBeenCalled();
  });

  it('конец хода island — ничего не уходит', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'thinking', origin: 'island' });
    emit({ phase: 'idle', answer: 'hi' });
    await flush();
    expect(sendText).not.toHaveBeenCalled();
    expect(typing).not.toHaveBeenCalled();
  });

  it('карточка: при telegram — sendCard; при island без cardsToggle — нет; с cardsToggle — да; повтор того же id — нет', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'tool', origin: 'telegram', proposal: CARD });
    emit({ phase: 'awaiting-confirm', proposal: CARD });
    expect(sendCard).toHaveBeenCalledTimes(1);
    emit({ phase: 'idle', proposal: null });
    const other = { ...CARD, id: 'p-2' } as AssistantProposal;
    emit({ phase: 'tool', origin: 'island', proposal: other });
    expect(sendCard).toHaveBeenCalledTimes(1);
    cards = true;
    const third = { ...CARD, id: 'p-3' } as AssistantProposal;
    emit({ proposal: third });
    expect(sendCard).toHaveBeenCalledTimes(2);
    expect(sendCard).toHaveBeenLastCalledWith(third);
  });

  it('новая карточка вытеснила нашу — старая закрывается с current', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'awaiting-confirm', origin: 'telegram', proposal: CARD });
    const next = { ...CARD, id: 'p-2' } as AssistantProposal;
    emit({ proposal: next });
    await flush();
    expect(closeCard).toHaveBeenCalledWith('p-1', 'current');
    expect(sendCard).toHaveBeenLastCalledWith(next);
  });

  it('карточка исчезла с outcome sent — closeCard; чужая карточка не закрывается', async () => {
    createAssistantBridge(deps);
    emit({ phase: 'awaiting-confirm', origin: 'telegram', proposal: CARD });
    emit({ phase: 'idle', proposal: null, outcome: 'sent' });
    await flush();
    expect(closeCard).toHaveBeenCalledWith('p-1', 'sent');
    emit({ phase: 'awaiting-confirm', origin: 'island', proposal: { ...CARD, id: 'p-9' } as AssistantProposal });
    emit({ phase: 'idle', proposal: null, outcome: 'cancelled' });
    expect(closeCard).toHaveBeenCalledTimes(1);
  });

  it('stop снимает слушателя и таймер typing', () => {
    const bridge = createAssistantBridge(deps);
    emit({ phase: 'thinking', origin: 'telegram' });
    bridge.stop();
    expect(listener).toBeNull();
    vi.advanceTimersByTime(12_000);
    expect(typing).toHaveBeenCalledTimes(1);
  });
});
