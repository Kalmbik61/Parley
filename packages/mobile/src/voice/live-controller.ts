/**
 * Live-контроллер телефона (план голосового экрана, T1): чистый TS без React и без нативных модулей. Весь ввод-вывод
 * внедряется: вызовы хоста (`call`), события хоста (`onHostEvent`), микрофон и peer (`openMic`, `createPeer`), часы и таймеры.
 * Образец — контроллер острова (`desktop/.../island/live/controller.ts` и `delegation.ts`), но вместо `requests.*` телефон
 * говорит с хостом методами `jobs.submit`, `jobs.ackInline`, `voice.session.prepare/close` и слушает `jobs.changed`.
 *
 * - Реплику поручения собирает только мост core (`createDelegationBridge`); своей сборки по `offset_ms` здесь нет.
 * - Итоги jobs этой сессии идут в очередь речи core (`commentary.append`), смена состояния — в уведомитель статуса
 *   (`thinking.append`). Отменённый job и событие с ревизией не новее виденной не озвучиваются (VO-15); итог делегации,
 *   перекрытой новой в той же сессии, помечается `stale`.
 * - Пути к `cards.decide` нет: тип `PhoneCallMap` его не содержит. Голосом карточку не решить (VO-06).
 * - Закрытие голоса job не отменяет (VO-04): `jobs.cancel` тоже не вызывается.
 * - Сигналы речи считаются по активности транскриптов канала (фрагменты по 200 мс). Громкость для роя (`level`) берётся
 *   из `getStats()` пира около 20 раз в секунду, только пока сессия live.
 * - Эмоция роя: решения Decisions разбирает общий разборщик, сглаживает общий сглаживатель; ошибка показывает `error`
 *   две секунды (как стор острова), потом возвращается желаемая эмоция.
 * Тексты, SDP и ключ не логируются: контроллер ничего не пишет в консоль.
 */
import {
  buildAppend,
  createAckTracker,
  createDelegationBridge,
  createEmotionSmoother,
  createEventDeduper,
  createIdleCloser,
  createSourceOffsets,
  createSpeechQueue,
  createStatusNotifier,
  parseLiveEvent,
  type AckTracker,
  type DelegationBridge,
  type EmotionSmoother,
  type IdleCloser,
  type ResultInput,
  type SpeechPhrases,
  type SourceOffsets,
  type SpeechQueue,
  type StatusInput,
  type StatusNotifier,
} from '@parley/core/voice-live';
import type { SwarmEmotion } from '@parley/core/swarm';
import type { PhoneJob, PhoneJobContext, VoiceMethodResults, VoicePrepareResult } from '@parley/protocol/remote';
import { NO_LEVELS, readAudioLevels, type AudioLevels } from './audio-levels';
import type { VoiceEvent } from './voice-model.js';

export type LiveCallPhase = 'idle' | 'connecting' | 'live' | 'closing';

export type LiveFailure = 'no_key' | 'limit_reached' | 'busy' | 'mic' | 'failed';

export type LiveStartResult = { ok: true; voiceSessionId: string } | { ok: false; code: LiveFailure; message: string };

/** Единственные методы хоста, которые зовёт контроллер. `cards.decide` и `jobs.cancel` здесь нет намеренно. */
export interface PhoneCallMap {
  'jobs.submit': {
    params: { text: string; idempotencyKey: string; correlation: { voiceSessionId: string; delegationId: string; turnId: string }; context?: PhoneJobContext };
    result: VoiceMethodResults['jobs.submit'];
  };
  'jobs.ackInline': { params: { jobId: string; revision: number }; result: unknown };
  'voice.session.prepare': { params: { sdp: string }; result: VoicePrepareResult };
  'voice.session.close': { params: { voiceSessionId: string }; result: VoiceMethodResults['voice.session.close'] };
}

const CONTEXT_TURNS = 6;
const CONTEXT_TURN_CHARS = 300;

/**
 * Реплики моста (`{role, text}`, у части версий ещё `at`) в форму `jobs.submit`: только роль и текст, пустые и чужие
 * роли отброшены, текст до 300 знаков, последние 6. Нет ни одной реплики — `undefined`, поле не шлётся.
 */
