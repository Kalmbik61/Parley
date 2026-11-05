/**
 * Live-контроллер острова (T3): WebRTC-узел, микрофон, воспроизведение, канал данных `oai-events`, два локальных сигнала
 * речи и методы отправки `thinking.append` / `commentary.append`. Тонкая обвязка над чистыми `events.ts` и `levels.ts`.
 *
 * Чего здесь нет (это T4): мост делегаций, очередь речи, отправка Request. Контроллер только отдаёт типизированные
 * события и сигналы остальному renderer. Перебивание у GPT-Live нативное: контроллер ничего не глушит и не блокирует.
 *
 * Ключ OpenAI живёт на хосте: сюда приходит только SDP-ответ. Аудио, транскрипты и ключ нигде не логируются.
 */
import type { IslandBridge } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import { buildAppend, createEventDeduper, parseLiveEvent, type AppendKind, type LiveEvent } from './events.js';
import { humanSpeakingHysteresis, modelPlayingHysteresis, rms, type Hysteresis } from './levels.js';

export type LiveCallPhase = 'idle' | 'connecting' | 'live' | 'closing';

export type LiveFailure = 'no_key' | 'limit_reached' | 'busy' | 'mic' | 'failed';

export type LiveStartResult = { ok: true; voiceSessionId: string } | { ok: false; code: LiveFailure; message: string };

/** События для остального renderer: события протокола плюс два сигнала речи и смена фазы. */
export type LiveControllerEvent =
  | Extract<LiveEvent, { type: 'delegationCreated' | 'inputTranscript' | 'outputTranscript' | 'sessionClosed' | 'error' | 'appended' | 'usage' }>
  | { type: 'humanSpeaking'; value: boolean }
  | { type: 'modelPlaying'; value: boolean }
  | { type: 'phase'; phase: LiveCallPhase };

export interface LiveSignals {
  humanSpeaking: boolean;
  modelPlaying: boolean;
}

export interface LiveSnapshot extends LiveSignals {
  phase: LiveCallPhase;
  voiceSessionId: string | null;
}

/** Минимум от браузерных объектов, который нужен контроллеру: тесты подставляют заглушки. */
export interface LiveDataChannel {
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
  ontrack: ((event: { streams: readonly unknown[] }) => void) | null;
  addTrack(track: unknown, stream: unknown): unknown;
  createDataChannel(label: string): LiveDataChannel;
  createOffer(): Promise<unknown>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  close(): void;
}
export interface LiveMicStream {
  getAudioTracks(): Array<{ stop(): void }>;
}
/** Измеритель уровня потока: `read()` — текущий RMS (0…1); `stop()` освобождает граф. */
export interface LevelMeter {
  read(): number;
  /** Время и спектр того же анализатора (fftSize 2048) для лица, как у шины голоса TTS; `false` — данных нет. */
  frame?(time: Float32Array<ArrayBuffer>, freq: Float32Array<ArrayBuffer>): boolean;
  stop(): void;
}
export interface LiveSink {
  attach(stream: unknown): void;
  stop(): void;
}

export interface LiveControllerDeps {
  call: IslandBridge['call'];
  onHostEvent: IslandBridge['on'];
  /** `true`, если микрофон разрешён (запрос разрешения — внутри). */
  ensureMic(): Promise<boolean>;
  openMic(): Promise<LiveMicStream>;
  createPeer(): LivePeer;
  /** Измеритель уровня потока (микрофон или удалённый трек). */
  meter(stream: unknown): LevelMeter;
  /** Воспроизведение удалённого трека. */
  sink(): LiveSink;
  now(): number;
  /** Опрос уровней, мс. */
  setTick(callback: () => void, ms: number): () => void;
  /** Сколько ждать открытия канала данных после ответа SDP. */
  connectTimeoutMs?: number;
  setTimer?(callback: () => void, ms: number): () => void;
}

export const TICK_MS = 40;
export const CONNECT_TIMEOUT_MS = 15_000;

/** Сообщения VA-13: нет ключа или лимит — понятный текст, а голосовой ход (Whisper + TTS) и текст продолжают работать. */
export const LIVE_MESSAGES: Readonly<Record<LiveFailure, string>> = {
  no_key: S.assistant.live.noKey,
  limit_reached: S.assistant.live.limitReached,
  busy: S.assistant.live.busy,
  mic: S.assistant.live.mic,
  failed: S.assistant.live.failed,
};

export interface LiveController {
  start(): Promise<LiveStartResult>;
  /** `idle_timeout` — автозакрытие после тишины (T6): человеку это называется причиной, а не «ended unexpectedly». */
  stop(reason?: 'close_requested' | 'idle_timeout'): Promise<void>;
  /** `false` — канал данных не открыт, сообщение не ушло. */
  sendAppend(input: { kind: AppendKind; delegationId: string | null; content: string }): boolean;
  /** Время и спектр удалённого аудиотрека для рта лица; `false` — трека или анализатора нет, массивы не тронуты. */
  readVoice(time: Float32Array<ArrayBuffer>, freq: Float32Array<ArrayBuffer>): boolean;
  subscribe(listener: (event: LiveControllerEvent) => void): () => void;
  snapshot(): LiveSnapshot;
  dispose(): void;
}

