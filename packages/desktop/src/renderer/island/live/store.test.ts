import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../../shared/strings.js';
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
