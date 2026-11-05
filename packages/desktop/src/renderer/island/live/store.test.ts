import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../../shared/strings.js';
import type { VoiceAnalysis, VoiceFrame } from '../assistant/voice-features.js';
import type { LiveCallPhase, LiveController, LiveControllerEvent, LiveStartResult } from './controller.js';
import { useLiveStore } from './store.js';

function fakeController(startResult: LiveStartResult = { ok: true, voiceSessionId: 'live_1' }) {
  const listeners = new Set<(event: LiveControllerEvent) => void>();
  const emit = (event: LiveControllerEvent): void => listeners.forEach((listener) => listener(event));
  const controller = {
    start: vi.fn(async () => {
      emit({ type: 'phase', phase: 'connecting' });
      if (startResult.ok) emit({ type: 'phase', phase: 'live' });
      else emit({ type: 'phase', phase: 'idle' });
      return startResult;
    }),
    stop: vi.fn(async () => {
      emit({ type: 'sessionClosed', reason: 'close_requested' });
      emit({ type: 'phase', phase: 'idle' });
    }),
    sendAppend: vi.fn(() => true),
    readVoice: vi.fn<LiveController['readVoice']>(() => false),
    subscribe: (listener: (event: LiveControllerEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => ({ phase: 'idle' as LiveCallPhase, voiceSessionId: null, humanSpeaking: false, modelPlaying: false }),
    dispose: vi.fn(),
  } satisfies LiveController;
  return { controller, emit };
}

describe('useLiveStore', () => {
  beforeEach(() => useLiveStore.getState().bind(null));

  it('toggle запускает Live, отражает фазу и сигналы речи', async () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    await useLiveStore.getState().toggle();
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(useLiveStore.getState().phase).toBe('live');
    emit({ type: 'humanSpeaking', value: true });
    emit({ type: 'modelPlaying', value: true });
    expect(useLiveStore.getState()).toMatchObject({ humanSpeaking: true, modelPlaying: true });
  });

  it('VA-13: отказ запуска кладёт понятное сообщение в notice', async () => {
    const { controller } = fakeController({ ok: false, code: 'no_key', message: S.assistant.live.noKey });
    useLiveStore.getState().bind(controller);
    await useLiveStore.getState().toggle();
    expect(useLiveStore.getState()).toMatchObject({ phase: 'idle', notice: S.assistant.live.noKey });
  });

  it('повторный toggle в live останавливает; обычное закрытие без сообщения, неожиданное — с сообщением', async () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    await useLiveStore.getState().toggle();
    await useLiveStore.getState().toggle();
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(useLiveStore.getState().notice).toBeNull();
    emit({ type: 'sessionClosed', reason: 'time_limit' });
    expect(useLiveStore.getState().notice).toBe(S.assistant.live.closed('time_limit'));
    emit({ type: 'sessionClosed', reason: 'idle_timeout' });
    expect(useLiveStore.getState().notice).toBe('Live voice ended after three minutes of silence.');
  });

  it('end завершает диалог и во время подключения; в idle и closing ничего не делает', async () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    await useLiveStore.getState().end();
    expect(controller.stop).not.toHaveBeenCalled();
    emit({ type: 'phase', phase: 'connecting' });
    await useLiveStore.getState().end();
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(useLiveStore.getState().phase).toBe('idle');
    emit({ type: 'phase', phase: 'closing' });
    await useLiveStore.getState().end();
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it('attachDelegation отражает итоги поручений и снимает их при отключении', () => {
    let listener: (() => void) | null = null;
    let current = [{ requestId: 'req-1', text: 'Rooms are quiet.', kind: 'card' as const }];
    let checking = false;
    const dismiss = vi.fn();
    const delegation = {
      items: () => [],
      results: () => current,
      checking: () => checking,
      subscribe: (callback: () => void) => {
        listener = callback;
        return () => void (listener = null);
      },
      dismiss,
      dispose: vi.fn(),
    };
    const detach = useLiveStore.getState().attachDelegation(delegation);
    expect(useLiveStore.getState().results).toEqual(current);
    expect(useLiveStore.getState().checking).toBe(false);
    checking = true;
    listener?.();
    expect(useLiveStore.getState().checking).toBe(true);
    checking = false;
    current = [];
    listener?.();
    expect(useLiveStore.getState().results).toEqual([]);
    expect(useLiveStore.getState().checking).toBe(false);
    useLiveStore.getState().dismissResult('req-1');
    expect(dismiss).toHaveBeenCalledWith('req-1');
    current = [{ requestId: 'req-2', text: 'x', kind: 'card' as const }];
    listener?.();
    checking = true;
    listener?.();
    detach();
    expect(useLiveStore.getState().results).toEqual([]);
    expect(useLiveStore.getState().checking).toBe(false);
  });

  it('без контроллера toggle ничего не делает; отвязка освобождает контроллер', async () => {
    await useLiveStore.getState().toggle();
    const { controller } = fakeController();
    const unbind = useLiveStore.getState().bind(controller);
    unbind();
    expect(controller.dispose).toHaveBeenCalled();
    expect(useLiveStore.getState().controller).toBeNull();
  });
});

describe('useLiveStore: эмоция', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLiveStore.getState().bind(null);
  });
  afterEach(() => vi.useRealTimers());

  it('по умолчанию calm; setEmotion меняет её', () => {
    expect(useLiveStore.getState().emotion).toBe('calm');
    useLiveStore.getState().setEmotion('joy');
    expect(useLiveStore.getState().emotion).toBe('joy');
  });

  it('ошибка контроллера держит error 2 с, затем calm', () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    emit({ type: 'error', code: 'oops', message: 'boom' });
    expect(useLiveStore.getState().emotion).toBe('error');
    vi.advanceTimersByTime(1999);
    expect(useLiveStore.getState().emotion).toBe('error');
    vi.advanceTimersByTime(1);
    expect(useLiveStore.getState().emotion).toBe('calm');
  });

  it('эмоция, выставленная за эти 2 с, не затирается таймером; закрытие сессии сбрасывает на calm', () => {
    const { controller, emit } = fakeController();
    useLiveStore.getState().bind(controller);
    emit({ type: 'error', code: 'oops', message: 'boom' });
    useLiveStore.getState().setEmotion('joy');
    vi.advanceTimersByTime(3000);
    expect(useLiveStore.getState().emotion).toBe('joy');
    emit({ type: 'phase', phase: 'idle' });
    expect(useLiveStore.getState().emotion).toBe('calm');
  });
});