interface Live {
  voiceSessionId: string;
  peer: LivePeer;
  channel: LiveDataChannel;
  mic: LiveMicStream;
  micMeter: LevelMeter | null;
  remoteMeter: LevelMeter | null;
  sink: LiveSink;
  stopTick: () => void;
  cancelTimer: () => void;
  closedEmitted: boolean;
}

export function createLiveController(deps: LiveControllerDeps): LiveController {
  const listeners = new Set<(event: LiveControllerEvent) => void>();
  let phase: LiveCallPhase = 'idle';
  let live: Live | null = null;
  let generation = 0;
  let appendCounter = 0;
  let stopReason: 'close_requested' | 'idle_timeout' | null = null;
  let deduper = createEventDeduper();
  let human: Hysteresis = humanSpeakingHysteresis();
  let model: Hysteresis = modelPlayingHysteresis();
  const signals: LiveSignals = { humanSpeaking: false, modelPlaying: false };
  const setTimer = deps.setTimer ?? ((callback, ms) => {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  });

  const emit = (event: LiveControllerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // подписчик не должен ломать остальных
      }
    }
  };
  /** Фаза может смениться за `await`: чтение через функцию не даёт TS сузить её по прошлой проверке. */
  const currentPhase = (): LiveCallPhase => phase;
  const setPhase = (next: LiveCallPhase): void => {
    if (phase === next) return;
    phase = next;
    emit({ type: 'phase', phase });
  };
  const setSignal = (name: keyof LiveSignals, value: boolean): void => {
    if (signals[name] === value) return;
    signals[name] = value;
    emit({ type: name, value });
  };
  const resetSignals = (): void => {
    human.reset();
    model.reset();
    setSignal('humanSpeaking', false);
    setSignal('modelPlaying', false);
  };

  const teardown = (target: Live): void => {
    target.stopTick();
    target.cancelTimer();
    target.micMeter?.stop();
    target.remoteMeter?.stop();
    target.sink.stop();
    target.channel.onopen = target.channel.onclose = target.channel.onmessage = null;
    target.peer.onconnectionstatechange = target.peer.ontrack = null;
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
    for (const track of target.mic.getAudioTracks()) track.stop();
    if (live === target) live = null;
    resetSignals();
  };

  /** Один `sessionClosed` на сессию, с какой бы стороны он ни пришёл (канал данных, событие хоста, обрыв). */
  const finish = (target: Live, reason: string): void => {
    if (target.closedEmitted) return;
    target.closedEmitted = true;
    // Закрытие по тишине просили мы: событие хоста может прийти раньше и назвать другую причину.
    const final = stopReason === 'idle_timeout' ? 'idle_timeout' : reason;
    stopReason = null;
    teardown(target);
    setPhase('idle');
    emit({ type: 'sessionClosed', reason: final });
  };

  const fail = (code: LiveFailure, message = LIVE_MESSAGES[code]): LiveStartResult => ({ ok: false, code, message });

  const handleChannelMessage = (target: Live, data: unknown): void => {
    const parsed = parseLiveEvent(data);
    if (parsed === null || !deduper.accept(parsed.eventId)) return;
    const event = parsed.event;
    if (event.type === 'sessionClosed') {
      finish(target, event.reason);
      return;
    }
    if (event.type === 'sessionStarted') return;
    emit(event);
  };

  const tick = (target: Live): void => {
    const at = deps.now();
    if (target.micMeter !== null) setSignal('humanSpeaking', human.push(target.micMeter.read(), at));
    if (target.remoteMeter !== null) setSignal('modelPlaying', model.push(target.remoteMeter.read(), at));
  };

  const unsubscribeHost = deps.onHostEvent('voice.session.closed', (data) => {
    if (live !== null && live.voiceSessionId === data.voiceSessionId) finish(live, data.reason);
  });

  return {
    async start() {
      if (phase !== 'idle') return fail('busy');
      const mine = ++generation;
      stopReason = null;
      deduper = createEventDeduper();
      human = humanSpeakingHysteresis();
      model = modelPlayingHysteresis();
      setPhase('connecting');
      const abandon = (result: LiveStartResult): LiveStartResult => {
        if (mine === generation) setPhase('idle');
        return result;
      };

      let micAllowed = false;
      try {
        micAllowed = await deps.ensureMic();
      } catch {
        micAllowed = false;
      }
      if (!micAllowed) return abandon(fail('mic'));
      let mic: LiveMicStream;
      try {
        mic = await deps.openMic();
      } catch {
        return abandon(fail('mic'));
      }
      const releaseMic = (): void => {
        for (const track of mic.getAudioTracks()) track.stop();
      };
      if (mine !== generation || currentPhase() !== 'connecting') {
        releaseMic();
        return fail('busy');
      }

      const peer = deps.createPeer();
      const sink = deps.sink();
      const channel = peer.createDataChannel('oai-events');
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);

      let voiceSessionId: string | null = null;
      const closeHostSession = (): void => {
        if (voiceSessionId !== null) void deps.call('voice.session.close', { voiceSessionId }).catch(() => {});
      };
      const dropLocal = (): void => {
        sink.stop();
        channel.onopen = channel.onclose = channel.onmessage = null;
        peer.onconnectionstatechange = peer.ontrack = null;
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
        releaseMic();
      };

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const sdp = peer.localDescription?.sdp;
        if (typeof sdp !== 'string' || sdp === '') throw new Error('no offer');
        const prepared = await deps.call('voice.session.prepare', { sdp });
        if (!prepared.ok) {
          dropLocal();
          // Текст ошибки хоста не показываем как есть: он может быть техническим. Коды сводятся к понятным сообщениям (VA-13).
          return abandon(fail(prepared.code === 'no_key' || prepared.code === 'limit_reached' || prepared.code === 'busy' ? prepared.code : 'failed'));
        }
        voiceSessionId = prepared.voiceSessionId;
        const answerSdp = prepared.sdpAnswer;

        const target: Live = {
          voiceSessionId: prepared.voiceSessionId,
          peer,
          channel,
          mic,
          micMeter: null,
          remoteMeter: null,
          sink,
          stopTick: () => {},
          cancelTimer: () => {},
          closedEmitted: false,
        };
        live = target;
        if (mine !== generation) {
          // stop() пришёл, пока создавалась сессия: закрываем её на хосте и ничего не оставляем.
          closeHostSession();
          teardown(target);
          return fail('busy');
        }
        target.micMeter = deps.meter(mic);
        target.stopTick = deps.setTick(() => tick(target), TICK_MS);
        peer.ontrack = (event) => {
          const stream = event.streams[0];
          if (stream === undefined) return;
          sink.attach(stream);
          target.remoteMeter?.stop();
          target.remoteMeter = deps.meter(stream);
        };
        channel.onmessage = (event) => handleChannelMessage(target, event.data);
        channel.onclose = () => finish(target, 'channel_closed');
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            closeHostSession();
            finish(target, 'connection_lost');
          }
        };

        const opened = new Promise<boolean>((resolve) => {
          const cancel = setTimer(() => resolve(false), deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
          target.cancelTimer = cancel;
          channel.onopen = () => {
            cancel();
            resolve(true);
          };
        });
        await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        if (!(await opened)) {
          closeHostSession();
          teardown(target);
          return abandon(fail('failed'));
        }
        if (mine !== generation || target.closedEmitted) return fail('busy');
        // После открытия канала таймер подключения не нужен; канал обрывается — `channel.onclose` закрывает сессию.
        target.channel.onopen = null;
        setPhase('live');
        return { ok: true, voiceSessionId: target.voiceSessionId };
      } catch {
        closeHostSession();
        if (live !== null) teardown(live);
        else dropLocal();
        return abandon(fail('failed'));
      }
    },

    async stop(reason = 'close_requested') {
      generation += 1;
      const target = live;
      if (target === null) {
        // Идёт подготовка (до ответа хоста): `start` увидит смену поколения и сам закроет сессию.
        setPhase('idle');
        return;
      }
      stopReason = reason;
      setPhase('closing');
      try {
        await deps.call('voice.session.close', { voiceSessionId: target.voiceSessionId });
      } catch {
        // сессию всё равно закрываем локально; хост закроет её по лимиту
      }
      finish(target, reason);
    },

    sendAppend({ kind, delegationId, content }) {
      const target = live;
      if (target === null || target.channel.readyState !== 'open') return false;
      appendCounter += 1;
      try {
        target.channel.send(JSON.stringify(buildAppend({ kind, delegationId, content, eventId: `island_${appendCounter}` })));
        return true;
      } catch {
        return false;
      }
    },

    readVoice: (time, freq) => live?.remoteMeter?.frame?.(time, freq) ?? false,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    snapshot: () => ({ phase, voiceSessionId: live?.voiceSessionId ?? null, humanSpeaking: signals.humanSpeaking, modelPlaying: signals.modelPlaying }),

    dispose() {
      unsubscribeHost();
      generation += 1;
      const target = live;
      if (target !== null) {
        void deps.call('voice.session.close', { voiceSessionId: target.voiceSessionId }).catch(() => {});
        teardown(target);
      }
      listeners.clear();
    },
  };
}

/** `rms` кадра для браузерных измерителей: реэкспорт, чтобы обвязка не тянула второй модуль. */
export { rms };
