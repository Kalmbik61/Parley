import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import type { VoiceUi } from '../../shared/ui-types.js';
import type { TranscribeResult } from '../../shared/voice-types.js';
import { createDictationStore, MAX_RECORDING_MS, type DictationDeps, type DictationTarget } from './dictation-store.js';
import { MicError, type RecordedAudio, type Recording } from './recorder.js';

const LOUD: RecordedAudio = { pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 };

function harness(options: { voice?: VoiceUi; result?: TranscribeResult; mic?: 'granted' | 'denied' | 'not-determined'; audio?: RecordedAudio } = {}) {
  const store = createDictationStore();
  const recording: Recording & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } = {
    stop: vi.fn(async () => options.audio ?? LOUD),
    cancel: vi.fn(),
  };
  let cap: (() => void) | null = null;
  const clock = { t: 1000 };
  const deps: DictationDeps = {
    voice: {
      transcribe: vi.fn(async () => options.result ?? { text: 'hello world' }),
      micStatus: vi.fn(async () => options.mic ?? 'granted'),
      requestMic: vi.fn(async () => true),
      openMicSettings: vi.fn(async () => undefined),
    },
    settings: () => options.voice ?? { enabled: true, model: 'small', language: 'ru' },
    record: vi.fn(async () => recording),
    toast: vi.fn(),
    openVoiceSettings: vi.fn(),
    copy: vi.fn(async () => undefined),
    setTimeout: (fn) => {
      cap = fn;
      return 1;
    },
    clearTimeout: () => {
      cap = null;
    },
    now: () => clock.t,
  };
  const dispose = store.getState().configure(deps);
  const element = document.createElement('div');
  document.body.append(element);
  const target: DictationTarget & { insert: ReturnType<typeof vi.fn>; remember: ReturnType<typeof vi.fn> } = {
    id: 'room',
    element: () => element,
    remember: vi.fn(),
    insert: vi.fn(),
  };
  const unregister = store.getState().register(target);
  return { store, deps, recording, target, element, unregister, dispose, clock, fireCap: () => cap?.() };
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  for (const fn of cleanup) fn();
  document.body.replaceChildren();
});

