/**
 * Диктовка приложения (спека §3, §4): одна запись на приложение, одна нативная попытка за раз. Цели — поле сессии, поле
 * комнаты, поле Task в New session — регистрируются сами и умеют вставить текст. Хранилище решает, когда писать, куда
 * отдавать результат и что показать при ошибке. Зависимости — через `configure`: тесты подставляют свои.
 *
 * `start`, `stop` и `abort` библиотеки не упорядочены между собой, а события не несут номера попытки, поэтому
 * хранилище держит протокол §4.2 (занятость, флаг отмены после старта, таймауты, чужой `start`, долг по запоздалым `end`).
 * Без React: экран читает его через `useSyncExternalStore`.
 */
import { levelOf } from './level';
import { assembleTranscript, type ResultEvent } from './transcript';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling';

export type Fallback = { kind: 'session' | 'room'; key: string } | 'clipboard';

export interface DictationTarget {
  id: string;
  fallback: Fallback;
  /** Клавиатура поднята (поле в фокусе): тогда язык клавиатуры первым кандидатом. */
  isFocused(): boolean;
  /** Вставить расшифровку на место курсора. */
  insert(text: string): void;
  /** Экран поля сейчас в фокусе: тост на скрытом экране никто не увидит. */
  screenFocused(): boolean;
  /** Тост экрана этого поля. */
  toast(text: string): void;
}

export interface EngineEvents {
  start(): void;
  result(event: ResultEvent): void;
  nomatch(): void;
  error(code: string, message: string): void;
  end(): void;
  volume(value: number): void;
}

export interface Engine {
  /** Бросает синхронно, если нативный вызов отказал. */
  start(lang: string): void;
  stop(): void;
  abort(): void;
  releaseAudioSession(): void | Promise<void>;
  subscribe(events: EngineEvents): () => void;
}

export interface Permission {
  granted: boolean;
  canAskAgain: boolean;
  restricted: boolean;
}

export type LanguageChoice = { ok: true; lang: string } | { ok: false; reason: string; lang: string };

export interface DictationDeps {
  engine: Engine;
  permissions: { get(): Promise<Permission>; request(): Promise<Permission> };
  /** `useKeyboard: false` — только язык устройства (проверка при показе). */
  chooseLanguage(options: { useKeyboard: boolean; focused: boolean }): Promise<LanguageChoice>;
  showDenied(): void;
  showRestricted(): void;
  copy(text: string): Promise<void>;
  /** Нет ни одной живой цели для тоста: текст объявляется через VoiceOver. */
  announce(text: string): void;
  appendDraft(fallback: { kind: 'session' | 'room'; key: string }, text: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export type Availability = { state: 'unknown' } | { state: 'ready'; lang: string } | { state: 'unavailable'; reason: string; lang: string };

export interface DictationState {
  phase: DictationPhase;
  targetId: string | null;
  level: number;
  startedAt: number | null;
  /** Язык попытки (код в полоске). */
  lang: string | null;
  availability: Availability;
}

export const MAX_RECORDING_MS = 120_000;
export const START_TIMEOUT_MS = 5_000;
export const TRANSCRIBE_TIMEOUT_MS = 10_000;
export const CANCEL_TIMEOUT_MS = 3_000;
export const ERROR_END_TIMEOUT_MS = 1_000;

export const TOAST = {
  noSpeech: 'No speech detected',
  failed: 'Dictation failed',
  interrupted: 'Dictation was interrupted',
  draft: 'Dictation added to the draft',
  copied: 'Transcript copied to clipboard',
} as const;

export const reasonOnDevice = (tag: string): string =>
  `On-device dictation isn't available for ${tag}. Turn on Dictation for this language in Settings › General › Keyboard.`;
export const reasonNoLanguage = (tag: string): string => `Dictation isn't available for ${tag}.`;
export const reasonService = "Dictation is off or its language isn't downloaded. Turn on Dictation in Settings › General › Keyboard.";

const IDLE: Omit<DictationState, 'availability'> = { phase: 'idle', targetId: null, level: 0, startedAt: null, lang: null };

export function createDictation() {
  let deps: DictationDeps | null = null;
  let state: DictationState = { ...IDLE, availability: { state: 'unknown' } };
  const listeners = new Set<() => void>();
  const targets = new Map<string, DictationTarget>();

  /** Счётчик попыток до нативного `start`: отмена в ожидании разрешений делает продолжение чужим. */
  let attempt = 0;
  /** Нативная сторона занята: от вызова `start` до его `end` (или до освобождения таймаутом). */
  let nativeBusy = false;
  /** Свой `start` этой попытки ещё не приходил. */
  let awaitingStart = false;
  let afterStart: 'abort' | 'stop' | null = null;
  /** Таймаут `starting` уже вызвал `abort()`: свой поздний `start` вызовет второй, и долг вырастет (i5b). */
  let abortedByTimeout = false;
  let queued: string | null = null;
  let debt = 0;
  let suspended = false;
  let events: ResultEvent[] = [];
  let lastError: string | null = null;
  let snap: { id: string; fallback: Fallback; toast(text: string): void } | null = null;
  let startTimer: unknown = null;
  let capTimer: unknown = null;
  let transcribeTimer: unknown = null;
  let cancelTimer: unknown = null;
  let errorTimer: unknown = null;
  let unsubscribeEngine: (() => void) | null = null;

  const set = (patch: Partial<DictationState>): void => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const clear = (handle: unknown): void => {
    if (handle !== null) deps?.clearTimeout(handle);
  };
  const clearTimers = (): void => {
    clear(startTimer);
    clear(capTimer);
    clear(transcribeTimer);
    clear(cancelTimer);
    clear(errorTimer);
    startTimer = capTimer = transcribeTimer = cancelTimer = errorTimer = null;
  };
  /** Тост попытки (i2, j2): тост экрана поля, если тот в фокусе; иначе последняя зарегистрированная цель с экраном в фокусе; иначе объявление. */
  const toast = (text: string): void => {
    const own = snap === null ? undefined : targets.get(snap.id);
    const live = [...targets.values()].reverse();
    const shown = [...(own === undefined ? [] : [own]), ...live].find((t) => t.screenFocused());
    if (shown !== undefined) return shown.toast(text);
    deps?.announce(text);
  };
  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      console.warn('[parley] voice', error);
    }
  };
  const release = (): void => {
    const d = deps;
    if (d === null) return;
    guarded(() => {
      void Promise.resolve(d.engine.releaseAudioSession()).catch(() => undefined);
    });
  };
  const setIdle = (): void => set({ ...IDLE });

