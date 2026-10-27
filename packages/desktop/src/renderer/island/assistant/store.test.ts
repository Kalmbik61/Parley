import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantLanguage } from '@parley/core/assistant';
import type { AssistantState } from '@parley/protocol';
import type { IslandSpeakRequest, IslandSpeechConfig, TtsEngineState } from '../../../shared/island.js';
import type { Speaker } from './speaker.js';
import { assistantBusy, createAssistantStore, HOST_IDLE, SENT_DELAY_MS, SETTLE_MS, SPEAK_FINAL_GRACE_MS, SPEECH_START_TIMEOUT_MS, type AssistantDeps } from './store.js';
import type { VoiceAnalysis, VoiceFrame } from './voice-features.js';

const CONFIG = {
  enabled: true, provider: null, model: null, language: 'ru' as const, hotkey: 'Alt+Space', voice: { enabled: true, model: 'small' as const },
  speech: { enabled: false, voice: 'qwen3-0.6b/serena' as const, gender: 'female' as const, available: false },
};
function setup(over: Partial<AssistantDeps> = {}) {
  const store = createAssistantStore();
  let owned = false;
  const deps: AssistantDeps = {
    call: vi.fn().mockResolvedValue({ ok: true, applied: true, error: null }),
    keyboard: vi.fn((on: boolean) => { owned = on; }),
    ownsKeyboard: () => owned,
    config: () => CONFIG,
    listen: vi.fn(() => null),
    ...over,
  };
  store.getState().configure(deps);
  return { store, deps };
}

