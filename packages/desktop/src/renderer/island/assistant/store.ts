/**
 * Состояние помощника на острове (спека 2026-10-14, раздел 8): зеркало `assistant.changed` хоста и своё — открыт ли
 * режим, свёрнут ли он в мини-вид, идёт ли запись. Действия ходят в хост через белый список острова.
 *
 * Отправленное остров держит сам и не ждёт хоста: под нагрузкой его цикл событий стоит секундами, а вопрос должен быть
 * виден сразу. Вопрос уходит в очередь (`queue`); свободен помощник — очередь целиком уходит одним ходом с `askId` и
 * висит как `sending` («Sending…»), пока хост не вернёт этот `askId` в состоянии. Сменился id процесса хоста — хост
 * перезапустился, вопрос не дошёл: он и вся очередь возвращаются в поле. Пока идёт ход, новые сообщения ждут серыми
 * «Queued», как в чатах, и уйдут вместе, когда ход кончится; ход они не перебивают. Обмен, который сменил принятый
 * вопрос, остаётся выше в `history`: очередь уходит сама, и иначе только что дописанный ответ пропал бы, не дочитанный.
 *
 * Речь (план 3b B22; план 3 Task 7; #9 §6) — по сценариям макета `finish`, `speak`, `decide`, `hotkey`, `esc`, `tuck`:
 * - предложения ответа уходят на синтез (`island:tts-speak`) по мере прихода, а их куски копятся и играют после конца
 *   ответа, по порядку; затем «Done» 1 с (`settling`) и `idle`. Ход с карточкой не озвучивается, исход `sent` —
 *   фразой «Sent» через 900 мс; ошибка и отмена молчат;
 * - лицо: `sentence` — звучащее предложение (эмоция L3, «?» для L2) по `speaker.onStart`; `voiceFrame()` — кадр голоса;
 * - Esc, сброс очереди и выключение динамика глушат речь в тот же такт и отменяют всю очередь в main (E3);
 * - хоткей и микрофон во время речи её не обрывают и не пишут — остров только раскрывается; ⌃ сворачивает в мини;
 * - голоса нет (не скачан, недоступен, нет для языка) — ответ текстом без лица; не скачан — строка один раз за сессию.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { matchConfirm } from '@parley/core/assistant';
import type { AssistantState } from '@parley/protocol';
import { ttsAvailable, type IslandAssistantConfig, type IslandBridge, type IslandSpeechApi, type IslandSpeechConfig, type IslandTtsChunk, type IslandTtsMessage, type TtsEngineState } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import { TTS_VOICES } from '../../../shared/tts-types.js';
import type { Listening } from './listen.js';
import type { Speaker } from './speaker.js';
import { createSentenceFeed, type FeedSentence, type SentenceFeed } from './speech-queue.js';
import { spokenPhrase } from './spoken.js';
import type { VoiceAnalysis, VoiceFrame } from './voice-features.js';

/** `speaking` — говорит лицо, `settling` — «Done» 1 с после речи; обе фазы живут только в острове. */
export type InputPhase = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'settling';

export const HOST_IDLE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };

const TURN_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering']);
const BUSY_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering', 'awaiting-confirm']);

/** Предел текста `assistant.ask`: длиннее одно сообщение не уходит, очередь длиннее уходит частями. */
export const ASK_MAX = 4000;
/** Сколько прошлых обменов держит остров. */
const HISTORY_MAX = 10;
/** «Done» после речи (`settle` макета). */
export const SETTLE_MS = 1000;
/** «Sent» звучит через 900 мс после исхода карточки (`decide` макета). */
export const SENT_DELAY_MS = 900;
/** Сколько ждать кусок `final` после ответа `speak`, прежде чем считать предложение кончившимся. */
export const SPEAK_FINAL_GRACE_MS = 1000;
/**
 * Голос не зазвучал за это время после конца ответа (движок греется или завис) — ответ остаётся текстом без лица.
 * Тёплый перезапуск worker (около 1,5 с) укладывается, холодная компиляция шейдеров (около 15 с) — нет.
 */