describe('useLiveStore: voiceFrame', () => {
  const frame: VoiceFrame = { amp: 0.7, visemes: { a: 1, i: 0, u: 0, m: 0 }, pulse: 0, eyesUp: 0, blink: false, loud: 0.5 };
  const setup = (hasData: boolean) => {
    const { controller, emit } = fakeController();
    controller.readVoice.mockImplementation((time) => {
      if (hasData) time[0] = 0.25;
      return hasData;
    });
    const step = vi.fn<VoiceAnalysis['step']>(() => frame);
    const analysis = vi.fn((): VoiceAnalysis => ({ step }));
    let now = 1000;
    useLiveStore.getState().bind(controller);
    useLiveStore.getState().configureVoice({ analysis, now: () => now });
    return { controller, emit, step, analysis, advance: (ms: number) => void (now += ms) };
  };

  beforeEach(() => useLiveStore.getState().bind(null));

  it('null, пока модель не играет, и анализатор трека не читается', () => {
    const { controller, step } = setup(true);
    expect(useLiveStore.getState().voiceFrame()).toBeNull();
    expect(controller.readVoice).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
  });

  it('кадр из данных анализатора, когда модель играет; dt по часам кадра', () => {
    const { emit, step, analysis, advance } = setup(true);
    emit({ type: 'modelPlaying', value: true });
    expect(useLiveStore.getState().voiceFrame()).toBe(frame);
    expect(step.mock.calls[0]?.[0][0]).toBe(0.25);
    expect(step.mock.calls[0]?.[2]).toBeCloseTo(1 / 60);
    advance(50);
    useLiveStore.getState().voiceFrame();
    expect(step.mock.calls[1]?.[2]).toBeCloseTo(0.05);
    expect(analysis).toHaveBeenCalledTimes(1);
  });

  it('null, если в треке нет данных, и без настроенного анализа', () => {
    const empty = setup(false);
    empty.emit({ type: 'modelPlaying', value: true });
    expect(useLiveStore.getState().voiceFrame()).toBeNull();
    const ready = setup(true);
    ready.emit({ type: 'modelPlaying', value: true });
    useLiveStore.getState().configureVoice(null);
    expect(useLiveStore.getState().voiceFrame()).toBeNull();
  });
});
