/**
 * Очередь речи (спека «Голос↔Ассистент» §7, T4): чистая политика с внедряемыми часами и сигналами. Решает, когда итог
 * Request можно передать Live (`commentary.append`), когда показать карточкой и что считать озвученным.
 *
 * Состояния речи: `queued`, `submitted` (append отправлен), `played` (звук на треке плюс пересечение с
 * `output_transcript`), `unknown` (нет доказательства или человек перебил; итог остаётся карточкой), `dropped`
 * (итог неактуален: Request вытеснен). Экран — отдельное измерение: `card: hidden | shown`.
 *
 * Отправка в Live разрешена, когда одновременно: нет локальной речи человека, пауза не меньше `PAUSE_MS`, модель ничего
 * не воспроизводит, ворота Request открыты (`gate === 'open'`, `stale === false`) и правило подтверждений (`ack.ts`) не
 * держит append. Мягкая политика: через `CARD_AFTER_MS` итог показывается карточкой, голос по-прежнему ждёт паузу.
 * Держится ворота дольше `HELD_CLARIFY_MS` — одна короткая реплика «уточняю поручение», держимый итог не выпускается.
 */
import { normalizeHumanText } from '../assistant/text.js';
import type { AppendPurpose } from './ack.js';

export const PAUSE_MS = 700;
export const CARD_AFTER_MS = 30_000;
export const HELD_CLARIFY_MS = 15_000;
export const RESULT_TOKEN_LIMIT = 300;
/** Лимит append у Live — 500 токенов; итог и пояснение вместе не больше этого. */
export const APPEND_TOKEN_LIMIT = 500;
/** Пауза между двумя отправками: пока предыдущий итог не начал звучать, следующий не уходит. */
export const SEND_GAP_MS = 2000;
/** Сколько ждать начала звука после отправки. */
export const PLAY_START_TIMEOUT_MS = 10_000;
/** Сколько ждать `output_transcript` после конца звука. */
export const TRANSCRIPT_GRACE_MS = 3000;
/** Человек заговорил не позже этого после конца звука модели — это перебивание, а не следующая реплика; `played` ставится после этого окна. */
export const INTERRUPT_WINDOW_MS = 1000;
/** Предел непрерывного звука при отправленном итоге: дольше этого `played` не ждём, итог остаётся карточкой (`unknown`). */
export const MAX_AUDIO_MS = 60_000;

export type SpeechState = 'queued' | 'submitted' | 'played' | 'unknown' | 'dropped';
export type CardState = 'hidden' | 'shown';
export type ResultJobState = 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';

/** То, что очередь берёт из вида Request хоста. */
export interface ResultInput {
  requestId: string;
  jobId: string;
  /** Ревизия финального состояния job: с ней отмечается доставка. */
  revision: number;
  state: ResultJobState;
  /** Нормализованный итог job (`result.answer`, иначе краткое резюме); пусто — говорить нечего. */
  text: string;
  gate: 'open' | 'held';
  heldSince: number | null;
  stale: boolean;
  /** Делегация этой Live-сессии; `null` — восстановление (новая сессия её не знает). */
  delegationId: string | null;
  /** Итог этой ревизии уже передан в Live (отметка хоста). */
  deliveredLive: boolean;
}

export interface QueueItem {
  requestId: string;
  jobId: string;
  revision: number;
  delegationId: string | null;
  speech: SpeechState;
  card: CardState;
  /** Полный итог для карточки. */
  text: string;
  truncated: boolean;
  gate: 'open' | 'held';
  heldSince: number | null;
  queuedAt: number;
  submittedAt: number | null;
}

export interface SpeechPhrases {
  /** Приписка к сокращённому итогу («подробности на экране»); уходит модели, она переводит на язык человека. */
  detailsOnScreen: string;
  /** Целиком реплика «уточняю поручение». */
  clarifying: string;
}

export interface SpeechEffects {
  /** `false` — Live не принял (канал закрыт): состояние не меняется. */
  send(input: { delegationId: string | null; content: string }): boolean;
  /** Итог передан в Live: хост отмечает доставку (`requests.ack(requestId, 'live', revision)`). */
  ack(requestId: string, revision: number): void;
  cardShown(item: Readonly<QueueItem>): void;
  changed?(): void;
}

export interface SpeechQueueDeps {
  now(): number;
  effects: SpeechEffects;
  phrases: SpeechPhrases;
  /** Правило подтверждений (`AckTracker.canAppend`). */
  canAppend(delegationId: string | null, purpose: AppendPurpose): boolean;
}

export interface SpeechQueue {
  /** Идемпотентно: вид Request обновляет элемент или создаёт его, когда итог готов. */
  observe(inputs: readonly ResultInput[]): void;
  setHumanSpeaking(value: boolean): void;
  setModelPlaying(value: boolean): void;
  /** Дельта выходного транскрипта модели (собирается здесь, нормализуется по собранному тексту). */
  outputText(delta: string): void;
  step(): void;
  items(): QueueItem[];
  /** Live-сессия закончилась: отправленное без доказательства становится `unknown`, ожидающие теряют привязку к делегации. */
  sessionEnded(): void;
}