  const runQueued = (): void => {
    const id = queued;
    queued = null;
    if (id !== null && state.phase === 'idle') void begin(id);
  };

  const showAvailability = (choice: LanguageChoice): void =>
    set({ availability: choice.ok ? { state: 'ready', lang: choice.lang } : { state: 'unavailable', reason: choice.reason, lang: choice.lang } });

  const fail = (): void => {
    toast(TOAST.failed);
  };

  /** Нативная попытка закончилась (событие `end` или освобождение таймаутом). */
  function closeAttempt(): void {
    const wasPhase = state.phase;
    const lang = state.lang ?? '';
    const text = assembleTranscript(events);
    const error = lastError;
    clearTimers();
    nativeBusy = false;
    awaitingStart = false;
    afterStart = null;
    abortedByTimeout = false;
    release();
    setIdle();
    if (wasPhase !== 'cancelling' && wasPhase !== 'idle') {
      if (text !== '') {
        deliver(text);
        if (error === 'interrupted') toast(TOAST.interrupted);
      } else {
        emptyOutcome(error, lang);
      }
    }
    events = [];
    lastError = null;
    runQueued();
  }

  function deliver(text: string): void {
    const s = snap;
    if (s === null) return;
    const target = targets.get(s.id);
    if (target !== undefined) {
      target.insert(text);
      return;
    }
    const d = deps;
    if (d === null) return;
    if (s.fallback === 'clipboard') {
      void d.copy(text).catch(() => undefined);
      toast(TOAST.copied);
    } else {
      d.appendDraft(s.fallback, text);
      toast(TOAST.draft);
    }
  }

  /** Таблица §3.4 при пустом тексте. */
  function emptyOutcome(error: string | null, lang: string): void {
    const d = deps;
    switch (error) {
      case 'not-allowed':
        if (d === null) return;
        void d.permissions.get().then(
          (p) => (p.granted ? toast(TOAST.failed) : p.restricted ? d.showRestricted() : d.showDenied()),
          () => toast(TOAST.failed),
        );
        return;
      case 'language-not-supported': {
        const reason = reasonOnDevice(lang);
        set({ availability: { state: 'unavailable', reason, lang } });
        toast(reason);
        return;
      }
      case 'service-not-allowed':
        set({ availability: { state: 'unavailable', reason: reasonService, lang } });
        toast(reasonService);
        return;
      case null:
      case 'no-speech':
      case 'nomatch':
        toast(TOAST.noSpeech);
        return;
      case 'interrupted':
        toast(TOAST.interrupted);
        return;
      case 'aborted':
        return;
      default:
        toast(TOAST.failed);
    }
  }