describe('dictation-store (спека 3.2–3.4, 6)', () => {
  it('голос не настроен — toggle открывает Settings → Voice, запись не начинается', async () => {
    const h = harness({ voice: { enabled: false, model: null, language: 'auto' } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.openVoiceSettings).toHaveBeenCalled();
    expect(h.deps.record).not.toHaveBeenCalled();
  });

  it('старт → стоп: каретка запомнена, текст вставлен в цель, язык и модель — из настроек', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.store.getState()).toMatchObject({ phase: 'recording', targetId: 'room', startedAt: 1000 });
    expect(h.target.remember).toHaveBeenCalled();
    await h.store.getState().toggle('room');
    expect(h.deps.voice.transcribe).toHaveBeenCalledWith({ pcm: LOUD.pcm, language: 'ru', model: 'small' });
    expect(h.target.insert).toHaveBeenCalledWith('hello world');
    expect(h.store.getState()).toMatchObject({ phase: 'idle', targetId: null });
  });

  it('Esc во время записи — отмена, движок не зовётся, событие погашено', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(h.recording.cancel).toHaveBeenCalled();
    expect(h.deps.voice.transcribe).not.toHaveBeenCalled();
    expect(h.store.getState().phase).toBe('idle');
  });

  it('запись в другой цели отменяет прежнюю и начинает новую', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    const other = { id: 'chat', element: () => null, insert: vi.fn() };
    cleanup.push(h.store.getState().register(other));
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('chat');
    expect(h.recording.cancel).toHaveBeenCalledTimes(1);
    expect(h.store.getState()).toMatchObject({ phase: 'recording', targetId: 'chat' });
  });

  it('тишина — «No speech detected», движок не зовётся', async () => {
    const h = harness({ audio: { pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.001 } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.voice.transcribe).not.toHaveBeenCalled();
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.noSpeech);
  });

  it('ошибки движка — свои тосты; model_missing ведёт в настройки (Фокус ревью, 5)', async () => {
    const h = harness({ result: { error: 'model_missing' } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.modelMissing, expect.objectContaining({ label: S.voice.openSettings }));
    const action = vi.mocked(h.deps.toast).mock.calls[0]?.[1];
    action?.onClick();
    expect(h.deps.openVoiceSettings).toHaveBeenCalled();
    expect(h.target.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['engine_missing', S.voice.engineMissing],
    ['failed', S.voice.failed],
    ['no_speech', S.voice.noSpeech],
  ] as const)('%s → «%s»', async (error, text) => {
    const h = harness({ result: { error } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(text);
  });

  it('цель исчезла во время распознавания — текст в буфер и тост (Фокус ревью, 4)', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    h.unregister();
    await h.store.getState().toggle('room');
    // Цели нет — toggle('room') не начинает новую запись, а останавливает текущую по targetId.
    expect(h.deps.copy).toHaveBeenCalledWith('hello world');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.copied);
  });

  it('микрофон запрещён — тост с «Open System Settings», запись не начинается', async () => {
    const h = harness({ mic: 'denied' });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.micDenied, expect.objectContaining({ label: S.voice.openSystemSettings }));
  });

  it('доступ ещё не спрашивали — запрос, потом запись', async () => {
    const h = harness({ mic: 'not-determined' });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.voice.requestMic).toHaveBeenCalled();
    expect(h.store.getState().phase).toBe('recording');
  });

  it('микрофона нет — «No microphone found»', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    vi.mocked(h.deps.record).mockRejectedValueOnce(new MicError('not_found'));
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.noMicrophone);
    expect(h.store.getState().phase).toBe('idle');
  });

  it('предел 2 минуты останавливает запись и распознаёт', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(MAX_RECORDING_MS).toBe(120_000);
    h.fireCap();
    await vi.waitFor(() => expect(h.target.insert).toHaveBeenCalledWith('hello world'));
  });

  it('два toggle подряд до старта — одна запись (Фокус ревью, 2)', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await Promise.all([h.store.getState().toggle('room'), h.store.getState().toggle('room')]);
    expect(h.deps.record).toHaveBeenCalledTimes(1);
    expect(h.store.getState().phase).toBe('recording');
  });

  it('во время распознавания toggle ничего не начинает', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    let finish: (result: TranscribeResult) => void = () => undefined;
    vi.mocked(h.deps.voice.transcribe).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await h.store.getState().toggle('room');
    const stopping = h.store.getState().toggle('room');
    await vi.waitFor(() => expect(h.store.getState().phase).toBe('transcribing'));
    await h.store.getState().toggle('room');
    expect(h.deps.record).toHaveBeenCalledTimes(1);
    finish({ text: 'done' });
    await stopping;
  });

  it('cancel() during transcribing leaves the result path intact and the phase returns to idle', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    let finish: (result: TranscribeResult) => void = () => undefined;
    vi.mocked(h.deps.voice.transcribe).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await h.store.getState().toggle('room');
    const stopping = h.store.getState().toggle('room');
    await vi.waitFor(() => expect(h.store.getState().phase).toBe('transcribing'));
    h.store.getState().cancel();
    expect(h.store.getState().phase).toBe('transcribing');
    finish({ text: 'done' });
    await stopping;
    expect(h.target.insert).toHaveBeenCalledWith('done');
    expect(h.store.getState()).toMatchObject({ phase: 'idle', targetId: null });
    await h.store.getState().toggle('room');
    expect(h.store.getState().phase).toBe('recording');
  });

  it('уровень пишется в store не чаще раза в 50 мс (ворклет шлёт ~125 кадров в секунду)', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    const onLevel = vi.mocked(h.deps.record).mock.calls[0]?.[0];
    expect(onLevel).toBeDefined();
    onLevel?.(0.1);
    expect(h.store.getState().level).toBe(0.1);
    h.clock.t = 1010;
    onLevel?.(0.2);
    expect(h.store.getState().level).toBe(0.1);
    h.clock.t = 1049;
    onLevel?.(0.25);
    expect(h.store.getState().level).toBe(0.1);
    h.clock.t = 1050;
    onLevel?.(0.3);
    expect(h.store.getState().level).toBe(0.3);
  });

  it('toggleFocused: цель с фокусом; идёт запись — её стоп; нет цели — false', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    const input = document.createElement('textarea');
    h.element.append(input);
    expect(h.store.getState().toggleFocused()).toBe(false);
    input.focus();
    expect(h.store.getState().canToggleFocused()).toBe(true);
    expect(h.store.getState().toggleFocused()).toBe(true);
    await vi.waitFor(() => expect(h.store.getState().phase).toBe('recording'));
    input.blur();
    expect(h.store.getState().toggleFocused()).toBe(true);
    await vi.waitFor(() => expect(h.target.insert).toHaveBeenCalled());
  });

  describe('горячая клавиша вне поля (спека 3.4)', () => {
    const visible = (el: HTMLElement): void => {
      el.getClientRects = () => [{}] as unknown as DOMRectList;
    };

    it('фокус в body: строгий вариант — false, запись не началась', () => {
      const h = harness();
      cleanup.push(h.dispose);
      const input = document.createElement('textarea');
      h.element.append(input);
      visible(h.element);
      input.focus();
      input.blur();
      expect(document.activeElement).toBe(document.body);
      expect(h.store.getState().canToggleFocused()).toBe(false);
      expect(h.store.getState().toggleFocused()).toBe(false);
      expect(h.deps.record).not.toHaveBeenCalled();
    });

    it('фокус в постороннем элементе: строгий вариант — false', () => {
      const h = harness();
      cleanup.push(h.dispose);
      const input = document.createElement('textarea');
      h.element.append(input);
      input.focus();
      const outside = document.createElement('button');
      document.body.append(outside);
      outside.focus();
      expect(h.store.getState().canToggleFocused()).toBe(false);
      expect(h.store.getState().toggleFocused()).toBe(false);
    });

    it('fallback: видимая последняя цель — запись в неё', async () => {
      const h = harness();
      cleanup.push(h.dispose);
      const input = document.createElement('textarea');
      h.element.append(input);
      visible(h.element);
      input.focus();
      input.blur();
      expect(h.store.getState().canToggleFocused({ fallback: true })).toBe(true);
      expect(h.store.getState().toggleFocused({ fallback: true })).toBe(true);
      await vi.waitFor(() => expect(h.store.getState()).toMatchObject({ phase: 'recording', targetId: 'room' }));
    });

    it('fallback: скрытая или отключённая последняя цель — false', () => {
      const h = harness();
      cleanup.push(h.dispose);
      const input = document.createElement('textarea');
      h.element.append(input);
      input.focus();
      input.blur();
      // jsdom не раскладывает: getClientRects пуст — элемент «скрыт».
      expect(h.store.getState().canToggleFocused({ fallback: true })).toBe(false);
      expect(h.store.getState().toggleFocused({ fallback: true })).toBe(false);
      visible(h.element);
      expect(h.store.getState().canToggleFocused({ fallback: true })).toBe(true);
      h.element.remove();
      expect(h.store.getState().canToggleFocused({ fallback: true })).toBe(false);
      expect(h.store.getState().toggleFocused({ fallback: true })).toBe(false);
    });

    it('идёт запись — стоп работает и в строгом варианте', async () => {
      const h = harness();
      cleanup.push(h.dispose);
      await h.store.getState().toggle('room');
      expect(h.store.getState().canToggleFocused()).toBe(true);
      expect(h.store.getState().toggleFocused()).toBe(true);
      await vi.waitFor(() => expect(h.target.insert).toHaveBeenCalled());
    });
  });
});