interface Entry extends QueueItem {
  /** Что именно ушло в Live: по нему сверяется транскрипт. */
  spoken: string;
  heard: string;
  audioSeen: boolean;
  audioEndedAt: number | null;
  /** Начало текущего непрерывного звука (последнее включение сигнала). */
  audioStartedAt: number | null;
  clarifiedFor: number | null;
}

/** Оценка токенов без токенайзера: ASCII ≈ 4 знака на токен, остальное ≈ 2. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 2);
}

/** Режет итог по границе предложения в пределах `limit` токенов; `null`, если резать не нужно. */
export function shorten(text: string, limit: number): string | null {
  if (estimateTokens(text) <= limit) return null;
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  let out = '';
  for (const sentence of sentences) {
    if (estimateTokens(out + sentence) > limit) break;
    out += sentence;
  }
  if (out.trim() === '') {
    // Одно длинное предложение: режем по знакам.
    let cut = text.slice(0, Math.max(1, limit * 2));
    while (cut.length > 1 && estimateTokens(cut) > limit) cut = cut.slice(0, Math.floor(cut.length * 0.9));
    out = cut;
  }
  return out.trim();
}

const wordsOf = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 4 || /^\d+$/.test(word)).map((word) => word.slice(0, 5));

/** Модель сокращает итог, поэтому проверяется пересечение: достаточная доля значимых слов отправленного текста прозвучала. */
export function overlaps(spoken: string, heard: string): boolean {
  const wanted = new Set(wordsOf(spoken));
  if (wanted.size === 0) return heard.trim() !== '';
  const got = new Set(wordsOf(heard));
  let hit = 0;
  for (const word of wanted) if (got.has(word)) hit += 1;
  return hit >= Math.max(1, Math.min(3, Math.ceil(wanted.size * 0.2)));
}