export const SPEECH_START_TIMEOUT_MS = 10_000;
/** Окно анализатора шины голоса (`sound/graph.ts`): fftSize 2048, спектр — половина. */
const FFT_SIZE = 2048;

/** Прошлый обмен разговора: вопрос и ответ (или причина ошибки). */
export interface Exchange {
  id: number;
  question: string;
  answer: string;
}

export interface QueuedMessage {
  id: number;
  text: string;
}

/** Вопрос, отданный хосту, пока тот не принял его. */
export interface Sending {
  id: string;
  text: string;
  /** Номер хода хоста при отправке: старый хост `askId` не знает, и принятие узнаётся по смене номера. */
  turn: number;
  /** Id процесса хоста при отправке; `null` — ещё не знали (состояние хоста не пришло). */
  instance: string | null;
}

export function assistantBusy(state: { host: AssistantState; input: InputPhase; sending: Sending | null; queue: readonly QueuedMessage[] }): boolean {
  return state.input !== 'idle' || state.sending !== null || state.queue.length > 0 || BUSY_PHASES.has(state.host.phase);
}

/** Звучащее предложение: эмоция лица (L3) и текст (вопрос по «?» для L2). */
export interface SpokenSentence {
  utteranceId: string;
  emo: AssistantState['mood'];
  text: string;
}

/** Речь помощника на острове: проигрыватель (B14), мост голоса (B15) и анализ голоса для лица (B17, B21). */
export interface AssistantSpeech {
  speaker: Speaker;
  api: Pick<IslandSpeechApi, 'speak' | 'cancel' | 'warmup' | 'setSpeak'>;
  /** Анализ голоса с частотой графа острова; зовётся один раз, когда лицо впервые читает голос. */
  analysis(): VoiceAnalysis;
  /** Миллисекунды кадров лица. */
  now(): number;
}

export interface AssistantDeps {
  call: IslandBridge['call'];
  keyboard(on: boolean): void;
  ownsKeyboard(): boolean;
  config(): IslandAssistantConfig;
  /** `null` — голос выключен или модель Whisper не скачана. */
  listen(hooks: { onLevel(level: number): void; onTranscribing(): void }): Listening | null;
  /** Нет — помощник отвечает только текстом. */
  speech?: AssistantSpeech;
}

export interface AssistantStoreState {
  host: AssistantState;
  open: boolean;
  collapsed: boolean;
  /** Раскрыт наведением — уход курсора сворачивает обратно. */
  byHover: boolean;
  input: InputPhase;
  level: number;
  /** Когда началась запись (для таймера); `null` — не записываем. */
  listenStartedAt: number | null;
  draft: string;
  notice: string | null;
  cardError: string | null;
  queue: QueuedMessage[];
  sending: Sending | null;
  history: Exchange[];
  /** Решение карточки в пути: кнопка крутится, повторно не жмётся. */
  deciding: 'send' | 'cancel' | null;
  /** Предложение, которое сейчас говорит лицо; `null` — лицо молчит. */
  sentence: SpokenSentence | null;
  configure(deps: AssistantDeps): void;
  applyHost(state: AssistantState): void;
  openMode(request: { listen: boolean }): void;
  close(): void;
  collapse(): void;
  /** Забрать клавиатуру у острова, открытого сам (напоминание, Telegram): панель до этого не фокусируема. */
  takeKeyboard(): void;
  expand(byHover: boolean): void;
  setDraft(text: string): void;
  submit(text: string): Promise<void>;
  unqueue(id: number): void;
  toggleListening(): void;
  decide(decision: 'send' | 'cancel'): Promise<void>;
  reset(): Promise<void>;
  /** Сообщение порта голоса: кусок, срыв по длине или состояние движка. */
  speechMessage(message: IslandTtsMessage): void;
  /** Пришли настройки речи: выключение глушит речь, включение греет движок. Первое значение — точка отсчёта. */
  speechConfig(config: IslandSpeechConfig | undefined): void;
  /** Значок динамика: тот же флаг, что «Speak answers»; выключение глушит речь сразу. */
  toggleSpeak(): void;
  /** Кадр голоса для лица; `null` — голос молчит. */
  voiceFrame(): VoiceFrame | null;
}