export function phoneContextOf(context: unknown): PhoneJobContext | undefined {
  const raw = typeof context === 'object' && context !== null ? (context as { recentTurns?: unknown }).recentTurns : undefined;
  if (!Array.isArray(raw)) return undefined;
  const recentTurns: PhoneJobContext['recentTurns'] = [];
  for (const turn of raw as unknown[]) {
    if (typeof turn !== 'object' || turn === null) continue;
    const { role, text } = turn as { role?: unknown; text?: unknown };
    if ((role !== 'human' && role !== 'assistant') || typeof text !== 'string' || text === '') continue;
    recentTurns.push({ role, text: text.slice(0, CONTEXT_TURN_CHARS) });
  }
  return recentTurns.length === 0 ? undefined : { recentTurns: recentTurns.slice(-CONTEXT_TURNS) };
}

/** Хост на 0.30.0 и старше не знает поле `context` и отвечает `bad_request`; job он при этом не создаёт. */
const isBadRequest = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'bad_request';

export interface PhoneHostEvents {
  'jobs.changed': { job: PhoneJob };
  'voice.session.closed': { voiceSessionId: string; reason: string };
}

/** Минимум от канала данных и peer: тесты подставляют заглушки, `live-peer.ts` — react-native-webrtc. */
export interface LiveChannel {
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface LivePeer {
  connectionState: string;
  localDescription: { sdp?: string } | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: unknown, stream: unknown): unknown;
  createDataChannel(label: string): LiveChannel;
  createOffer(): Promise<unknown>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  close(): void;
  /** Отчёты WebRTC (в react-native-webrtc — `Map`); читает `audio-levels.ts`. */
  getStats(): Promise<unknown>;
}
/** Открытый микрофон вместе с аудиосессией телефона; `stop()` освобождает и дорожки, и аудиосессию. */
export interface LiveMic {
  addTo(peer: LivePeer): void;
  stop(): void;
}

export interface LiveControllerDeps {
  call<M extends keyof PhoneCallMap>(method: M, params: PhoneCallMap[M]['params']): Promise<PhoneCallMap[M]['result']>;
  onHostEvent<E extends keyof PhoneHostEvents>(event: E, listener: (data: PhoneHostEvents[E]) => void): () => void;
  /** Разрешение микрофона запрашивается внутри; отказ или ошибка — `mic`. */
  openMic(): Promise<LiveMic>;
  createPeer(): LivePeer;
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
  setTick(callback: () => void, ms: number): () => void;
  phrases: SpeechPhrases;
  fallbackText: string;
  connectTimeoutMs?: number;
}

export interface LiveSnapshot {
  phase: LiveCallPhase;
  voiceSessionId: string | null;
  /** Jobs этой сессии, которые ещё в работе (в очереди, идут или ждут подтверждения). */
  jobs: PhoneJob[];
  humanSpeaking: boolean;
  modelPlaying: boolean;
  /** Эмоция роя: сглаженное решение Decisions или `error` во время вспышки. */
  emotion: SwarmEmotion;
  /** Есть job этой сессии без итога (в очереди или идёт). */
  checking: boolean;
}

export interface LiveController {
  start(): Promise<LiveStartResult>;
  stop(): Promise<void>;
  /** `ackInline` уходит только при `foreground && !muted`. */
  setForeground(value: boolean): void;
  setMuted(value: boolean): void;
  /** События для `reduceVoice` (`voice-model.ts`). */
  subscribe(listener: (event: VoiceEvent) => void): () => void;
  /** Любое изменение снимка (фаза, jobs, сигналы речи). */
  onChange(listener: () => void): () => void;
  snapshot(): LiveSnapshot;
  /** Громкость 0..1: голос модели, пока он играет, иначе микрофон, пока говорит человек и он не заглушён, иначе 0. */
  level(): number;
  /** Смена `level()`; не чаще одного раза за опрос статистики. */
  onLevel(listener: (level: number) => void): () => void;
  dispose(): void;
}

