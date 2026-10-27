import { describe, expect, it, vi } from 'vitest';
import type { TtsChunk, TtsService } from '../assistant/tts.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { IslandConfig, IslandTtsMessage, TtsEngineState } from '../../shared/island.js';
import { registerIslandIpc } from './ipc.js';

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  on(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  emit(channel: string, event: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`нет обработчика для ${channel}`);
    return handler(event, ...args);
  }
}

const island = { id: 99 };
const stranger = { id: 1 };
const REF = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const TARGET = { kind: 'session', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, cardId: 'c-1' };
const CONFIG = {
  islandEnabled: true,
  assistant: {
    enabled: true, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null },
    speech: { enabled: true, voice: 'qwen3-0.6b/serena', gender: 'female', available: true },
  },
  islandSound: { needs: true, finished: false, palette: 'soft', volume: 0.6, ui: false },
  motion: 'system',
  topInset: 38,
  anchor: 'center',
} satisfies IslandConfig;
const SPEAK = { utteranceId: 'u-1', text: 'Two agents are working.', voice: 'qwen3-0.6b/serena', language: 'en' };

/** Порт голоса: сообщения по порядку. */
function fakePort() {
  const messages: IslandTtsMessage[] = [];
  return { messages, postMessage: vi.fn((message: IslandTtsMessage) => { messages.push(message); }), close: vi.fn() };
}

const chunk = (seq: number, final = false): TtsChunk => ({
  utteranceId: 'u-1', seq, sampleRate: 24_000, channels: 1, format: 'f32', pcm: new Float32Array([seq / 10]), final,
});

/** Подменная служба голоса: `speak` по умолчанию отдаёт один кусок и `final`; `emitState` — смена состояния. */
function fakeTts() {
  let listener: ((state: TtsEngineState) => void) | null = null;
  const tts = {
    speak: vi.fn<TtsService['speak']>(async (_request, sink) => {
      sink(chunk(0));
      sink(chunk(1, true));
      return { state: 'ready' };
    }),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    warmup: vi.fn(async (): Promise<TtsEngineState> => ({ state: 'ready' })),
    state: vi.fn((): TtsEngineState => ({ state: 'ready' })),
    onState: vi.fn((next: (state: TtsEngineState) => void) => {
      listener = next;
      return () => undefined;
    }),
  };
  return { tts, emitState: (state: TtsEngineState) => listener?.(state) };
}

function setup() {
  const ipcMain = new FakeIpcMain();
  const voice = fakeTts();
  const ports: { port1: ReturnType<typeof fakePort>; port2: unknown }[] = [];
  const controller = {
    isIsland: (sender: unknown) => (sender as { id?: unknown } | null)?.id === island.id,
    setHitRect: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
  };
  const options = {
    ipcMain,
    controller,
    config: vi.fn().mockResolvedValue(CONFIG),
    visibility: vi.fn(() => ({ version: 7, refs: [REF] })),
    pushConfig: vi.fn(),
    keyboard: vi.fn(),
    openTarget: vi.fn(),
    beep: vi.fn(),
    markSeen: vi.fn(),
    onFailed: vi.fn(),
    tts: voice.tts,
    ttsChannel: vi.fn(() => {
      const channel = { port1: fakePort(), port2: { transferable: ports.length } };
      ports.push(channel);
      return channel;
    }),
    uiStore: { save: vi.fn().mockResolvedValue({}) },
    onUiSaved: vi.fn(),
  };
  registerIslandIpc(options);
  return { ipcMain, ...options, ports, emitState: voice.emitState };
}

/** Окно острова, которому main шлёт порт (`webContents.postMessage`). */
function islandContents() {
  return { ...island, postMessage: vi.fn() };
}