/** Речь одного хода: предложения по `utteranceId` в порядке синтеза и куски, ждущие конца ответа. */
interface Talk {
  turn: number;
  feed: SentenceFeed;
  sentences: Map<string, FeedSentence & { done: boolean }>;
  buffer: IslandTtsChunk[];
  /** Ответ кончился: куски идут в проигрыватель. */
  playing: boolean;
  /** Хоть одно предложение зазвучало. */
  started: boolean;
}

export function createAssistantStore(): UseBoundStore<StoreApi<AssistantStoreState>> {
  let deps: AssistantDeps | null = null;
  let listening: Listening | null = null;
  /**
   * Что делать с распознанным: `send` — хоткей (⌥Space), голосовой сценарий без рук, вопрос уходит сразу (спека 8.4);
   * `draft` — кнопка микрофона, как диктовка в чатах: текст ложится в поле, отправляет человек Enter-ом.
   */
  let listenMode: 'send' | 'draft' = 'send';
  let queued = 0;
  let exchanges = 0;
  let talk: Talk | null = null;
  let utterances = 0;
  /** Состояние движка из порта голоса; `null` — ещё не пришло. */
  let engine: TtsEngineState | null = null;
  /** Строка «голос не скачан» уже показана в этой сессии острова. */
  let hinted = false;
  /** Прошлое значение «Speak answers»; `undefined` — ещё не знаем. */
  let speechOn: boolean | undefined;
  let unsubscribe: Array<() => void> = [];
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let sentTimer: ReturnType<typeof setTimeout> | null = null;
  let analysis: VoiceAnalysis | null = null;
  let frameAt: number | null = null;
  const frameTime = new Float32Array(FFT_SIZE);
  const frameFreq = new Float32Array(FFT_SIZE / 2);
  return create<AssistantStoreState>((set, get) => {
    const stopTurn = (): void => {
      if (TURN_PHASES.has(get().host.phase)) void deps?.call('assistant.cancel', {});
    };
    const speechSettings = (): IslandSpeechConfig | undefined => deps?.config().speech;
    /** Голос может звучать на языке помощника: веса скачаны, движок не отказал (G3, Р8). */
    const voiceReady = (): boolean => {
      const settings = speechSettings();
      if (deps?.speech === undefined || settings === undefined) return false;
      const language = deps.config().language;
      const supported = TTS_VOICES.some((voice) => voice.id === settings.voice && voice.languages.includes(language));
      return supported && (engine === null ? settings.available : ttsAvailable(engine));
    };
    const canSpeak = (): boolean => speechSettings()?.enabled === true && voiceReady();
    const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };
    /**
     * Глушит речь хода в тот же такт и отменяет всю очередь в main (E3); лицо уходит сразу, без «Done» (`esc`
     * макета).
     */
    const silence = (): void => {
      startTimer = clearTimer(startTimer);
      sentTimer = clearTimer(sentTimer);
      if (talk !== null) {
        talk = null;
        deps?.speech?.speaker.stop();
        deps?.speech?.api.cancel();
      }
      const { input } = get();
      if (input === 'speaking' || input === 'settling') set({ input: 'idle', sentence: null });
    };
    /** Речь оборвана вне хода хоста: очередь вопросов свободна. */
    const hush = (): void => {
      silence();
      pump();
    };
    const newTalk = (turn: number, playing: boolean): Talk => {
      silence();
      talk = { turn, feed: createSentenceFeed(deps!.config().language), sentences: new Map(), buffer: [], playing, started: false };
      return talk;
    };
    /** Предложение на синтез: проигрыватель ждёт его заранее, чтобы `stop()` заглушил и куски, ещё не дошедшие. */
    const say = (current: Talk, sentence: FeedSentence): void => {
      const speech = deps?.speech;
      const settings = speechSettings();
      if (speech === undefined || settings === undefined) return;
      utterances += 1;
      const utteranceId = `t${current.turn}-${utterances}`;
      current.sentences.set(utteranceId, { ...sentence, done: false });
      speech.speaker.expect(utteranceId);
      const ended = (): void => sentenceEnded(current, utteranceId);
      // Конец предложения — кусок `final` с порта. Ответ `speak` идёт другой трубой IPC и может обогнать последние
      // куски, поэтому он кончает предложение только после паузы — на случай, если `final` так и не пришёл
      // (критик m-1481). Отказ кончает сразу.
      speech.api
        .speak({ utteranceId, text: sentence.text, voice: settings.voice, language: deps!.config().language })
        .then(() => void setTimeout(ended, SPEAK_FINAL_GRACE_MS), ended);
    };
    /** Предложение кончилось: последний кусок, ответ `speak` или отказ — смотря что раньше. */
    const sentenceEnded = (current: Talk, utteranceId: string): void => {
      const sentence = current.sentences.get(utteranceId);
      if (talk !== current || sentence === undefined) return;
      sentence.done = true;
      finish();
    };
    /** Ответ кончился: накопленные куски — в проигрыватель по порядку, дальше куски идут сразу. */
    const play = (current: Talk): void => {
      current.playing = true;
      frameAt = null;
      for (const chunk of current.buffer) deps?.speech?.speaker.enqueue(chunk);
      current.buffer = [];
      startTimer = clearTimer(startTimer);
      if (current.sentences.size > 0) startTimer = setTimeout(() => {
        startTimer = null;
        if (talk === current && !current.started) silence();
      }, SPEECH_START_TIMEOUT_MS);
      finish();
    };
    /**
     * Речь хода кончилась, когда все предложения кончились и проигрыватель доиграл: `onIdle` не приходит, если
     * последнее предложение выброшено срывом (`discard`), поэтому проверка идёт и по концу предложения.
     */
    const finish = (): void => {
      const current = talk;
      if (current === null || !current.playing || deps?.speech?.speaker.speaking() === true) return;
      for (const sentence of current.sentences.values()) if (!sentence.done) return;
      talk = null;
      startTimer = clearTimer(startTimer);
      if (!current.started) return;
      set({ input: 'settling', sentence: null });
      settleTimer = clearTimer(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (get().input === 'settling') set({ input: 'idle' });
        pump();
      }, SETTLE_MS);
    };
    const started = (utteranceId: string): void => {
      const sentence = talk?.sentences.get(utteranceId);
      if (talk === null || sentence === undefined) return;
      talk.started = true;
      startTimer = clearTimer(startTimer);
      set({ input: 'speaking', sentence: { utteranceId, emo: sentence.emo, text: sentence.text } });
    };
    /** Ответ растёт: готовые предложения — на синтез; ответ начат заново (инструмент) — сброс очереди. */
    const stream = (current: Talk, host: AssistantState): void => {
      const sentences = current.feed.push(host.turn, host.answer, false, host.moods);
      if (current.feed.wasReset()) {
        deps?.speech?.speaker.stop();
        deps?.speech?.api.cancel();
        current.sentences.clear();
        current.buffer = [];
      }
      for (const sentence of sentences) say(current, sentence);
    };
    /** «Sent» после исхода карточки (`decide` макета): отмена и ошибки молчат. */
    const sayLater = (): void => {
      sentTimer = clearTimer(sentTimer);
      sentTimer = setTimeout(() => {
        sentTimer = null;
        const settings = speechSettings();
        if (settings === undefined || !canSpeak() || !get().open) return;
        const { host } = get();
        const current = newTalk(host.turn, true);
        say(current, { text: spokenPhrase('sent', deps!.config().language, settings.gender), emo: host.mood });
        play(current);
      }, SENT_DELAY_MS);
    };
    /** Речь по состоянию хода (сценарии `finish` и `decide` макета). */
    const followSpeech = (host: AssistantState, previous: AssistantState): void => {
      if (deps?.speech === undefined) return;
      if (talk !== null && talk.turn !== host.turn) silence();
      if (TURN_PHASES.has(host.phase)) {
        const entering = host.turn !== previous.turn || !TURN_PHASES.has(previous.phase);
        if (talk === null && entering) startTalk(host.turn);
        if (talk !== null && !talk.playing) stream(talk, host);
      } else if (talk !== null && !talk.playing) {
        // Дописанный ответ говорит лицо; ход с карточкой, ошибка и нет связи — молча.
        const current = talk;
        if (host.phase === 'idle') {
          for (const sentence of current.feed.push(host.turn, host.answer, true, host.moods)) say(current, sentence);
          play(current);
        } else silence();
      }
      if (host.outcome === 'sent' && previous.outcome !== 'sent' && canSpeak() && get().open) sayLater();
    };
    /** Новый ход: говорить, если речь включена и голос есть; голос не скачан — строка один раз за сессию (G3). */
    const startTalk = (turn: number): void => {
      if (!get().open) return;
      const settings = speechSettings();
      if (settings?.enabled !== true) return;
      if (canSpeak()) {
        newTalk(turn, false);
        return;
      }
      if (engine?.state === 'not-downloaded' && !hinted) {
        hinted = true;
        const voice = TTS_VOICES.find((entry) => entry.id === settings.voice);
        set({ notice: S.assistant.voiceMissing(voice?.name ?? settings.voice) });
      }
    };
    /** Свободен помощник (нет хода, вопроса в пути и записи) — очередь уходит одним ходом, в пределах `ASK_MAX`. */
    const pump = (): void => {
      const state = get();
      if (deps === null || state.sending !== null || state.queue.length === 0 || state.input !== 'idle' || TURN_PHASES.has(state.host.phase)) return;
      const items: QueuedMessage[] = [];
      let size = 0;
      for (const item of state.queue) {
        const next = size + (items.length === 0 ? 0 : 2) + item.text.length;
        if (items.length > 0 && next > ASK_MAX) break;
        items.push(item);
        size = next;
      }
      const text = items.map((item) => item.text).join('\n\n');
      const sending: Sending = { id: crypto.randomUUID(), text, turn: state.host.turn, instance: state.host.instance ?? null };
      set({ queue: state.queue.slice(items.length), sending, cardError: null });
      const config = deps.config();
      deps.call('assistant.ask', { text, provider: config.provider, model: config.model, language: config.language, askId: sending.id }).catch(() => {
        if (get().sending === sending) giveBack(text);
      });
    };
    /** Вопрос не дошёл: он и всё, что ждало за ним, — в поле по порядку; повтор — Enter, без автоповторов. */
    const giveBack = (text: string): void => {
      const line = (part: string): string => part.replace(/\s+/g, ' ').trim();
      set((state) => ({
        sending: null,
        queue: [],
        draft: [text, ...state.queue.map((item) => item.text), state.draft].map(line).filter((part) => part !== '').join(' '),
        notice: S.assistant.notSent,
      }));
    };
    const startListening = (mode: 'send' | 'draft'): void => {
      if (deps === null) return;
      // Ответ ещё не зазвучал, а человек уже говорит: голос помощника не должен попасть в запись.
      silence();
      const session = deps.listen({
        onLevel: (level) => set({ level }),
        onTranscribing: () => set({ input: 'transcribing', level: 0, listenStartedAt: null }),
      });
      if (session === null) {
        set({ notice: S.assistant.voiceOff });
        return;
      }
      listening = session;
      listenMode = mode;
      set({ input: 'listening', notice: null, listenStartedAt: Date.now() });
      void session.result.then((result) => {
        if (listening === session) listening = null;
        set({ input: 'idle', level: 0, listenStartedAt: null });
        if ('text' in result) {
          if (listenMode === 'send') void get().submit(result.text);
          else set({ draft: result.text });
        } else if (result.error === 'mic') set({ notice: S.assistant.micDenied });
        else if (result.error === 'no_speech') set({ notice: S.assistant.noSpeech });
        else if (result.error === 'voice') set({ notice: S.assistant.voiceFailed });
        // После `submit`: сказанное уходит одним ходом с тем, что набрали, пока шла запись.
        pump();
      });
    };
    return {
      host: HOST_IDLE,
      open: false,
      collapsed: false,
      byHover: false,
      input: 'idle',
      level: 0,
      listenStartedAt: null,
      draft: '',
      notice: null,
      cardError: null,
      queue: [],
      sending: null,
      history: [],
      deciding: null,
      sentence: null,
      configure: (next) => {
        for (const off of unsubscribe) off();
        silence();
        deps = next;
        speechOn = undefined;
        analysis = null;
        const speaker = next.speech?.speaker;
        unsubscribe = speaker === undefined ? [] : [speaker.onStart(started), speaker.onIdle(finish)];
      },
      applyHost: (host) => {
        const state = get();
        const { sending } = state;
        const reveal = host.phase === 'answering' && state.open && state.collapsed;
        // Старый хост `askId` не шлёт — тогда вопрос принят, когда сменился номер хода.
        const accepted = sending !== null && (host.askId === undefined ? host.turn !== sending.turn : host.askId === sending.id);
        const restarted = sending !== null && !accepted && sending.instance !== null && host.instance !== undefined && host.instance !== sending.instance;
        // Принятый вопрос сменил обмен на острове: прошлый уходит выше, в историю.
        const previous = state.host;
        const archived = accepted && previous.question !== null ? [{ id: ++exchanges, question: previous.question, answer: previous.answer === '' ? (previous.error ?? '') : previous.answer }] : [];
        // Ответ на напоминание или ход из Telegram приходит без вопроса: открываем помощника сами, но клавиатуру не отбираем.
        const reminderOpen = (host.origin === 'reminder' || host.origin === 'telegram') && host.turn !== previous.turn && !state.open;
        set({
          host,
          ...(reminderOpen ? { open: true, collapsed: false, byHover: false } : {}),
          ...(accepted ? { sending: null, history: [...state.history, ...archived].slice(-HISTORY_MAX) } : {}),
          ...(sending !== null && !accepted && sending.instance === null && host.instance !== undefined ? { sending: { ...sending, instance: host.instance } } : {}),
          ...(reveal ? { collapsed: false, byHover: false } : {}),
          // Ошибку на карточке стирает только новая карточка: публикация той же (смена фазы) её не трогает.
          // Новый ход (карточки и итога нет) тоже стирает причину: она жила вместе с итогом прошлой карточки.
          ...((host.proposal !== null && host.proposal.id !== previous.proposal?.id) || (host.proposal === null && host.outcome === null) ? { cardError: null } : {}),
        });
        if (restarted && sending !== null) giveBack(sending.text);
        followSpeech(host, previous);
        pump();
      },
      openMode: (request) => {
        const state = get();
        if (state.open && state.input === 'listening') {
          listening?.stop();
          return;
        }
        // Хоткей и микрофон во время речи только раскрывают остров: ни записи, ни обрыва (`hotkey` при `BUSY`).
        if (state.input === 'speaking' || state.input === 'settling') {
          set({ open: true, collapsed: false, byHover: false });
          deps?.keyboard(true);
          return;
        }
        set({ open: true, collapsed: false, byHover: false, notice: null });
        deps?.keyboard(true);
        // Прогрев при открытии режима (Р5): прячет повторную загрузку модели после выгрузки.
        if (!state.open && canSpeak()) void deps?.speech?.api.warmup().catch(() => undefined);
        if (request.listen) {
          stopTurn();
          startListening('send');
        }
      },
      close: () => {
        listening?.cancel();
        listening = null;
        silence();
        // Вопрос в пути тоже отменяется: хост бросит ход, который ещё запускается.
        if (get().sending !== null) void deps?.call('assistant.cancel', {});
        else stopTurn();
        set({ open: false, collapsed: false, byHover: false, input: 'idle', level: 0, listenStartedAt: null, notice: null, cardError: null, queue: [], sending: null, history: [], sentence: null });
        deps?.keyboard(false);
      },
      collapse: () => {
        set({ collapsed: true, byHover: false });
        deps?.keyboard(false);
      },
      takeKeyboard: () => {
        const state = get();
        if (!state.open || state.collapsed || deps === null || deps.ownsKeyboard()) return;
        deps.keyboard(true);
      },
      expand: (byHover) => set({ collapsed: false, byHover }),
      setDraft: (draft) => set({ draft }),
      submit: async (raw) => {
        const text = raw.trim();
        if (text === '' || deps === null) return;
        if (text.length > ASK_MAX) {
          set({ draft: text, notice: S.assistant.tooLong });
          return;
        }
        set({ draft: '', notice: null });
        const { proposal } = get().host;
        const answer = proposal === null ? null : matchConfirm(text);
        if (answer !== null) {
          await get().decide(answer);
          return;
        }
        queued += 1;
        set((state) => ({ queue: [...state.queue, { id: queued, text }] }));
        pump();
      },
      unqueue: (id) => set((state) => ({ queue: state.queue.filter((item) => item.id !== id) })),
      toggleListening: () => {
        if (get().input === 'listening') listening?.stop();
        // Диктовка только кладёт текст в поле — идущий ход она не перебивает (перебивает хоткей, `openMode`).
        else if (get().input === 'idle') startListening('draft');
      },
      decide: async (decision) => {
        const proposal = get().host.proposal;
        if (proposal === null || deps === null || get().deciding !== null) return;
        set({ deciding: decision, cardError: null });
        try {
          const result = await deps.call('assistant.decide', { proposalId: proposal.id, decision });
          set({ cardError: result.error });
        } catch (error) {
          set({ cardError: (error as Error).message });
        } finally {
          set({ deciding: null });
        }
      },
      reset: async () => {
        set({ queue: [], sending: null, history: [], cardError: null });
        await deps?.call('assistant.reset', {});
      },
      speechMessage: (message) => {
        if (message.type === 'state') {
          engine = message.state;
          return;
        }
        const current = talk;
        const utteranceId = message.type === 'chunk' ? message.chunk.utteranceId : message.utteranceId;
        if (current === null || !current.sentences.has(utteranceId)) return;
        if (message.type === 'discard') {
          if (current.playing) deps?.speech?.speaker.discard(utteranceId, message.fromSeq);
          else current.buffer = current.buffer.filter((chunk) => chunk.utteranceId !== utteranceId || chunk.seq < message.fromSeq);
          finish();
          return;
        }
        const { chunk } = message;
        if (chunk.pcm.length > 0) {
          if (current.playing) deps?.speech?.speaker.enqueue(chunk);
          else current.buffer.push(chunk);
        }
        if (chunk.final) sentenceEnded(current, utteranceId);
      },
      speechConfig: (config) => {
        const on = config?.enabled === true;
        const was = speechOn;
        speechOn = on;
        if (was === undefined || was === on) return;
        if (!on) hush();
        else if (voiceReady()) void deps?.speech?.api.warmup().catch(() => undefined);
      },
      toggleSpeak: () => {
        const speech = deps?.speech;
        if (speech === undefined) return;
        const on = speechSettings()?.enabled !== true;
        if (!on) hush();
        void speech.api.setSpeak(on).catch(() => undefined);
      },
      voiceFrame: () => {
        const speech = deps?.speech;
        if (speech === undefined || !speech.speaker.read(frameTime, frameFreq)) return null;
        analysis ??= speech.analysis();
        const now = speech.now();
        const dt = frameAt === null ? 1 / 60 : Math.max(0, now - frameAt) / 1000;
        frameAt = now;
        const ask = /\?\s*$/.test(get().sentence?.text ?? '');
        return analysis.step(frameTime, frameFreq, dt, now, ask);
      },
    };
  });
}

export const useAssistantStore = createAssistantStore();