export const CONNECT_TIMEOUT_MS = 15_000;
export const TICK_MS = 250;
/** Период опроса громкости из `getStats()`; движок и так сглаживает уровень. */
export const LEVEL_POLL_MS = 100;
/** Опрос, не ответивший за это время, бросается: следующий может начаться, а поздний ответ игнорируется. */
export const LEVEL_POLL_TIMEOUT_MS = 1000;
/** Сколько лицо держит `error` после ошибки, мс (как `ERROR_EMOTION_MS` острова). */
export const ERROR_EMOTION_MS = 2000;
/** Сколько тишины в транскрипте, чтобы считать речь законченной. */
export const SPEECH_HOLD_MS = 800;
/** У моста телефона нет разговоров острова: поле нужно только типу `BridgeSubmitInput`. */
const CONVERSATION_ID = 'phone';

/** Тексты для отказов: коротко и без технических подробностей хоста (VA-13). */
export const LIVE_MESSAGES: Readonly<Record<LiveFailure, string>> = {
  no_key: 'No OpenAI key on the Mac',
  limit_reached: 'Daily voice limit reached',
  busy: 'Voice is busy',
  mic: 'Microphone is not available',
  failed: 'Voice could not connect',
};

/** cyrb53: быстрый детерминированный хеш строки в 53 бита. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Ключ идемпотентности делегации: короткий хеш `voiceSessionId`+`delegationId`, проходит `REMOTE_ID_RE` (≤ 25 знаков). */
export function idempotencyKeyOf(voiceSessionId: string, delegationId: string): string {
  const source = `${voiceSessionId}\u0000${delegationId}`;
  return `dg_${cyrb53(source, 0).toString(36)}${cyrb53(source, 1).toString(36)}`;
}

const isOpen = (job: PhoneJob): boolean => job.state === 'queued' || job.state === 'running' || job.state === 'needs_confirmation';
/** Работа идёт: только это держит сессию от автозакрытия (карточка в ожидании подтверждения её не держит, как на острове). */
const isWorking = (job: PhoneJob): boolean => job.state === 'queued' || job.state === 'running';
/** Делегация закончена для модели: итог получен или job ждёт решения человека (сфера покажет карточку по job). */
const isEnded = (job: PhoneJob): boolean => job.state !== 'queued' && job.state !== 'running';

/** Сессия Live: всё, что живёт между открытием и закрытием канала. */
interface Live {
  voiceSessionId: string;
  peer: LivePeer;
  channel: LiveChannel;
  mic: LiveMic;
  bridge: DelegationBridge;
  ack: AckTracker;
  queue: SpeechQueue;
  status: StatusNotifier;
  /** Автозакрытие по тишине (VA-12). */
  idle: IdleCloser;
  /** Последний вид каждого job этой сессии. */
  jobs: Map<string, PhoneJob>;
  /** Самая новая виденная ревизия job (VO-15). */
  revisions: Map<string, number>;
  /** Делегации этой сессии по порядку; все, кроме последней, перекрыты. */
  delegations: string[];
  /** Делегации, чьё `delegateStart` ещё не закрыто. */
  openDelegations: Set<string>;
  /** `clientEventId` отправленного итога → что отметить `ackInline`, когда придёт `appended`. */
  pendingAcks: Map<string, { jobId: string; revision: number }>;
  stopTick: () => void;
  /** Остановка опроса громкости. */
  stopPoll: () => void;
  /** Опрос `getStats()` уже идёт (с момента `deps.now()`): новый не начинается, пока тот не ответил или не истёк. */
  polling: number | null;
  levels: AudioLevels;
  smoother: EmotionSmoother;
  offsets: SourceOffsets;
  cancelTimer: () => void;
  /** Разбудить ожидание открытия канала (закрытие сессии посреди подключения не должно его повесить). */
  settleOpen: (opened: boolean) => void;
  humanSpeaking: boolean;
  modelPlaying: boolean;
  lastHumanAt: number;
  lastModelAt: number;
  closedEmitted: boolean;
}

