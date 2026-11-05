import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../../shared/strings.js';
import type { LiveCallPhase, LiveController, LiveControllerEvent, LiveStartResult } from '../live/controller.js';
import { useLiveStore } from '../live/store.js';
import { runHotkey, routeHotkey, type HotkeyRouteInput } from './hotkey.js';

describe('routeHotkey', () => {
  const base: HotkeyRouteInput = { listen: true, speak: true, phase: 'idle', input: 'idle', liveBound: true };
  const cases: Array<[string, Partial<HotkeyRouteInput>, string]> = [
    ['палитра и клик (listen: false) только открывают вид', { listen: false }, 'open'],
    ['палитра при идущем Live тоже только открывает вид', { listen: false, phase: 'live' }, 'open'],
    ['речь включена, Live свободен — запуск Live', {}, 'live-start'],
    ['речь выключена — Whisper', { speak: false }, 'whisper'],
    ['речь включена, но контроллера Live нет — Whisper', { liveBound: false }, 'whisper'],
    ['речь включена, но запись Whisper уже идёт — нажатие её останавливает', { input: 'listening' }, 'whisper'],
    ['речь включена, Whisper расшифровывает — тоже Whisper-путь', { input: 'transcribing' }, 'whisper'],
    ['речь включена, помощник говорит — Live стартует', { input: 'speaking' }, 'live-start'],
    ['Live идёт, а input listening — всё равно завершает Live', { phase: 'live', input: 'listening' }, 'live-stop'],
    ['Live идёт — повторное нажатие завершает диалог', { phase: 'live' }, 'live-stop'],
    ['Live идёт, речь выключили на ходу — всё равно завершает', { phase: 'live', speak: false }, 'live-stop'],
    ['Live подключается — ничего', { phase: 'connecting' }, 'ignore'],
    ['Live закрывается — ничего', { phase: 'closing' }, 'ignore'],
    ['Live подключается, речь выключена — ничего', { phase: 'connecting', speak: false }, 'ignore'],
  ];
  it.each(cases)('%s', (_name, patch, expected) => {
    expect(routeHotkey({ ...base, ...patch })).toBe(expected);
  });
});

function fakeController(startResult: LiveStartResult = { ok: true, voiceSessionId: 'live_1' }) {
  const listeners = new Set<(event: LiveControllerEvent) => void>();
  const emit = (event: LiveControllerEvent): void => listeners.forEach((listener) => listener(event));
  const controller = {
    start: vi.fn(async () => {
      emit({ type: 'phase', phase: 'connecting' });
      emit({ type: 'phase', phase: startResult.ok ? 'live' : 'idle' });
      return startResult;
    }),
    stop: vi.fn(async () => {
      emit({ type: 'sessionClosed', reason: 'close_requested' });
      emit({ type: 'phase', phase: 'idle' });
    }),
    sendAppend: vi.fn(() => true),
    readVoice: vi.fn(() => false),
    subscribe: (listener: (event: LiveControllerEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => ({ phase: 'idle' as LiveCallPhase, voiceSessionId: null, humanSpeaking: false, modelPlaying: false }),
    dispose: vi.fn(),
  } satisfies LiveController;
  return { controller, emit };
}

describe('runHotkey (настоящий live-стор, подставной контроллер)', () => {
  const assistant = { open: false, input: 'idle' as HotkeyRouteInput['input'], openMode: vi.fn((request: { listen: boolean }) => void request) };
  const deps = { assistant: () => assistant, live: useLiveStore.getState };
  const press = (speak: boolean) => runHotkey({ listen: true }, speak, deps);

  beforeEach(() => {
    useLiveStore.getState().bind(null);
    assistant.open = false;
    assistant.input = 'idle';
    assistant.openMode.mockReset();
    assistant.openMode.mockImplementation(() => {
      assistant.open = true;
    });
  });

  it('речь включена: вид открыт, Live запущен, запись Whisper не начинается', async () => {
    const { controller } = fakeController();
    useLiveStore.getState().bind(controller);
    await press(true);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(useLiveStore.getState().phase).toBe('live');
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: false }]]);
  });

  it('второе нажатие завершает диалог', async () => {
    const { controller } = fakeController();
    useLiveStore.getState().bind(controller);
    await press(true);
    await press(true);
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(useLiveStore.getState().phase).toBe('idle');
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('нажатие во время подключения ничего не делает', async () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    emit({ type: 'phase', phase: 'connecting' });
    await press(true);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(assistant.openMode).not.toHaveBeenCalled();
    emit({ type: 'phase', phase: 'closing' });
    await press(false);
    expect(assistant.openMode).not.toHaveBeenCalled();
  });

  it('речь выключена: Whisper как раньше, Live не трогается', async () => {
    const { controller } = fakeController();
    useLiveStore.getState().bind(controller);
    await press(false);
    expect(controller.start).not.toHaveBeenCalled();
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: true }]]);
  });

  it('запись Whisper уже идёт: хоткей останавливает её, Live не стартует', async () => {
    const { controller } = fakeController();
    useLiveStore.getState().bind(controller);
    assistant.open = true;
    assistant.input = 'listening';
    await press(true);
    expect(controller.start).not.toHaveBeenCalled();
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: true }]]);
  });

  it('палитра (listen: false) открывает вид и не запускает Live', async () => {
    const { controller } = fakeController();
    useLiveStore.getState().bind(controller);
    await runHotkey({ listen: false }, true, deps);
    expect(controller.start).not.toHaveBeenCalled();
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: false }]]);
  });

  it.each([
    ['no_key', S.assistant.live.noKey],
    ['limit_reached', S.assistant.live.limitReached],
    ['failed', S.assistant.live.failed],
    ['mic', S.assistant.live.mic],
  ] as const)('отказ %s: запись Whisper вместо диалога, причина в notice', async (code, message) => {
    const { controller } = fakeController({ ok: false, code, message });
    useLiveStore.getState().bind(controller);
    await press(true);
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: false }], [{ listen: true }]]);
    expect(useLiveStore.getState()).toMatchObject({ phase: 'idle', notice: message });
  });

  it('busy не уводит в Whisper: диалог уже идёт', async () => {
    const { controller } = fakeController({ ok: false, code: 'busy', message: S.assistant.live.busy });
    useLiveStore.getState().bind(controller);
    await press(true);
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: false }]]);
  });

  it('вид закрыли, пока шёл отказавший запуск: запись не открывает его заново', async () => {
    const { controller } = fakeController({ ok: false, code: 'no_key', message: S.assistant.live.noKey });
    controller.start.mockImplementationOnce(async () => {
      assistant.open = false;
      return { ok: false, code: 'no_key', message: S.assistant.live.noKey };
    });
    useLiveStore.getState().bind(controller);
    await press(true);
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: false }]]);
  });

  it('контроллера нет (хост не подключён): Whisper', async () => {
    await press(true);
    expect(assistant.openMode.mock.calls).toEqual([[{ listen: true }]]);
  });
});