  function goCancelling(): void {
    clear(startTimer);
    clear(capTimer);
    clear(transcribeTimer);
    startTimer = capTimer = transcribeTimer = null;
    set({ phase: 'cancelling', level: 0 });
    clear(cancelTimer);
    cancelTimer = deps?.setTimeout(() => {
      // Нет `end` за 3 с: нативная сторона считается свободной, запоздалый `end` ещё придёт (§4.2 п. 8, 11).
      console.warn('[parley] voice: no end after cancel');
      // Пока `start` не пришёл, долг добавит `abort()` чужого `start` (п. 10): второй раз не считаем.
      if (!awaitingStart) debt += 1;
      closeAttempt();
    }, CANCEL_TIMEOUT_MS) ?? null;
  }

  function goTranscribing(): void {
    clear(capTimer);
    capTimer = null;
    set({ phase: 'transcribing', level: 0 });
    clear(transcribeTimer);
    transcribeTimer = deps?.setTimeout(() => {
      // Нет `end` за 10 с: собранное вставляется сразу, дальше — отмена.
      const text = assembleTranscript(events);
      guarded(() => deps?.engine.abort());
      if (text !== '') deliver(text);
      else toast(TOAST.failed);
      events = [];
      goCancelling();
    }, TRANSCRIBE_TIMEOUT_MS) ?? null;
  }

  function stopRecording(): void {
    guarded(() => deps?.engine.stop());
    goTranscribing();
  }

  async function begin(id: string): Promise<void> {
    const d = deps;
    const target = targets.get(id);
    if (d === null || target === undefined) return;
    const mine = ++attempt;
    snap = { id, fallback: target.fallback, toast: (text) => target.toast(text) };
    events = [];
    lastError = null;
    afterStart = null;
    abortedByTimeout = false;
    set({ phase: 'starting', targetId: id, level: 0, startedAt: null, lang: null });
    const stale = (): boolean => mine !== attempt || deps !== d;
    try {
      let p = await d.permissions.get();
      if (stale()) return;
      if (!p.granted && !p.restricted && p.canAskAgain) {
        p = await d.permissions.request();
        if (stale()) return;
      }
      if (!p.granted) {
        setIdle();
        if (p.restricted) d.showRestricted();
        else d.showDenied();
        return;
      }
      const choice = await d.chooseLanguage({ useKeyboard: true, focused: target.isFocused() });
      if (stale()) return;
      showAvailability(choice);
      if (!choice.ok) {
        setIdle();
        toast(choice.reason);
        return;
      }
      nativeBusy = true;
      awaitingStart = true;
      set({ lang: choice.lang });
      try {
        d.engine.start(choice.lang);
      } catch (error) {
        console.warn('[parley] voice', error);
        nativeBusy = false;
        awaitingStart = false;
        setIdle();
        fail();
        return;
      }
      startTimer = d.setTimeout(() => {
        // Нет `start` и `end` за 5 с.
        guarded(() => d.engine.abort());
        abortedByTimeout = true;
        afterStart = 'abort';
        fail();
        goCancelling();
      }, START_TIMEOUT_MS);
    } catch (error) {
      if (stale()) return;
      console.warn('[parley] voice', error);
      nativeBusy = false;
      setIdle();
      fail();
    }
  }

  const onStart = (): void => {
    const d = deps;
    if (d === null || suspended) return;
    if (!awaitingStart) {
      // Чужой `start` (§4.2 п. 10): не открывает попытку; у его `abort()` есть настоящая задача, он пришлёт `end`.
      guarded(() => d.engine.abort());
      debt += 1;
      return;
    }
    awaitingStart = false;
    clear(startTimer);
    startTimer = null;
    if (afterStart === 'abort') {
      guarded(() => d.engine.abort());
      // У позднего `start` после таймаута есть настоящая задача: второй `abort()` пришлёт ещё один `end`.
      if (abortedByTimeout) debt += 1;
      return;
    }
    if (afterStart === 'stop') {
      guarded(() => d.engine.stop());
      return;
    }
    set({ phase: 'recording', level: 0, startedAt: d.now() });
    capTimer = d.setTimeout(() => stopRecording(), MAX_RECORDING_MS);
  };