export function createLiveController(deps: LiveControllerDeps): LiveController {
  const listeners = new Set<(event: VoiceEvent) => void>();
  const changeListeners = new Set<() => void>();
  let phase: LiveCallPhase = 'idle';
  let live: Live | null = null;
  let generation = 0;
  let appendCounter = 0;
  let foreground = true;
  let muted = false;
  let wanted: SwarmEmotion = 'calm';
  let cancelFlash: (() => void) | null = null;
  let currentLevel = 0;
  const levelListeners = new Set<(level: number) => void>();

  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // подписчик не должен ломать остальных
    }
  };
  const emit = (event: VoiceEvent): void => {
    for (const listener of [...listeners]) guarded(() => listener(event));
  };
  const changed = (): void => {
    for (const listener of [...changeListeners]) guarded(listener);
  };
  /** Фаза может смениться за `await`: чтение через функцию не даёт TS сузить её по прошлой проверке. */
  const currentPhase = (): LiveCallPhase => phase;
  const emotion = (): SwarmEmotion => (cancelFlash !== null ? 'error' : wanted);
  const setWanted = (next: SwarmEmotion): void => {
    if (wanted === next) return;
    wanted = next;
    if (cancelFlash === null) changed();
  };
  const clearFlash = (): void => {
    cancelFlash?.();
    cancelFlash = null;
  };
  /** Ошибка: лицо показывает `error` две секунды, потом возвращается желаемая эмоция. */
  const flashError = (): void => {
    clearFlash();
    const cancel = deps.setTimer(() => {
      if (cancelFlash !== cancel) return;
      cancelFlash = null;
      changed();
    }, ERROR_EMOTION_MS);
    cancelFlash = cancel;
    changed();
  };
  /** Громкость по правилу экрана; в `idle`/без сессии — 0. */
  const computeLevel = (): number => {
    if (live === null) return 0;
    const raw = live.modelPlaying ? live.levels.model : live.humanSpeaking && !muted ? live.levels.mic : 0;
    return Math.round(raw * 100) / 100;
  };
  const updateLevel = (): void => {
    const next = computeLevel();
    if (next === currentLevel) return;
    currentLevel = next;
    for (const listener of [...levelListeners]) guarded(() => listener(next));
  };
  const setPhase = (next: LiveCallPhase): void => {
    if (phase === next) return;
    phase = next;
    changed();
  };

  const refuse = (code: LiveFailure): LiveStartResult => {
    if (code !== 'limit_reached') flashError();
    emit({ type: code === 'limit_reached' ? 'limitReached' : 'fail' });
    return { ok: false, code, message: LIVE_MESSAGES[code] };
  };
  /** Отказ без события модели: `stop()` уже перевёл её в idle. */
  const refuseQuietly = (code: LiveFailure): LiveStartResult => ({ ok: false, code, message: LIVE_MESSAGES[code] });

  const teardown = (target: Live): void => {
    target.stopTick();
    target.stopPoll();
    target.smoother.reset();
    target.cancelTimer();
    target.settleOpen(false);
    target.idle.stop();
    target.bridge.dispose();
    target.queue.sessionEnded();
    target.channel.onopen = target.channel.onclose = target.channel.onmessage = null;
    target.peer.onconnectionstatechange = null;
    try {
      target.channel.close();
    } catch {
      // уже закрыт
    }
    try {
      target.peer.close();
    } catch {
      // уже закрыт
    }
    target.mic.stop();
    if (live === target) {
      live = null;
      wanted = 'calm';
      updateLevel();
    }
  };

  /** Один конец сессии, с какой бы стороны он ни пришёл (хост, канал, обрыв, `stop()`). */
  const finish = (target: Live, reason: string, closeHost = true): void => {
    if (target.closedEmitted) return;
    target.closedEmitted = true;
    clearFlash();
    // Хост должен узнать о конце сессии, иначе Mac продолжит считать минуты. Не нужно, если закрыл он сам или `stop()` уже звал close.
    if (closeHost) void deps.call('voice.session.close', { voiceSessionId: target.voiceSessionId }).catch(() => {});
    teardown(target);
    setPhase('idle');
    // Дневной лимит хост называет причиной закрытия: экран должен показать «Daily voice limit reached», а не уйти в idle.
    const failed = reason === 'connection_lost' || reason === 'channel_closed';
    if (failed) flashError();
    else changed();
    emit({ type: failed ? 'fail' : reason === 'daily_limit' ? 'limitReached' : 'stop' });
  };

  const sendAppend = (target: Live, kind: 'thinking' | 'commentary', delegationId: string | null, content: string): string | null => {
    if (target.channel.readyState !== 'open') return null;
    appendCounter += 1;
    const eventId = `phone_${appendCounter}`;
    try {
      target.channel.send(JSON.stringify(buildAppend({ kind, delegationId, content, eventId })));
      return eventId;
    } catch {
      return null;
    }
  };

  const endDelegation = (target: Live, delegationId: string): void => {
    if (!target.openDelegations.delete(delegationId)) return;
    emit({ type: 'delegateEnd' });
  };

  const toResult = (target: Live, job: PhoneJob): ResultInput => {
    const delegationId = 'delegationId' in job.correlation ? job.correlation.delegationId : null;
    const terminal = job.state !== 'queued' && job.state !== 'running';
    return {
      requestId: job.jobId,
      jobId: job.jobId,
      revision: job.revision,
      state: job.state,
      text: job.resultSummary ?? '',
      gate: 'open',
      heldSince: null,
      stale: job.state === 'cancelled' || isSuperseded(target, delegationId),
      delegationId,
      deliveredLive: terminal && job.deliveredInline,
    };
  };
  const toStatus = (target: Live, job: PhoneJob): StatusInput => {
    const delegationId = 'delegationId' in job.correlation ? job.correlation.delegationId : null;
    return {
      requestId: job.jobId,
      text: job.requestText,
      state: job.state,
      stale: job.state === 'cancelled' || isSuperseded(target, delegationId),
      createdAt: job.createdAt,
      delegationId,
    };
  };
  function isSuperseded(target: Live, delegationId: string | null): boolean {
    if (delegationId === null) return false;
    const index = target.delegations.indexOf(delegationId);
    return index !== -1 && index < target.delegations.length - 1;
  }

  /** Отдаёт очереди и уведомителю последний вид всех jobs сессии и делает шаг. */
  const pump = (target: Live): void => {
    const jobs = [...target.jobs.values()];
    target.queue.observe(jobs.map((job) => toResult(target, job)));
    target.status.observe(jobs.map((job) => toStatus(target, job)));
    target.queue.step();
    target.status.step();
  };

  const onJobChanged = (job: PhoneJob): void => {
    const target = live;
    if (target === null || !('voiceSessionId' in job.correlation) || job.correlation.voiceSessionId !== target.voiceSessionId) return;
    // VO-15: событие не новее уже виденной ревизии ничего не меняет и не озвучивается.
    const seen = target.revisions.get(job.jobId);
    if (seen !== undefined && job.revision <= seen) return;
    target.revisions.set(job.jobId, job.revision);
    target.jobs.set(job.jobId, job);
    if (isEnded(job)) endDelegation(target, job.correlation.delegationId);
    pump(target);
    changed();
  };

  const setSpeech = (target: Live, who: 'human' | 'model', value: boolean): void => {
    if (who === 'human') {
      if (target.humanSpeaking === value) return;
      target.humanSpeaking = value;
      target.queue.setHumanSpeaking(value);
      target.idle.humanSpeaking(value);
      // Человек договорил, а модель ещё не говорит: Live готовит ответ.
      if (!value && !target.modelPlaying) emit({ type: 'thinking' });
    } else {
      if (target.modelPlaying === value) return;
      target.modelPlaying = value;
      target.queue.setModelPlaying(value);
      target.ack.modelPlaying(value);
      target.idle.modelPlaying(value);
      target.smoother.setPlaying(value);
      emit({ type: value ? 'speechStart' : 'speechEnd' });
    }
    updateLevel();
    changed();
  };

  const tick = (target: Live): void => {
    const at = deps.now();
    if (target.humanSpeaking && at - target.lastHumanAt >= SPEECH_HOLD_MS) setSpeech(target, 'human', false);
    if (target.modelPlaying && at - target.lastModelAt >= SPEECH_HOLD_MS) setSpeech(target, 'model', false);
    target.ack.tick();
    target.idle.step();
    pump(target);
  };

  /** Один опрос громкости; наложение запросов и ответ после закрытия сессии отбрасываются. */
  const poll = (target: Live): void => {
    if (live !== target || target.closedEmitted) return;
    const at = deps.now();
    if (target.polling !== null && at - target.polling < LEVEL_POLL_TIMEOUT_MS) return;
    target.polling = at;
    void readAudioLevels(target.peer).then((levels) => {
      // Ответ брошенного опроса (за него уже начат другой) не трогает ни уровни, ни флаг.
      if (target.polling !== at) return;
      target.polling = null;
      if (live !== target || target.closedEmitted) return;
      target.levels = levels;
      updateLevel();
    });
  };

  const handleChannelMessage = (target: Live, deduper: ReturnType<typeof createEventDeduper>, data: unknown): void => {
    const parsed = parseLiveEvent(data);
    if (parsed === null || !deduper.accept(parsed.eventId)) return;
    const event = parsed.event;
    switch (event.type) {
      case 'sessionClosed':
        finish(target, event.reason);
        return;
      case 'inputTranscript':
        target.lastHumanAt = deps.now();
        setSpeech(target, 'human', true);
        target.bridge.handle({ type: 'inputTranscript', text: event.text, startMs: event.startMs, endMs: event.endMs });
        return;
      case 'emotion':
        target.smoother.decision({ value: event.value, confidence: event.confidence, sourceEndMs: target.offsets.endOf(event.sourceEventId) });
        return;
      case 'error':
        flashError();
        return;
      case 'outputTranscript':
        target.offsets.remember(parsed.eventId, event.endMs);
        target.lastModelAt = deps.now();
        setSpeech(target, 'model', true);
        target.bridge.handle({ type: 'outputTranscript', text: event.text, startMs: event.startMs, endMs: event.endMs });
        target.queue.outputText(event.text);
        return;
      case 'delegationCreated':
        target.delegations.push(event.delegationId);
        target.idle.activity();
        target.bridge.handle({ type: 'delegationCreated', delegationId: event.delegationId, offsetMs: event.offsetMs });
        // Предыдущие делегации теперь перекрыты: их ещё не озвученные итоги отбрасываются очередью.
        pump(target);
        return;
      case 'appended': {
        if (event.kind !== 'commentary') return;
        // Подтверждение приходит по `clientEventId`; без него — самый ранний отправленный итог.
        const key = event.clientEventId !== null && target.pendingAcks.has(event.clientEventId) ? event.clientEventId : target.pendingAcks.keys().next().value;
        if (key === undefined) return;
        const pending = target.pendingAcks.get(key);
        target.pendingAcks.delete(key);
        if (pending !== undefined && foreground && !muted) void deps.call('jobs.ackInline', pending).catch(() => {});
        return;
      }
      default:
        return;
    }
  };

  /** Собирает сессию сразу после ответа хоста: события канала могут прийти раньше его открытия. */
  const openSession = (voiceSessionId: string, peer: LivePeer, channel: LiveChannel, mic: LiveMic): Live => {
    const ack = createAckTracker({ now: deps.now });
    let lastSentId: string | null = null;
    // Живая сессия нужна замыканиям до своего создания: ссылка берётся лениво.
    const self = (): Live => target;
    const queue = createSpeechQueue({
      now: deps.now,
      phrases: deps.phrases,
      canAppend: (delegationId, purpose) => ack.canAppend(delegationId, purpose),
      effects: {
        send: ({ delegationId, content }) => {
          lastSentId = sendAppend(self(), 'commentary', delegationId, content);
          return lastSentId !== null;
        },
        // Итог ушёл в Live; отметка `ackInline` — когда придёт `appended` с этим `clientEventId`.
        ack: (jobId, revision) => {
          if (lastSentId !== null) self().pendingAcks.set(lastSentId, { jobId, revision });
        },
        cardShown: () => {},
        changed,
      },
    });
    const status = createStatusNotifier({
      now: deps.now,
      canAppend: (delegationId, purpose) => ack.canAppend(delegationId, purpose),
      send: ({ delegationId, content }) => sendAppend(self(), 'thinking', delegationId, content) !== null,
    });
    const bridge = createDelegationBridge(
      {
        conversationId: CONVERSATION_ID,
        voiceSessionId,
        now: deps.now,
        setTimer: deps.setTimer,
        fallbackText: deps.fallbackText,
        submit: async (input) => {
          const params = {
            text: input.text,
            idempotencyKey: idempotencyKeyOf(voiceSessionId, input.delegationId),
            correlation: { voiceSessionId, delegationId: input.delegationId, turnId: input.delegationId },
          };
          const context = phoneContextOf(input.context);
          let result: VoiceMethodResults['jobs.submit'];
          if (context === undefined) {
            result = await deps.call('jobs.submit', params);
          } else {
            try {
              result = await deps.call('jobs.submit', { ...params, context });
            } catch (error) {
              // Мак постарше отверг лишний ключ: один повтор без `context`, тот же ключ и связь. Прочие ошибки — как раньше.
              if (!isBadRequest(error)) throw error;
              result = await deps.call('jobs.submit', params);
            }
          }
          return { requestId: result.jobId, jobId: result.jobId, created: true };
        },
      },
      {
        delegationOpened: ({ delegationId }) => {
          ack.open(delegationId);
          self().openDelegations.add(delegationId);
          emit({ type: 'delegateStart' });
        },
        submitFailed: ({ delegationId }) => endDelegation(self(), delegationId),
      },
    );
    // Занято: идёт делегация или job, речь ждёт очереди или подтверждения.
    const idle = createIdleCloser({
      now: deps.now,
      busy: () =>
        self().openDelegations.size > 0 ||
        [...self().jobs.values()].some(isWorking) ||
        queue.items().some((item) => item.speech === 'queued' || item.speech === 'submitted') ||
        ack.awaiting().length > 0,
      onIdle: () => void stopLive().catch(() => {}),
    });
    const smoother = createEmotionSmoother({ now: deps.now, setTimer: deps.setTimer, apply: setWanted });
    const target: Live = {
      voiceSessionId,
      peer,
      channel,
      mic,
      bridge,
      ack,
      queue,
      status,
      idle,
      jobs: new Map(),
      revisions: new Map(),
      delegations: [],
      openDelegations: new Set(),
      pendingAcks: new Map(),
      stopTick: () => {},
      stopPoll: () => {},
      polling: null,
      levels: NO_LEVELS,
      smoother,
      offsets: createSourceOffsets(),
      cancelTimer: () => {},
      settleOpen: () => {},
      humanSpeaking: false,
      modelPlaying: false,
      lastHumanAt: 0,
      lastModelAt: 0,
      closedEmitted: false,
    };
    live = target;
    target.stopTick = deps.setTick(() => tick(target), TICK_MS);
    return target;
  };

  /** `stop()` и автозакрытие: общий путь. */
  async function stopLive(): Promise<void> {
    generation += 1;
    const target = live;
    if (target === null) {
      // Идёт подготовка (до ответа хоста): `start` увидит смену поколения и сам закроет сессию.
      if (phase !== 'idle') {
        setPhase('idle');
        emit({ type: 'stop' });
      }
      return;
    }
    // Сначала освобождаем микрофон и peer, потом просим хост закрыть сессию (без ожидания ответа): молчащий хост не держит микрофон.
    setPhase('closing');
    finish(target, 'close_requested');
  }

  const unsubscribeJobs = deps.onHostEvent('jobs.changed', (data) => onJobChanged(data.job));
  const unsubscribeClosed = deps.onHostEvent('voice.session.closed', (data) => {
    if (live !== null && live.voiceSessionId === data.voiceSessionId) finish(live, data.reason, false);
  });

  return {
    async start() {
      if (phase !== 'idle') return refuseQuietly('busy');
      const mine = ++generation;
      const deduper = createEventDeduper();
      emit({ type: 'start' });
      setPhase('connecting');
      const abandon = (code: LiveFailure): LiveStartResult => {
        if (mine !== generation) return refuseQuietly(code);
        setPhase('idle');
        return refuse(code);
      };

      let mic: LiveMic;
      try {
        mic = await deps.openMic();
      } catch {
        return abandon('mic');
      }
      if (mine !== generation || currentPhase() !== 'connecting') {
        mic.stop();
        return refuseQuietly('busy');
      }

      const peer = deps.createPeer();
      const channel = peer.createDataChannel('oai-events');
      mic.addTo(peer);

      let voiceSessionId: string | null = null;
      /** Сессия, созданная именно этим вызовом: `catch` разбирает только её, а не глобальную `live`. */
      let own: Live | null = null;
      const closeHostSession = (): void => {
        if (voiceSessionId !== null) void deps.call('voice.session.close', { voiceSessionId }).catch(() => {});
      };
      const dropLocal = (): void => {
        channel.onopen = channel.onclose = channel.onmessage = null;
        peer.onconnectionstatechange = null;
        try {
          channel.close();
        } catch {
          // уже закрыт
        }
        try {
          peer.close();
        } catch {
          // уже закрыт
        }
        mic.stop();
      };

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const sdp = peer.localDescription?.sdp;
        if (typeof sdp !== 'string' || sdp === '') throw new Error('no offer');
        const prepared = await deps.call('voice.session.prepare', { sdp });
        if (!prepared.ok) {
          dropLocal();
          // Текст ошибки хоста не показываем: он может быть техническим.
          return abandon(prepared.code === 'no_key' || prepared.code === 'limit_reached' || prepared.code === 'busy' ? prepared.code : 'failed');
        }
        voiceSessionId = prepared.voiceSessionId;
        const answerSdp = prepared.sdpAnswer;

        if (mine !== generation) {
          // stop() пришёл, пока создавалась сессия: закрываем её на хосте, глобальную `live` (она может быть чужой) не трогаем.
          closeHostSession();
          dropLocal();
          return refuseQuietly('busy');
        }
        const target = openSession(prepared.voiceSessionId, peer, channel, mic);
        own = target;
        channel.onmessage = (event) => handleChannelMessage(target, deduper, event.data);
        channel.onclose = () => finish(target, 'channel_closed');
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            finish(target, 'connection_lost');
          }
        };

        const opened = new Promise<boolean>((resolve) => {
          const cancel = deps.setTimer(() => resolve(false), deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
          target.cancelTimer = cancel;
          target.settleOpen = resolve;
          channel.onopen = () => {
            cancel();
            resolve(true);
          };
        });
        await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        if (!(await opened)) {
          // Закрыли посреди подключения (хост, обрыв, stop): событие модели уже было, второе не нужно.
          if (target.closedEmitted) return refuseQuietly('failed');
          // Сессию могли уже закрыть (stop, хост, обрыв): тогда хост и ресурсы освобождены.
          if (!target.closedEmitted && live === target) {
            closeHostSession();
            teardown(target);
          }
          return abandon('failed');
        }
        if (mine !== generation || target.closedEmitted) return refuseQuietly('busy');
        // После открытия канала таймер подключения не нужен; обрыв канала закрывает сессию через `onclose`.
        channel.onopen = null;
        target.idle.start();
        target.stopPoll = deps.setTick(() => poll(target), LEVEL_POLL_MS);
        setPhase('live');
        emit({ type: 'connected' });
        return { ok: true, voiceSessionId: target.voiceSessionId };
      } catch {
        if (own !== null && own.closedEmitted) return refuseQuietly('failed');
        closeHostSession();
        if (own !== null) teardown(own);
        else dropLocal();
        return abandon('failed');
      }
    },

    stop: stopLive,

    setForeground(value) {
      foreground = value;
    },
    setMuted(value) {
      muted = value;
      updateLevel();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => void changeListeners.delete(listener);
    },

    snapshot: () => ({
      phase,
      voiceSessionId: live?.voiceSessionId ?? null,
      jobs: live === null ? [] : [...live.jobs.values()].filter(isOpen),
      humanSpeaking: live?.humanSpeaking ?? false,
      modelPlaying: live?.modelPlaying ?? false,
      emotion: emotion(),
      checking: live !== null && [...live.jobs.values()].some(isWorking),
    }),
    level: () => currentLevel,
    onLevel(listener) {
      levelListeners.add(listener);
      return () => void levelListeners.delete(listener);
    },

    dispose() {
      unsubscribeJobs();
      unsubscribeClosed();
      generation += 1;
      const target = live;
      if (target !== null) {
        void deps.call('voice.session.close', { voiceSessionId: target.voiceSessionId }).catch(() => {});
        teardown(target);
      }
      clearFlash();
      listeners.clear();
      changeListeners.clear();
      levelListeners.clear();
    },
  };
}