describe('стор помощника', () => {
  it('takeKeyboard проверяет общего owner вместо собственного устаревшего флага', () => {
    const { store, deps } = setup({ ownsKeyboard: () => false });
    store.getState().openMode({ listen: false });
    // Общий owner отдал клавиатуру другому режиму без отдельного флага в assistant store.
    store.getState().takeKeyboard();
    expect(deps.keyboard).toHaveBeenCalledTimes(2);
  });
  it('openMode берёт клавиатуру; close отдаёт и отменяет ход', async () => {
    const { store, deps } = setup();
    store.getState().openMode({ listen: false });
    expect(store.getState().open).toBe(true);
    expect(deps.keyboard).toHaveBeenLastCalledWith(true);
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(deps.keyboard).toHaveBeenLastCalledWith(false);
    expect(deps.call).toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('submit — вопрос с настройками провайдера и языка', async () => {
    const { store, deps } = setup();
    await store.getState().submit('  кто работает?  ');
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', { text: 'кто работает?', provider: null, model: null, language: 'ru', askId: expect.any(String) });
  });
  it('«да» при карточке — решение, а не вопрос', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: { id: 'p1', target: 'Auth', where: 'Parley · x', kind: 'note', text: 't', wake: false }, turn: 1 });
    await store.getState().submit('Да, отправляй');
    expect(deps.call).toHaveBeenCalledWith('assistant.decide', { proposalId: 'p1', decision: 'send' });
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
  });
  it('ответ раскрывает свёрнутый вид', () => {
    const { store } = setup();
    store.getState().openMode({ listen: false });
    store.getState().collapse();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', answer: 'a', turn: 1 });
    expect(store.getState().collapsed).toBe(false);
  });
  it('голос выключен — подсказка, а не запись', () => {
    const { store } = setup();
    store.getState().openMode({ listen: true });
    expect(store.getState().input).toBe('idle');
    expect(store.getState().notice).toBe('Voice is off — Settings → Voice');
  });
  it('ошибка решения карточки — на карточке', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'S03 is not running' }) });
    store.getState().applyHost({ ...HOST_IDLE, proposal: { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false }, phase: 'awaiting-confirm', turn: 1 });
    await store.getState().decide('send');
    expect(store.getState().cardError).toBe('S03 is not running');
  });
  it('причина закрытия карточки хостом переживает публикацию без карточки; новая карточка её стирает', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'Already answered' }) });
    const proposal = { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false };
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 1 });
    const deciding = store.getState().decide('send');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: 'cancelled', turn: 1 });
    await deciding;
    expect(store.getState().cardError).toBe('Already answered');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: 'cancelled', turn: 1 });
    expect(store.getState().cardError).toBe('Already answered');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: null, turn: 2 });
    expect(store.getState().cardError).toBeNull();
    store.getState().applyHost({ ...HOST_IDLE, proposal: { ...proposal, id: 'p2' }, phase: 'awaiting-confirm', turn: 2 });
    expect(store.getState().cardError).toBeNull();
  });
  it('ошибка на карточке переживает публикацию с тем же id карточки и стирается новым id', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'The agent is not ready for the answer yet — try again' }) });
    const proposal = { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false };
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 1 });
    await store.getState().decide('send');
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 2 });
    expect(store.getState().cardError).toBe('The agent is not ready for the answer yet — try again');
    store.getState().applyHost({ ...HOST_IDLE, proposal: { ...proposal, id: 'p2' }, phase: 'awaiting-confirm', turn: 3 });
    expect(store.getState().cardError).toBeNull();
  });
  it('микрофон кладёт распознанное в поле, не отправляя; таймер выставлен и сброшен', async () => {
    const result = Promise.resolve({ text: 'hello' });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().toggleListening();
    expect(store.getState().input).toBe('listening');
    expect(store.getState().listenStartedAt).not.toBeNull();
    await result;
    await Promise.resolve();
    expect(store.getState().draft).toBe('hello');
    expect(store.getState().listenStartedAt).toBeNull();
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
  });
  it('вопрос виден сразу (sending) и уходит с askId; снимается, когда хост вернёт этот askId', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 4, askId: null, instance: 'h1' });
    await store.getState().submit('кто работает?');
    const sending = store.getState().sending!;
    expect(sending).toMatchObject({ text: 'кто работает?', turn: 4, instance: 'h1' });
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ askId: sending.id }));
    store.getState().applyHost({ ...HOST_IDLE, outcome: 'sent', turn: 5, askId: 'other', instance: 'h1' });
    expect(store.getState().sending).not.toBeNull();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', question: 'кто работает?', turn: 6, askId: sending.id, instance: 'h1' });
    expect(store.getState().sending).toBeNull();
  });
  it('старый хост askId не шлёт — принятие по смене номера хода', async () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 4 });
    await store.getState().submit('кто работает?');
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 5 });
    expect(store.getState().sending).toBeNull();
  });
  it('хост перезапустился, пока вопрос был в пути, — он и очередь в поле по порядку, подсказка, ничего не уходит само', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 0, askId: null, instance: 'h1' });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    store.getState().applyHost({ ...HOST_IDLE, turn: 0, askId: null, instance: 'h2' });
    expect(store.getState()).toMatchObject({ sending: null, queue: [], draft: 'первое второе', notice: 'Not sent — press Enter to try again' });
    expect(deps.call).toHaveBeenCalledTimes(1);
  });
  it('id процесса хоста узнаётся с первым состоянием, если вопрос ушёл раньше', async () => {
    const { store } = setup();
    await store.getState().submit('кто работает?');
    store.getState().applyHost({ ...HOST_IDLE, askId: null, instance: 'h1' });
    expect(store.getState().sending).toMatchObject({ instance: 'h1' });
  });
  it('во время хода сообщения ждут в очереди и уходят одним ходом, когда он кончится; ход не перебивают', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    expect(deps.call).not.toHaveBeenCalled();
    expect(store.getState().queue.map((item) => item.text)).toEqual(['первое', 'второе']);
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).toHaveBeenCalledTimes(1);
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'первое\n\nвторое' }));
    expect(store.getState().queue).toEqual([]);
  });
  it('пока вопрос в пути, следующий ждёт в очереди', async () => {
    const { store, deps } = setup();
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    expect(deps.call).toHaveBeenCalledTimes(1);
    expect(store.getState().queue.map((item) => item.text)).toEqual(['второе']);
  });
  it('принятый вопрос уводит прошлый обмен в историю; не дошедший — нет; close её чистит', async () => {
    const { store } = setup({ call: vi.fn().mockRejectedValueOnce(new Error('not connected')).mockResolvedValue({ ok: true }) });
    store.getState().openMode({ listen: false });
    store.getState().applyHost({ ...HOST_IDLE, question: 'кто работает?', answer: 'Двое.', turn: 1, askId: 'a0', instance: 'h1' });
    await store.getState().submit('а комната?');
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState().history).toEqual([]);
    await store.getState().submit('а комната?');
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', question: 'а комната?', turn: 2, askId: store.getState().sending!.id, instance: 'h1' });
    expect(store.getState().history).toEqual([{ id: 1, question: 'кто работает?', answer: 'Двое.' }]);
    store.getState().close();
    expect(store.getState().history).toEqual([]);
  });
  it('не дошло — в поле и то, что ждало в очереди, по порядку', async () => {
    let reject: (error: Error) => void = () => {};
    const call = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const { store } = setup({ call: call as unknown as AssistantDeps['call'] });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    reject(new Error('not connected'));
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState()).toMatchObject({ queue: [], draft: 'первое второе' });
  });
  it('длиннее 4000 знаков — подсказка, текст остаётся в поле, ничего не уходит', async () => {
    const { store, deps } = setup();
    await store.getState().submit('x'.repeat(4001));
    expect(store.getState()).toMatchObject({ draft: 'x'.repeat(4001), notice: 'Too long — 4,000 characters at most', queue: [] });
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('close с вопросом в пути отменяет его на хосте', async () => {
    const { store, deps } = setup();
    store.getState().openMode({ listen: false });
    await store.getState().submit('кто работает?');
    store.getState().close();
    expect(deps.call).toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('кнопка микрофона во время хода его не перебивает', () => {
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result: new Promise(() => {}) })) });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    store.getState().toggleListening();
    expect(store.getState().input).toBe('listening');
    expect(deps.call).not.toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('хоткей: сказанное уходит одним ходом с тем, что набрали во время хода', async () => {
    let finish: (value: { text: string }) => void = () => {};
    const result = new Promise<{ text: string }>((resolve) => { finish = resolve; });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    await store.getState().submit('набрал');
    store.getState().openMode({ listen: true });
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
    finish({ text: 'сказал' });
    await result;
    await Promise.resolve();
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'набрал\n\nсказал' }));
  });
  it('× убирает сообщение из очереди', async () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    store.getState().unqueue(store.getState().queue[0]!.id);
    expect(store.getState().queue.map((item) => item.text)).toEqual(['второе']);
  });
  it('очередь длиннее предела ask уходит частями', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('a'.repeat(3000));
    await store.getState().submit('b'.repeat(3000));
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).toHaveBeenLastCalledWith('assistant.ask', expect.objectContaining({ text: 'a'.repeat(3000) }));
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 2 });
    store.getState().applyHost({ ...HOST_IDLE, turn: 2 });
    expect(deps.call).toHaveBeenLastCalledWith('assistant.ask', expect.objectContaining({ text: 'b'.repeat(3000) }));
  });
  it('хост вопрос не принял — текст в поле, подсказка, очередь свободна', async () => {
    const { store } = setup({ call: vi.fn().mockRejectedValue(new Error('not connected')) });
    await store.getState().submit('кто работает?');
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState().draft).toBe('кто работает?');
    expect(store.getState().notice).toBe('Not sent — press Enter to try again');
  });
  it('close очищает очередь', async () => {
    const { store } = setup();
    store.getState().openMode({ listen: false });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('первое');
    store.getState().close();
    expect(store.getState().queue).toEqual([]);
  });
  it('решение карточки в пути: deciding выставлен, повторное нажатие не шлёт второй раз', async () => {
    let finish: (value: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { store } = setup({ call: call as unknown as AssistantDeps['call'] });
    store.getState().applyHost({ ...HOST_IDLE, proposal: { id: 'p1', target: 'Auth', where: 'w', kind: 'note', text: 't', wake: false }, phase: 'awaiting-confirm', turn: 1 });
    const first = store.getState().decide('send');
    expect(store.getState().deciding).toBe('send');
    void store.getState().decide('send');
    expect(call).toHaveBeenCalledTimes(1);
    finish({ applied: true, error: null });
    await first;
    expect(store.getState().deciding).toBeNull();
  });
  it('хоткей отправляет распознанное сразу', async () => {
    const result = Promise.resolve({ text: 'hello' });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().openMode({ listen: true });
    await result;
    await Promise.resolve();
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'hello' }));
    expect(store.getState().draft).toBe('');
  });

  it('ответ на напоминание открывает помощника без клавиатуры', () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(store.getState().open).toBe(true);
    expect(store.getState().collapsed).toBe(false);
    expect(deps.keyboard).not.toHaveBeenCalled();
  });

  it('ход из Telegram открывает помощника без клавиатуры', () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'telegram', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(store.getState().open).toBe(true);
    expect(store.getState().collapsed).toBe(false);
    expect(deps.keyboard).not.toHaveBeenCalled();
  });

  it('ход с origin island закрытого помощника не открывает', () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'island', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(store.getState().open).toBe(false);
  });

  it('повторное состояние того же хода после close() не открывает снова', () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' });
    store.getState().close();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'idle', answer: 'Room is fine' });
    expect(store.getState().open).toBe(false);
  });

  it('остров, открытый напоминанием, не берёт клавиатуру сам; takeKeyboard берёт один раз', () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(deps.keyboard).not.toHaveBeenCalled();
    store.getState().takeKeyboard();
    store.getState().takeKeyboard();
    expect(deps.keyboard).toHaveBeenCalledTimes(1);
    expect(deps.keyboard).toHaveBeenLastCalledWith(true);
  });

  it('после close() следующее открытие напоминанием снова даёт взять клавиатуру', () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'a' });
    store.getState().takeKeyboard();
    store.getState().close();
    expect(deps.keyboard).toHaveBeenLastCalledWith(false);
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 2, phase: 'answering', answer: 'b' });
    store.getState().takeKeyboard();
    expect(deps.keyboard).toHaveBeenLastCalledWith(true);
    expect(deps.keyboard).toHaveBeenCalledTimes(3);
  });

  it('после openMode takeKeyboard — без второго вызова; закрытый остров клавиатуру не берёт', () => {
    const { store, deps } = setup();
    store.getState().takeKeyboard();
    expect(deps.keyboard).not.toHaveBeenCalled();
    store.getState().openMode({ listen: false });
    store.getState().takeKeyboard();
    expect(deps.keyboard).toHaveBeenCalledTimes(1);
  });
});