/** Имена всех подменённых методов, которые хоть раз позвали: «ничего не случилось» — пустой список. */
function calledNames(state: ReturnType<typeof setup>): string[] {
  const mocks = {
    setHitRect: state.controller.setHitRect,
    setVisible: state.controller.setVisible,
    dragStart: state.controller.dragStart,
    dragMove: state.controller.dragMove,
    dragEnd: state.controller.dragEnd,
    config: state.config,
    pushConfig: state.pushConfig,
    keyboard: state.keyboard,
    openTarget: state.openTarget,
    beep: state.beep,
    markSeen: state.markSeen,
    onFailed: state.onFailed,
    speak: state.tts.speak,
    cancel: state.tts.cancel,
    cancelAll: state.tts.cancelAll,
    warmup: state.tts.warmup,
    ttsChannel: state.ttsChannel,
    save: state.uiStore.save,
    onUiSaved: state.onUiSaved,
  };
  return Object.entries(mocks)
    .filter(([, mock]) => mock.mock.calls.length > 0)
    .map(([name]) => name);
}

describe('IPC острова', () => {
  it('visibility getter is island-only', async () => {
    const { ipcMain, visibility } = setup();
    await expect(ipcMain.emit('island:session-visibility', { sender: stranger })).rejects.toThrow();
    expect(visibility).not.toHaveBeenCalled();
    await expect(ipcMain.emit('island:session-visibility', { sender: island })).resolves.toEqual({ version: 7, refs: [REF] });
  });
  it('failed от острова зовёт onFailed, от чужого окна — нет', () => {
    const { ipcMain, onFailed } = setup();
    ipcMain.emit('island:failed', { sender: stranger });
    expect(onFailed).not.toHaveBeenCalled();
    ipcMain.emit('island:failed', { sender: island });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('keyboard: от острова с булевым значением зовёт options.keyboard, от чужого окна и не с булевым — нет', () => {
    const state = setup();
    state.ipcMain.emit('island:keyboard', { sender: stranger }, true);
    state.ipcMain.emit('island:keyboard', { sender: island }, 'true');
    state.ipcMain.emit('island:keyboard', { sender: island }, 1);
    state.ipcMain.emit('island:keyboard', { sender: island });
    expect(state.keyboard).not.toHaveBeenCalled();
    state.ipcMain.emit('island:keyboard', { sender: island }, true);
    expect(state.keyboard).toHaveBeenCalledWith(true);
    state.ipcMain.emit('island:keyboard', { sender: island }, false);
    expect(state.keyboard).toHaveBeenLastCalledWith(false);
  });

  it('видимость и перетаскивание — только от окна острова и только целые данные', () => {
    const { ipcMain, controller, pushConfig } = setup();
    ipcMain.emit('island:visible', { sender: island }, true);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    ipcMain.emit('island:drag-end', { sender: island }, { screenX: 10, screenY: 20 });
    expect(controller.dragEnd).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(pushConfig).toHaveBeenCalledTimes(1);
  });

  it('hit-rect: от острова проходят null и целая область (в том числе нулевого размера и с отрицательным сдвигом)', () => {
    const { ipcMain, controller } = setup();
    ipcMain.emit('island:hit-rect', { sender: island }, { x: 100, y: 0, width: 280, height: 40 });
    ipcMain.emit('island:hit-rect', { sender: island }, null);
    ipcMain.emit('island:hit-rect', { sender: island }, { x: 0, y: 0, width: 0, height: 0 });
    ipcMain.emit('island:hit-rect', { sender: island }, { x: -300, y: -20, width: 2000, height: 2000 });
    expect(controller.setHitRect.mock.calls).toEqual([
      [{ x: 100, y: 0, width: 280, height: 40 }],
      [null],
      [{ x: 0, y: 0, width: 0, height: 0 }],
      [{ x: -300, y: -20, width: 2000, height: 2000 }],
    ]);
  });

  it('hit-rect от чужого окна не передаётся контроллеру, даже целая область и null', () => {
    const state = setup();
    state.ipcMain.emit('island:hit-rect', { sender: stranger }, { x: 1, y: 2, width: 3, height: 4 });
    state.ipcMain.emit('island:hit-rect', { sender: stranger }, null);
    expect(calledNames(state)).toEqual([]);
  });

  it('config — острову; чужому окну — отказ', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.emit('island:config', { sender: island })).resolves.toEqual(CONFIG);
    await expect(ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
  });

  it('open ведёт в главное окно только целой целью', () => {
    const { ipcMain, openTarget } = setup();
    ipcMain.emit('island:open', { sender: island }, TARGET);
    ipcMain.emit('island:open', { sender: island }, { kind: 'session' });
    expect(openTarget.mock.calls).toEqual([[TARGET]]);
  });

  it.each<[string, unknown[]]>([
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: 4 }]],
    ['island:visible', [true]],
    ['island:drag-start', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-move', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-end', [{ screenX: 1, screenY: 2 }]],
    ['island:open', [TARGET]],
    ['island:beep', []],
    ['island:mark-seen', [[REF]]],
    ['island:failed', []],
    ['island:tts-connect', []],
    ['island:tts-cancel', ['u-1']],
    ['island:tts-cancel', [null]],
  ])('%s от чужого окна не делает ничего', (channel, args) => {
    const state = setup();
    state.ipcMain.emit(channel, { sender: stranger }, ...args);
    expect(calledNames(state)).toEqual([]);
  });

  it('island:config от чужого окна — отказ, настройки не читаются', async () => {
    const state = setup();
    await expect(state.ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
    expect(calledNames(state)).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ['island:hit-rect', ['yes']],
    ['island:hit-rect', [undefined]],
    ['island:hit-rect', [[]]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3 }]],
    ['island:hit-rect', [{ x: '1', y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: Number.NaN, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: Number.POSITIVE_INFINITY, y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: -1, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: -0.5 }]],
    ['island:hit-rect', [{ x: 2001, y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: 2001 }]],
    ['island:visible', ['yes']],
    ['island:mark-seen', [undefined]],
    ['island:mark-seen', [REF]],
    ['island:mark-seen', [[]]],
    ['island:mark-seen', [Array.from({ length: 51 }, () => REF)]],
    ['island:mark-seen', [[REF, { projectPath: '/p', workId: 'w-1' }]]],
    ['island:mark-seen', [[REF, 'мусор']]],
    ['island:mark-seen', [[{ projectPath: '/p', workId: 1, sessionId: 's-01' }]]],
    ['island:drag-start', [null]],
    ['island:drag-move', [{ screenX: '1', screenY: 2 }]],
    ['island:drag-end', [{ screenX: Number.POSITIVE_INFINITY, screenY: 0 }]],
    ['island:tts-cancel', [5]],
    ['island:tts-cancel', ['']],
    ['island:tts-cancel', ['x'.repeat(201)]],
  ])('%s с негодными данными от острова не делает ничего (%j)', (channel, args) => {
    const state = setup();
    state.ipcMain.emit(channel, { sender: island }, ...args);
    expect(calledNames(state)).toEqual([]);
  });

  it('mark-seen: верный список (от одной до 50 ссылок) доходит до main, лишние поля срезаются', () => {
    const { ipcMain, markSeen } = setup();
    const other = { projectPath: '/q', workId: 'w-2', sessionId: 's-02' };
    ipcMain.emit('island:mark-seen', { sender: island }, [REF, { ...other, extra: 1 }]);
    const fifty = Array.from({ length: 50 }, (_, at) => ({ ...REF, sessionId: `s-${at}` }));
    ipcMain.emit('island:mark-seen', { sender: island }, fifty);
    expect(markSeen.mock.calls).toEqual([[[REF, other]], [fifty]]);
  });

  it('звук; канала подсказки первого показа больше нет', () => {
    const { ipcMain, beep } = setup();
    ipcMain.emit('island:beep', { sender: island });
    ipcMain.emit('island:beep', { sender: stranger });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(ipcMain.handlers.has('island:hint-shown')).toBe(false);
  });

  it.each<[string, unknown[]]>([
    ['island:tts-speak', [SPEAK]],
    ['island:tts-warmup', []],
    ['island:assistant-speak', [true]],
  ])('%s от чужого окна — forbidden, служба и ui.json не тронуты', async (channel, args) => {
    const state = setup();
    const error = await Promise.resolve(state.ipcMain.emit(channel, { sender: stranger }, ...args)).then(() => null, (reason: unknown) => reason);
    expect(decodeIpcError(error).code).toBe('forbidden');
    expect(calledNames(state)).toEqual([]);
  });
});