  const onEnd = (): void => {
    if (deps === null || suspended) return;
    clear(errorTimer);
    errorTimer = null;
    if (state.phase === 'idle' || !nativeBusy) {
      // Запоздалый `end` прежней попытки (§4.2 п. 11).
      if (debt > 0) debt -= 1;
      return;
    }
    if (awaitingStart && lastError === null && debt > 0) {
      // Запоздалый `end` прежней попытки пришёл раньше `start` новой, в том числе после ⬆ или Cancel (§4.2 п. 11).
      debt -= 1;
      return;
    }
    closeAttempt();
  };

  const onError = (code: string): void => {
    const d = deps;
    if (d === null || suspended) return;
    // `aborted` приходит после нашего `abort()` или от чужой отменённой задачи: ни то ни другое ошибкой попытки не будет.
    if (code === 'aborted' || state.phase === 'idle' || !nativeBusy) return;
    lastError = code;
    clear(errorTimer);
    errorTimer = d.setTimeout(() => {
      // Ошибка без `end` (бывает после ошибки создания распознавателя): считаем, что `end` пришёл.
      debt += 1;
      closeAttempt();
    }, ERROR_END_TIMEOUT_MS);
  };

  const handlers: EngineEvents = {
    start: onStart,
    result(event) {
      if (suspended || (state.phase !== 'recording' && state.phase !== 'transcribing' && state.phase !== 'starting')) return;
      events.push(event);
    },
    nomatch() {
      // Шум посреди записи: попытку не завершает.
    },
    error: onError,
    end: onEnd,
    volume(value) {
      if (suspended || state.phase !== 'recording') return;
      set({ level: levelOf(value) });
    },
  };

  const cancelNow = (): void => {
    const { phase } = state;
    queued = null;
    if (phase === 'starting') {
      if (!nativeBusy) {
        attempt += 1;
        setIdle();
        return;
      }
      afterStart = 'abort';
      goCancelling();
    } else if (phase === 'recording') {
      guarded(() => deps?.engine.abort());
      goCancelling();
    }
  };

  const api = {
    getState: (): DictationState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    configure(next: DictationDeps): () => void {
      deps = next;
      unsubscribeEngine = next.engine.subscribe(handlers);
      return () => {
        if (deps !== next) return;
        cancelNow();
        clearTimers();
        unsubscribeEngine?.();
        deps = null;
      };
    },

    register(target: DictationTarget): () => void {
      // Последний зарегистрированный — в конце (для тоста снятого поля).
      targets.delete(target.id);
      targets.set(target.id, target);
      return () => {
        if (targets.get(target.id) !== target) return;
        targets.delete(target.id);
        if (state.targetId === target.id && (state.phase === 'starting' || state.phase === 'recording')) cancelNow();
      };
    },

    toggle(id: string): void {
      if (deps === null || suspended) return;
      const { phase, targetId } = state;
      if (phase === 'recording') {
        if (targetId === id) {
          stopRecording();
          return;
        }
        // Другое поле: прежняя запись отменяется, новая стартует после её `end` (одно место очереди, последнее побеждает).
        guarded(() => deps?.engine.abort());
        queued = id;
        goCancelling();
        return;
      }
      if (phase !== 'idle') return;
      void begin(id);
    },

    cancel(): void {
      cancelNow();
    },

    /** Отправка поля-цели: запуск, запись или распознавание — завершает и возвращает `true`. */
    finishBeforeSend(id: string): boolean {
      if (state.targetId !== id) return false;
      switch (state.phase) {
        case 'recording':
          stopRecording();
          return true;
        case 'starting':
          if (!nativeBusy) {
            attempt += 1;
            setIdle();
            return true;
          }
          afterStart = 'stop';
          clear(startTimer);
          startTimer = null;
          goTranscribing();
          return true;
        case 'transcribing':
          return true;
        default:
          return false;
      }
    },

    async refreshAvailability(): Promise<void> {
      const d = deps;
      if (d === null) return;
      try {
        const choice = await d.chooseLanguage({ useKeyboard: false, focused: false });
        if (deps === d) showAvailability(choice);
      } catch (error) {
        console.warn('[parley] voice', error);
      }
    },

    /** Поле спряталось, экран остался (I1): запись завершается, как от ⬆, текст встаёт в поле или черновик. */
    onHidden(id: string): void {
      if (state.targetId === id && (state.phase === 'starting' || state.phase === 'recording')) api.finishBeforeSend(id);
    },

    onBackground(): void {
      cancelNow();
    },

    onBlur(id: string): void {
      if (state.targetId === id) cancelNow();
    },

    suspend(): void {
      suspended = true;
    },
    resume(): void {
      suspended = false;
    },
  };
  return api;
}

export type Dictation = ReturnType<typeof createDictation>;

export const dictation: Dictation = createDictation();