/** Речь включена, голос скачан. */
const SPEECH_ON: IslandSpeechConfig = { enabled: true, voice: 'qwen3-0.6b/serena', gender: 'female', available: true };
const FRAME: VoiceFrame = { amp: 0.5, visemes: { a: 0, i: 0, u: 0, m: 0 }, pulse: 0, eyesUp: 0, blink: false, loud: 0.5 };

/**
 * Стор с речью: проигрыватель и мост голоса подставные. `start`/`idle` — проигрыватель начал предложение / доиграл
 * очередь, `chunk` — кусок из порта голоса, `resolve` — main закончил предложение (`island:tts-speak` ответил).
 */
function speechSetup(options: { speech?: Partial<IslandSpeechConfig>; language?: AssistantLanguage; engine?: TtsEngineState | null; over?: Partial<AssistantDeps> } = {}) {
  let config = { ...CONFIG, language: options.language ?? ('en' as AssistantLanguage), speech: { ...SPEECH_ON, ...options.speech } };
  const starts = new Set<(utteranceId: string) => void>();
  const idles = new Set<() => void>();
  let playing = false;
  const speaker = {
    enqueue: vi.fn(),
    expect: vi.fn(),
    stop: vi.fn(() => { playing = false; }),
    discard: vi.fn(),
    mouth: vi.fn(() => 0),
    speaking: vi.fn(() => playing),
    onIdle: vi.fn((cb: () => void) => { idles.add(cb); return () => idles.delete(cb); }),
    onStart: vi.fn((cb: (utteranceId: string) => void) => { starts.add(cb); return () => starts.delete(cb); }),
    read: vi.fn(() => true),
  } satisfies Speaker;
  const resolvers = new Map<string, { resolve(state: TtsEngineState): void; reject(error: Error): void }>();
  const api = {
    speak: vi.fn((request: IslandSpeakRequest) => new Promise<TtsEngineState>((resolve, reject) => { resolvers.set(request.utteranceId, { resolve, reject }); })),
    cancel: vi.fn(),
    warmup: vi.fn(async (): Promise<TtsEngineState> => ({ state: 'ready' })),
    setSpeak: vi.fn(async () => undefined),
  };
  const step = vi.fn<VoiceAnalysis['step']>(() => FRAME);
  const analysis = vi.fn(() => ({ step }));
  let clock = 1000;
  const { store, deps } = setup({ config: () => config, speech: { speaker, api, analysis, now: () => clock }, ...options.over });
  const engine = options.engine === undefined ? { state: 'ready' as const } : options.engine;
  if (engine !== null) store.getState().speechMessage({ type: 'state', state: engine });
  store.getState().openMode({ listen: false });
  const host = (patch: Partial<AssistantState>): void => store.getState().applyHost({ ...HOST_IDLE, turn: 1, ...patch });
  return {
    store,
    deps,
    speaker,
    api,
    step,
    analysis,
    host,
    ids: (): string[] => api.speak.mock.calls.map(([request]) => request.utteranceId),
    texts: (): string[] => api.speak.mock.calls.map(([request]) => request.text),
    enqueued: (): Array<[string, number]> => speaker.enqueue.mock.calls.map(([chunk]) => [chunk.utteranceId, chunk.seq]),
    chunk: (utteranceId: string, seq: number, final = false): void =>
      store.getState().speechMessage({ type: 'chunk', chunk: { utteranceId, seq, sampleRate: 24000, channels: 1, format: 'f32', pcm: new Float32Array(final ? 0 : 4), final } }),
    start: (utteranceId: string): void => {
      playing = true;
      for (const cb of [...starts]) cb(utteranceId);
    },
    idle: (): void => {
      playing = false;
      for (const cb of [...idles]) cb();
    },
    resolve: async (utteranceId: string, state: TtsEngineState = { state: 'ready' }): Promise<void> => {
      resolvers.get(utteranceId)!.resolve(state);
      await Promise.resolve();
      await Promise.resolve();
    },
    reject: async (utteranceId: string): Promise<void> => {
      resolvers.get(utteranceId)!.reject(new Error('bad_request'));
      await Promise.resolve();
      await Promise.resolve();
    },
    setConfig: (patch: Partial<IslandSpeechConfig>): void => {
      config = { ...config, speech: { ...config.speech, ...patch } };
    },
    tick: (ms: number): void => { clock += ms; },
  };
}