describe('IPC острова: нейроголос (план 3b, B15)', () => {
  async function codeOf(promise: unknown): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return decodeIpcError(error).code;
    }
    return 'resolved';
  }

  it('порт голоса отдаётся только окну острова: каналом island:tts-port и передачей port2', () => {
    const state = setup();
    const strangerContents = { ...stranger, postMessage: vi.fn() };
    state.ipcMain.emit('island:tts-connect', { sender: strangerContents });
    expect(state.ttsChannel).not.toHaveBeenCalled();
    expect(strangerContents.postMessage).not.toHaveBeenCalled();
    const contents = islandContents();
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    expect(contents.postMessage).toHaveBeenCalledTimes(1);
    expect(contents.postMessage).toHaveBeenCalledWith('island:tts-port', null, [state.ports[0]!.port2]);
    // Новый порт сразу знает состояние движка.
    expect(state.ports[0]!.port1.messages).toEqual([{ type: 'state', state: { state: 'ready' } }]);
  });

  it('новый порт (перезагрузка острова) закрывает прежний и отменяет его речь; состояние идёт в живой порт', () => {
    const state = setup();
    const contents = islandContents();
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    expect(state.tts.cancelAll).not.toHaveBeenCalled();
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    const [first, second] = state.ports;
    expect(first!.port1.close).toHaveBeenCalledTimes(1);
    expect(state.tts.cancelAll).toHaveBeenCalledTimes(1);
    state.emitState({ state: 'warming' });
    expect(first!.port1.messages).toEqual([{ type: 'state', state: { state: 'ready' } }]);
    expect(second!.port1.messages).toEqual([{ type: 'state', state: { state: 'ready' } }, { type: 'state', state: { state: 'warming' } }]);
  });

  it.each(['destroyed', 'render-process-gone'] as const)('окно острова пропало (%s) — порт закрыт, речь снята', (gone) => {
    const state = setup();
    const listeners = new Map<string, () => void>();
    const contents = { ...islandContents(), on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)) };
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    expect(contents.on).toHaveBeenCalledTimes(2);
    const live = state.ports[1]!.port1;
    listeners.get(gone)!();
    expect(live.close).toHaveBeenCalledTimes(1);
    expect(state.tts.cancelAll).toHaveBeenCalledTimes(2);
    state.emitState({ state: 'warming' });
    expect(live.messages).toEqual([{ type: 'state', state: { state: 'ready' } }]);
  });

  it('гибель старого окна острова не трогает порт нового (критик m-1468)', () => {
    const state = setup();
    const listeners = new Map<string, () => void>();
    const old = { ...islandContents(), on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)) };
    state.ipcMain.emit('island:tts-connect', { sender: old });
    state.ipcMain.emit('island:tts-connect', { sender: { ...islandContents(), on: vi.fn() } });
    const cancels = state.tts.cancelAll.mock.calls.length;
    listeners.get('destroyed')!();
    expect(state.ports[1]!.port1.close).not.toHaveBeenCalled();
    expect(state.tts.cancelAll).toHaveBeenCalledTimes(cancels);
  });

  it('tts-speak: куски уходят в порт острова, ответ — итог службы', async () => {
    const state = setup();
    state.ipcMain.emit('island:tts-connect', { sender: islandContents() });
    const port = state.ports[0]!.port1;
    port.messages.length = 0;
    await expect(state.ipcMain.emit('island:tts-speak', { sender: island }, SPEAK)).resolves.toEqual({ state: 'ready' });
    expect(state.tts.speak).toHaveBeenCalledWith(SPEAK, expect.any(Function), { onDiscard: expect.any(Function) });
    expect(port.messages).toEqual([{ type: 'chunk', chunk: chunk(0) }, { type: 'chunk', chunk: chunk(1, true) }]);
  });

  it('срыв по длине: кусок seq 3 → discard(fromSeq 2) → кусок повтора seq 4 — в этом порядке на том же порту', async () => {
    const state = setup();
    state.tts.speak.mockImplementationOnce(async (request, sink, options) => {
      sink(chunk(3));
      options?.onDiscard?.(request.utteranceId, 2);
      sink(chunk(4));
      return { state: 'ready' };
    });
    const contents = islandContents();
    state.ipcMain.emit('island:tts-connect', { sender: contents });
    const port = state.ports[0]!.port1;
    port.messages.length = 0;
    await state.ipcMain.emit('island:tts-speak', { sender: island }, SPEAK);
    expect(port.messages).toEqual([
      { type: 'chunk', chunk: chunk(3) },
      { type: 'discard', utteranceId: 'u-1', fromSeq: 2 },
      { type: 'chunk', chunk: chunk(4) },
    ]);
    // Ни через webContents.send, ни отдельным каналом: окно получило только порт.
    expect(contents.postMessage).toHaveBeenCalledTimes(1);
  });

  it('tts-speak: 2000 знаков — можно, 2001 — bad_request; негодная форма — bad_request; служба не вызвана', async () => {
    const state = setup();
    await expect(state.ipcMain.emit('island:tts-speak', { sender: island }, { ...SPEAK, text: 'a'.repeat(2000) })).resolves.toEqual({ state: 'ready' });
    expect(state.tts.speak).toHaveBeenCalledTimes(1);
    for (const request of [
      { ...SPEAK, text: 'a'.repeat(2001) },
      { ...SPEAK, text: '   ' },
      { ...SPEAK, text: 5 },
      { ...SPEAK, utteranceId: '' },
      { ...SPEAK, utteranceId: 'x'.repeat(201) },
      { ...SPEAK, voice: 'Milena' },
      { ...SPEAK, language: 'auto' },
      { ...SPEAK, language: 'english' },
      null,
      'text',
    ]) {
      expect(await codeOf(state.ipcMain.emit('island:tts-speak', { sender: island }, request)), JSON.stringify(request)).toBe('bad_request');
    }
    expect(state.tts.speak).toHaveBeenCalledTimes(1);
  });

  it('tts-cancel: id — отмена предложения, null — вся очередь', () => {
    const state = setup();
    state.ipcMain.emit('island:tts-cancel', { sender: island }, 'u-1');
    state.ipcMain.emit('island:tts-cancel', { sender: island }, null);
    expect(state.tts.cancel.mock.calls).toEqual([['u-1']]);
    expect(state.tts.cancelAll).toHaveBeenCalledTimes(1);
  });

  it('tts-warmup: прогрев службы, ответ — её состояние', async () => {
    const state = setup();
    await expect(state.ipcMain.emit('island:tts-warmup', { sender: island })).resolves.toEqual({ state: 'ready' });
    expect(state.tts.warmup).toHaveBeenCalledTimes(1);
  });

  it('assistant-speak пишет assistant.speak в ui.json и идёт путём сохранения настроек; не булево — bad_request', async () => {
    const state = setup();
    await state.ipcMain.emit('island:assistant-speak', { sender: island }, true);
    expect(state.uiStore.save).toHaveBeenCalledWith({ assistant: { speak: true } });
    expect(state.onUiSaved).toHaveBeenCalledTimes(1);
    expect(await codeOf(state.ipcMain.emit('island:assistant-speak', { sender: island }, 'yes'))).toBe('bad_request');
    expect(state.uiStore.save).toHaveBeenCalledTimes(1);
  });
});