export function createSpeechQueue(deps: SpeechQueueDeps): SpeechQueue {
  const entries = new Map<string, Entry>();
  let humanSpeaking = false;
  let modelPlaying = false;
  let busyEndedAt = Number.NEGATIVE_INFINITY;
  let lastSendAt = Number.NEGATIVE_INFINITY;

  const notify = (): void => deps.effects.changed?.();
  const showCard = (entry: Entry): void => {
    if (entry.card === 'shown') return;
    entry.card = 'shown';
    deps.effects.cardShown(entry);
    notify();
  };
  const quiet = (): boolean => !humanSpeaking && !modelPlaying && deps.now() - busyEndedAt >= PAUSE_MS;
  const inFlight = (): boolean => [...entries.values()].some((entry) => entry.speech === 'submitted');
  const canSend = (delegationId: string | null): boolean => quiet() && deps.now() - lastSendAt >= SEND_GAP_MS && !inFlight() && deps.canAppend(delegationId, 'result');

  const toUnknown = (entry: Entry): void => {
    entry.speech = 'unknown';
    showCard(entry);
    notify();
  };

  return {
    observe(inputs) {
      let changed = false;
      for (const input of inputs) {
        const existing = entries.get(input.requestId);
        const finished = input.state === 'completed' || input.state === 'needs_confirmation' || input.state === 'failed';
        if (existing === undefined) {
          if (!finished || input.deliveredLive) continue;
          const text = normalizeHumanText(input.text, {});
          if (text === '') continue;
          const entry: Entry = {
            requestId: input.requestId,
            jobId: input.jobId,
            revision: input.revision,
            delegationId: input.delegationId,
            speech: input.stale ? 'dropped' : 'queued',
            card: 'hidden',
            text,
            truncated: false,
            gate: input.gate,
            heldSince: input.heldSince,
            queuedAt: deps.now(),
            submittedAt: null,
            spoken: '',
            heard: '',
            audioSeen: false,
            audioEndedAt: null,
            audioStartedAt: null,
            clarifiedFor: null,
          };
          entries.set(entry.requestId, entry);
          changed = true;
          continue;
        }
        if (existing.gate !== input.gate || existing.heldSince !== input.heldSince) {
          existing.gate = input.gate;
          existing.heldSince = input.heldSince;
          changed = true;
        }
        if (existing.speech === 'queued') {
          // Вид Request мог прийти раньше, чем мост узнал делегацию: привязка дописывается.
          if (existing.delegationId === null && input.delegationId !== null) existing.delegationId = input.delegationId;
          // Уточнение вытеснило итог, пока он ждал: не озвучивается и не показывается (даже отменённым).
          if (input.stale) {
            existing.speech = 'dropped';
            changed = true;
          } else if (finished && input.revision > existing.revision) {
            const text = normalizeHumanText(input.text, {});
            if (text !== '') {
              existing.text = text;
              existing.revision = input.revision;
              existing.jobId = input.jobId;
              changed = true;
            }
          }
        }
      }
      if (changed) notify();
    },

    setHumanSpeaking(value) {
      if (humanSpeaking === value) return;
      humanSpeaking = value;
      if (!value) busyEndedAt = deps.now();
      if (value) {
        // Человек заговорил поверх озвучки итога: доказательства воспроизведения нет, итог остаётся карточкой.
        // Граничный случай: звук погас на несколько сотен мс раньше, чем сигнал речи человека дошёл до очереди.
        const at = deps.now();
        for (const entry of entries.values()) {
          if (entry.speech === 'submitted' && entry.audioSeen && (entry.audioEndedAt === null || at - entry.audioEndedAt < INTERRUPT_WINDOW_MS)) toUnknown(entry);
        }
      }
    },

    setModelPlaying(value) {
      if (modelPlaying === value) return;
      modelPlaying = value;
      const at = deps.now();
      for (const entry of entries.values()) {
        if (entry.speech !== 'submitted') continue;
        if (value) {
          // Звук возобновился после паузы: прежний конец недействителен, отсчёты идут от последнего конца звука.
          entry.audioSeen = true;
          entry.audioEndedAt = null;
          entry.audioStartedAt = at;
        } else if (entry.audioSeen) entry.audioEndedAt = at;
      }
      if (!value) busyEndedAt = at;
    },

    outputText(delta) {
      for (const entry of entries.values()) {
        if (entry.speech !== 'submitted') continue;
        entry.heard += delta;
      }
    },

    step() {
      const at = deps.now();
      const ordered = [...entries.values()];

      // Показ карточкой по мягкой политике: только когда ворота открыты и итог актуален.
      for (const entry of ordered) {
        if (entry.speech === 'queued' && entry.card === 'hidden' && entry.gate === 'open' && at - entry.queuedAt >= CARD_AFTER_MS) showCard(entry);
      }

      // Доказательства воспроизведения отправленного итога.
      for (const entry of ordered) {
        if (entry.speech !== 'submitted' || entry.submittedAt === null) continue;
        const heard = normalizeHumanText(entry.heard, {});
        if (entry.audioSeen && entry.audioEndedAt !== null && at - entry.audioEndedAt >= INTERRUPT_WINDOW_MS && heard !== '' && overlaps(entry.spoken, heard)) {
          entry.speech = 'played';
          notify();
        } else if (!entry.audioSeen && at - entry.submittedAt >= PLAY_START_TIMEOUT_MS && !modelPlaying) {
          toUnknown(entry);
        } else if (entry.audioEndedAt !== null && at - entry.audioEndedAt >= TRANSCRIPT_GRACE_MS) {
          toUnknown(entry);
        } else if (entry.audioSeen && entry.audioEndedAt === null && entry.audioStartedAt !== null && at - entry.audioStartedAt >= MAX_AUDIO_MS) {
          toUnknown(entry);
        }
      }

      // Одна короткая реплика «уточняю поручение», если ворота держатся давно.
      for (const entry of ordered) {
        if (entry.speech !== 'queued' || entry.gate !== 'held' || entry.heldSince === null) continue;
        if (at - entry.heldSince < HELD_CLARIFY_MS || entry.clarifiedFor === entry.heldSince) continue;
        if (!canSend(entry.delegationId)) break;
        if (deps.effects.send({ delegationId: entry.delegationId, content: deps.phrases.clarifying })) {
          entry.clarifiedFor = entry.heldSince;
          lastSendAt = at;
        }
        break;
      }

      // Отправка итога: по порядку, ворота открыты, итог актуален.
      for (const entry of ordered) {
        if (entry.speech !== 'queued' || entry.gate !== 'open') continue;
        if (!canSend(entry.delegationId)) break;
        const short = shorten(entry.text, RESULT_TOKEN_LIMIT);
        const content = short === null ? entry.text : `${short} ${deps.phrases.detailsOnScreen}`;
        if (!deps.effects.send({ delegationId: entry.delegationId, content })) break;
        entry.speech = 'submitted';
        entry.submittedAt = at;
        entry.spoken = content;
        entry.heard = '';
        entry.truncated = short !== null;
        lastSendAt = at;
        // Сокращённый итог отсылает к экрану: карточка должна быть видна, когда голос это говорит.
        if (entry.truncated) showCard(entry);
        deps.effects.ack(entry.requestId, entry.revision);
        notify();
        break;
      }
    },

    items() {
      return [...entries.values()].map((entry) => ({
        requestId: entry.requestId,
        jobId: entry.jobId,
        revision: entry.revision,
        delegationId: entry.delegationId,
        speech: entry.speech,
        card: entry.card,
        text: entry.text,
        truncated: entry.truncated,
        gate: entry.gate,
        heldSince: entry.heldSince,
        queuedAt: entry.queuedAt,
        submittedAt: entry.submittedAt,
      }));
    },

    sessionEnded() {
      humanSpeaking = false;
      modelPlaying = false;
      for (const entry of entries.values()) {
        if (entry.speech === 'submitted') toUnknown(entry);
        else if (entry.speech === 'queued') entry.delegationId = null;
      }
      notify();
    },
  };
}