/** Ход 1 с ответом из двух предложений: ответ дописан, предложения ушли на синтез и играют. */
function spokenTurn(t: ReturnType<typeof speechSetup>, text = 'The room is working. Two agents are busy.'): [string, string] {
  t.host({ phase: 'thinking', question: 'q' });
  t.host({ phase: 'answering', answer: text });
  t.host({ phase: 'idle', answer: text });
  return [t.ids()[0]!, t.ids()[1]!];
}

describe('стор помощника: речь (план 3b B22)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('предложения уходят в tts-speak по мере ответа, expect — раньше speak; куски копятся и играют после конца ответа по порядку', () => {
    const t = speechSetup();
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'answering', answer: 'The room is working. Two agents' });
    expect(t.texts()).toEqual(['The room is working.']);
    const first = t.ids()[0]!;
    expect(t.api.speak).toHaveBeenCalledWith({ utteranceId: first, text: 'The room is working.', voice: 'qwen3-0.6b/serena', language: 'en' });
    expect(t.speaker.expect).toHaveBeenCalledWith(first);
    expect(t.speaker.expect.mock.invocationCallOrder[0]).toBeLessThan(t.api.speak.mock.invocationCallOrder[0]!);
    t.chunk(first, 0);
    t.chunk(first, 1);
    expect(t.speaker.enqueue).not.toHaveBeenCalled();
    t.host({ phase: 'answering', answer: 'The room is working. Two agents are busy.' });
    t.host({ phase: 'idle', answer: 'The room is working. Two agents are busy.' });
    expect(t.texts()).toEqual(['The room is working.', 'Two agents are busy.']);
    expect(t.enqueued()).toEqual([[first, 0], [first, 1]]);
    const second = t.ids()[1]!;
    t.chunk(second, 0);
    expect(t.enqueued()).toEqual([[first, 0], [first, 1], [second, 0]]);
  });

  it('лицо: onStart ставит speaking и предложение; эмоция меняется на старте второго предложения (F3)', () => {
    const t = speechSetup();
    const text = 'Everything is going well today. Sadly one agent has failed.';
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'answering', answer: text, moods: [{ at: 0, mood: 'joy' }, { at: 32, mood: 'sad' }] });
    t.host({ phase: 'idle', answer: text, moods: [{ at: 0, mood: 'joy' }, { at: 32, mood: 'sad' }] });
    const [first, second] = t.ids();
    expect(t.store.getState().input).toBe('idle');
    t.start(first!);
    expect(t.store.getState()).toMatchObject({ input: 'speaking', sentence: { utteranceId: first, emo: 'joy', text: 'Everything is going well today.' } });
    t.start(second!);
    expect(t.store.getState().sentence).toEqual({ utteranceId: second, emo: 'sad', text: 'Sadly one agent has failed.' });
  });

  it('речь кончилась — Done 1 с, затем idle; onIdle между предложениями речь не кончает', () => {
    vi.useFakeTimers();
    const t = speechSetup();
    const [first, second] = spokenTurn(t);
    t.start(first);
    t.chunk(first, 0);
    t.chunk(first, 1, true);
    t.idle();
    expect(t.store.getState().input).toBe('speaking');
    t.chunk(second, 0);
    t.start(second);
    t.chunk(second, 1, true);
    t.idle();
    expect(t.store.getState()).toMatchObject({ input: 'settling', sentence: null });
    expect(assistantBusy(t.store.getState())).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(t.store.getState().input).toBe('settling');
    vi.advanceTimersByTime(1);
    expect(t.store.getState().input).toBe('idle');
  });

  it('срыв по длине: до игры выброшенные куски не звучат, во время игры — speaker.discard', () => {
    const t = speechSetup();
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'answering', answer: 'The room is working. Two' });
    const first = t.ids()[0]!;
    t.chunk(first, 0);
    t.chunk(first, 1);
    t.store.getState().speechMessage({ type: 'discard', utteranceId: first, fromSeq: 1 });
    t.chunk(first, 2);
    t.host({ phase: 'idle', answer: 'The room is working. Two agents are busy.' });
    expect(t.enqueued()).toEqual([[first, 0], [first, 2]]);
    t.store.getState().speechMessage({ type: 'discard', utteranceId: first, fromSeq: 2 });
    expect(t.speaker.discard).toHaveBeenCalledWith(first, 2);
  });

  it('предложение, все попытки которого выброшены, всё равно кончается — по ответу speak, без onIdle', async () => {
    vi.useFakeTimers();
    const t = speechSetup();
    const [first, second] = spokenTurn(t);
    t.chunk(first, 0);
    t.start(first);
    t.chunk(first, 1, true);
    t.store.getState().speechMessage({ type: 'discard', utteranceId: second, fromSeq: 0 });
    t.idle();
    expect(t.store.getState().input).toBe('speaking');
    await t.resolve(second);
    // Ответ `speak` кончает предложение только после паузы на `final` (критик m-1481).
    expect(t.store.getState().input).toBe('speaking');
    vi.advanceTimersByTime(SPEAK_FINAL_GRACE_MS);
    expect(t.store.getState().input).toBe('settling');
  });

  it('ответ speak обогнал последние куски по IPC: они всё равно играют, потом Done (критик m-1481, F4)', async () => {
    vi.useFakeTimers();
    const t = speechSetup();
    const [first, second] = spokenTurn(t);
    t.chunk(first, 0);
    t.start(first);
    t.chunk(first, 1, true);
    await t.resolve(first);
    t.idle();
    await t.resolve(second);
    expect(t.store.getState().input).toBe('speaking');
    t.chunk(second, 0);
    t.chunk(second, 1, true);
    expect(t.enqueued()).toEqual([[first, 0], [second, 0]]);
    t.start(second);
    t.idle();
    expect(t.store.getState().input).toBe('settling');
  });

  it('Esc во время речи: speaker.stop и отмена всей очереди в main, сразу idle без Done; опоздавшие куски не играют (E3)', () => {
    vi.useFakeTimers();
    const t = speechSetup();
    const [first, second] = spokenTurn(t);
    t.chunk(first, 0);
    t.start(first);
    t.store.getState().close();
    expect(t.speaker.stop).toHaveBeenCalled();
    expect(t.api.cancel).toHaveBeenCalledWith();
    expect(t.store.getState()).toMatchObject({ input: 'idle', sentence: null, open: false });
    t.chunk(second, 0);
    expect(t.enqueued()).toEqual([[first, 0]]);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(t.store.getState().input).toBe('idle');
  });

  it('сброс очереди (ответ начат заново после инструмента): speaker.stop и отмена в main; старые куски не играют', () => {
    const t = speechSetup();
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'answering', answer: 'Let me check. The' });
    const old = t.ids()[0]!;
    t.chunk(old, 0);
    t.host({ phase: 'tool', answer: '' });
    expect(t.speaker.stop).toHaveBeenCalledTimes(1);
    expect(t.api.cancel).toHaveBeenCalledWith();
    t.host({ phase: 'answering', answer: 'Two agents are busy.' });
    t.host({ phase: 'idle', answer: 'Two agents are busy.' });
    expect(t.texts()).toEqual(['Let me check.', 'Two agents are busy.']);
    t.chunk(old, 1);
    t.chunk(t.ids()[1]!, 0);
    expect(t.enqueued()).toEqual([[t.ids()[1]!, 0]]);
  });

  it('значок динамика: выключение посреди речи глушит сразу и пишет флаг; включение пишет флаг', () => {
    const t = speechSetup();
    const [first] = spokenTurn(t);
    t.start(first);
    t.store.getState().toggleSpeak();
    expect(t.api.setSpeak).toHaveBeenCalledWith(false);
    expect(t.speaker.stop).toHaveBeenCalled();
    expect(t.api.cancel).toHaveBeenCalledWith();
    expect(t.store.getState()).toMatchObject({ input: 'idle', sentence: null, open: true });
    t.setConfig({ enabled: false });
    t.store.getState().toggleSpeak();
    expect(t.api.setSpeak).toHaveBeenLastCalledWith(true);
  });

  it('«Speak answers» выключили в Settings посреди речи — речь обрывается, idle, остров открыт (Review Focus 4)', () => {
    const t = speechSetup();
    t.store.getState().speechConfig(SPEECH_ON);
    const [first] = spokenTurn(t);
    t.start(first);
    t.store.getState().speechConfig({ ...SPEECH_ON, enabled: false });
    expect(t.speaker.stop).toHaveBeenCalled();
    expect(t.api.cancel).toHaveBeenCalledWith();
    expect(t.store.getState()).toMatchObject({ input: 'idle', open: true });
  });

  it('прогрев: при включении речи и при открытии режима — только если речь включена и веса скачаны (Р5)', () => {
    const t = speechSetup();
    expect(t.api.warmup).toHaveBeenCalledTimes(1);
    t.store.getState().openMode({ listen: false });
    expect(t.api.warmup).toHaveBeenCalledTimes(1);
    t.store.getState().speechConfig({ ...SPEECH_ON, enabled: false });
    t.store.getState().speechConfig(SPEECH_ON);
    expect(t.api.warmup).toHaveBeenCalledTimes(2);

    const off = speechSetup({ speech: { enabled: false } });
    off.store.getState().speechConfig({ ...SPEECH_ON, enabled: false });
    expect(off.api.warmup).not.toHaveBeenCalled();

    const missing = speechSetup({ engine: { state: 'not-downloaded' } });
    missing.store.getState().speechConfig({ ...SPEECH_ON, enabled: false });
    missing.store.getState().speechConfig(SPEECH_ON);
    expect(missing.api.warmup).not.toHaveBeenCalled();
  });

  it('первое значение настройки — точка отсчёта, а не включение: прогрева нет', () => {
    const t = speechSetup();
    t.api.warmup.mockClear();
    t.store.getState().speechConfig(SPEECH_ON);
    expect(t.api.warmup).not.toHaveBeenCalled();
  });

  it('ход с карточкой не озвучивается; «Sent» — через 900 мс после исхода sent, по роду голоса; cancelled молчит', () => {
    vi.useFakeTimers();
    const t = speechSetup({ language: 'ru' });
    const proposal = { id: 'p1', target: 'Auth', where: 'w', kind: 'note' as const, text: 't', wake: false };
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'answering', answer: 'Подготовил письмо. Отправить' });
    const early = t.ids()[0]!;
    t.host({ phase: 'awaiting-confirm', answer: 'Подготовил письмо. Отправить?', proposal });
    expect(t.api.cancel).toHaveBeenCalledWith();
    t.chunk(early, 0);
    t.host({ phase: 'idle', answer: 'Подготовил письмо. Отправить?', proposal, outcome: 'sent' });
    expect(t.texts()).toEqual(['Подготовил письмо.']);
    vi.advanceTimersByTime(SENT_DELAY_MS - 1);
    expect(t.texts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.texts()).toEqual(['Подготовил письмо.', 'Отправила.']);
    const sent = t.ids()[1]!;
    t.chunk(sent, 0);
    expect(t.enqueued()).toEqual([[sent, 0]]);
    t.start(sent);
    expect(t.store.getState().input).toBe('speaking');

    const quiet = speechSetup();
    quiet.host({ phase: 'awaiting-confirm', proposal });
    quiet.host({ phase: 'idle', proposal, outcome: 'cancelled' });
    vi.advanceTimersByTime(SENT_DELAY_MS * 2);
    expect(quiet.api.speak).not.toHaveBeenCalled();
  });

  it('хоткей и микрофон во время речи не пишут и не обрывают — остров только раскрывается (Review Focus 2)', () => {
    const listen = vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result: new Promise<never>(() => {}) }));
    const t = speechSetup({ over: { listen } });
    const [first] = spokenTurn(t);
    t.start(first);
    t.store.getState().collapse();
    t.store.getState().openMode({ listen: true });
    t.store.getState().toggleListening();
    expect(listen).not.toHaveBeenCalled();
    expect(t.speaker.stop).not.toHaveBeenCalled();
    expect(t.api.cancel).not.toHaveBeenCalled();
    expect(t.store.getState()).toMatchObject({ input: 'speaking', open: true, collapsed: false });
  });

  it('свёрнутый в мини во время речи — речь продолжается', () => {
    const t = speechSetup();
    const [first] = spokenTurn(t);
    t.start(first);
    t.store.getState().collapse();
    expect(t.speaker.stop).not.toHaveBeenCalled();
    expect(t.store.getState().input).toBe('speaking');
  });

  it('вопрос, набранный во время речи, ждёт в очереди и уходит, когда речь кончилась', async () => {
    vi.useFakeTimers();
    const t = speechSetup();
    const [first, second] = spokenTurn(t);
    t.start(first);
    await t.store.getState().submit('а комната?');
    expect(t.deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
    t.chunk(first, 0, true);
    t.chunk(second, 0, true);
    t.idle();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(t.deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'а комната?' }));
  });

  it('синтез не удался (speak отклонён) — предложение пропущено без подсказки, ход кончается текстом (Review Focus 3)', async () => {
    const t = speechSetup();
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'idle', answer: 'Two agents are busy.' });
    t.store.setState({ notice: null });
    await t.reject(t.ids()[0]!);
    expect(t.store.getState()).toMatchObject({ input: 'idle', notice: null, sentence: null });
  });

  it('голос не скачан — ответ текстом без речи; строка про голос один раз за сессию; после загрузки следующий ответ звучит (G3)', () => {
    const t = speechSetup({ engine: { state: 'not-downloaded' }, speech: { available: false } });
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'idle', answer: 'Two agents are busy.' });
    expect(t.api.speak).not.toHaveBeenCalled();
    expect(t.store.getState().notice).toBe('Voice "Serena" isn\'t downloaded — open Settings');
    t.store.setState({ notice: null });
    t.host({ phase: 'thinking', question: 'q2', turn: 2 });
    t.host({ phase: 'idle', answer: 'Still busy.', turn: 2 });
    expect(t.store.getState().notice).toBeNull();
    t.store.getState().speechMessage({ type: 'state', state: { state: 'ready' } });
    t.host({ phase: 'thinking', question: 'q3', turn: 3 });
    t.host({ phase: 'idle', answer: 'Now it speaks.', turn: 3 });
    expect(t.texts()).toEqual(['Now it speaks.']);
  });

  it('голос недоступен по конфигу (состояния движка ещё нет) — без речи и без строки', () => {
    const t = speechSetup({ engine: null, speech: { available: false } });
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'idle', answer: 'Two agents are busy.' });
    expect(t.api.speak).not.toHaveBeenCalled();
    expect(t.store.getState().notice).toBeNull();
  });

  it('нет голоса для языка помощника (uk) — ответ текстом, без речи и без строки (Р8)', () => {
    const t = speechSetup({ language: 'uk' });
    t.host({ phase: 'thinking', question: 'q' });
    t.host({ phase: 'idle', answer: 'Two agents are busy.' });
    expect(t.api.speak).not.toHaveBeenCalled();
    expect(t.store.getState().notice).toBeNull();
  });

  it('голос не начал звучать за тайм-аут — отмена, ответ текстом без лица', () => {
    vi.useFakeTimers();
    const t = speechSetup();
    spokenTurn(t);
    vi.advanceTimersByTime(SPEECH_START_TIMEOUT_MS - 1);
    expect(t.api.cancel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.speaker.stop).toHaveBeenCalled();
    expect(t.api.cancel).toHaveBeenCalledWith();
    expect(t.store.getState().input).toBe('idle');
  });

  it('новый ход (напоминание, Telegram) во время речи глушит прошлую и убирает лицо', () => {
    const t = speechSetup();
    const [first] = spokenTurn(t);
    t.start(first);
    t.host({ phase: 'thinking', question: 'q2', turn: 2, origin: 'reminder' });
    expect(t.speaker.stop).toHaveBeenCalled();
    expect(t.api.cancel).toHaveBeenCalledWith();
    expect(t.store.getState()).toMatchObject({ input: 'idle', sentence: null });
  });

  it('куски чужого предложения не играют', () => {
    const t = speechSetup();
    spokenTurn(t);
    t.chunk('stranger', 0);
    expect(t.speaker.enqueue).not.toHaveBeenCalled();
  });

  it('voiceFrame: голос молчит — null; звучит — step с ask по «?» предложения (F2, путь), анализ создаётся один раз', () => {
    const t = speechSetup();
    const [first, second] = spokenTurn(t, 'The room is working. Is anyone free?');
    t.speaker.read.mockReturnValueOnce(false);
    expect(t.store.getState().voiceFrame()).toBeNull();
    expect(t.step).not.toHaveBeenCalled();
    t.start(first);
    t.tick(16);
    expect(t.store.getState().voiceFrame()).toBe(FRAME);
    expect(t.step).toHaveBeenLastCalledWith(expect.any(Float32Array), expect.any(Float32Array), expect.any(Number), 1016, false);
    t.start(second);
    t.tick(16);
    t.store.getState().voiceFrame();
    expect(t.step).toHaveBeenLastCalledWith(expect.any(Float32Array), expect.any(Float32Array), 0.016, 1032, true);
    expect(t.analysis).toHaveBeenCalledTimes(1);
  });
});
