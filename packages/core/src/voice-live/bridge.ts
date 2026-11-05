/**
 * Мост делегаций (спека «Голос↔Ассистент» §4, T4, чистый TS): превращает `delegation.created` и фрагменты
 * транскрипта в Request на хосте.
 * - Текст поручения — фрагменты человека, начавшиеся не позже `offset_ms` (см. `TranscriptBuffer.collect`); начало —
 *   пауза в речи или `offset_ms` предыдущей делегации.
 * - Если к моменту делегации транскрипт ещё не дошёл до `offset_ms`, ждём до `TRANSCRIPT_WAIT_MS`; после срока Request
 *   уходит с `transcriptPartial: true` (такому Request хост разрешает только уточнение и статус).
 * - Старт job не ждёт подтверждения: мост отправляет Request сразу, как собран текст.
 * - Повтор submit безопасен: хост идемпотентен по `originKey` (`voiceSessionId` + `delegationId`).
 * Тишину (вопрос о Parley без `delegation.created`) мост ошибкой не считает: сигнала об этом нет (T0).
 */
import { normalizeHumanText } from '../assistant/text.js';
import { createTranscriptBuffer, type TranscriptBuffer } from './transcript.js';

export const TRANSCRIPT_WAIT_MS = 1500;
/** Насколько транскрипт может отставать от `offset_ms` и всё же считаться дошедшим (T0: «интервал без текста» до 1,2 с). */
export const COVERAGE_GAP_MS = 1200;
export const CONTEXT_TURNS = 6;
export const CONTEXT_TURN_CHARS = 300;
export const CONTEXT_OPEN_REQUESTS = 5;
export const SUBMIT_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

/** События Live, которые нужны мосту (подмножество событий контроллера острова). */
export type BridgeEvent =
  | { type: 'delegationCreated'; delegationId: string; offsetMs: number }
  | { type: 'inputTranscript'; text: string; startMs: number; endMs: number }
  | { type: 'outputTranscript'; text: string; startMs: number; endMs: number };

export interface BridgeSubmitInput {
  conversationId: string;
  voiceSessionId: string;
  delegationId: string;
  text: string;
  context: Record<string, unknown>;
  transcriptPartial: boolean;
}

export interface BridgeSubmitResult {
  requestId: string;
  jobId: string;
  /** `false` — Request уже был (повтор после потерянного ответа). */
  created: boolean;
}

export interface OpenRequestSummary {
  requestId: string;
  text: string;
  state: string;
}

export interface DelegationBridgeDeps {
  conversationId: string;
  voiceSessionId: string;
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
  submit(input: BridgeSubmitInput): Promise<BridgeSubmitResult>;
  /** Открытые Request разговора для контекста job. */
  openRequests?(): OpenRequestSummary[];
  /** Текст, если человеческих фрагментов нет совсем (Request не бывает пустым). Английский: уходит агенту. */
  fallbackText?: string;
  transcriptWaitMs?: number;
}

export interface BridgeListener {
  delegationOpened?(info: { delegationId: string; createdAt: number; offsetMs: number }): void;
  /** `waitedMs` — от `delegation.created` до принятого хостом Request; `transcriptWaitMs` — до сборки текста поручения. */
  requestSubmitted?(info: { delegationId: string; requestId: string; jobId: string; created: boolean; transcriptPartial: boolean; waitedMs: number; transcriptWaitMs: number }): void;
  submitFailed?(info: { delegationId: string; attempts: number }): void;
}

export interface DelegationBridge {
  handle(event: BridgeEvent): void;
  /** Транскрипт модели, собранный и очищенный общим нормализатором (теги вроде `[hum]` режутся по собранному тексту). */
  modelTurns(beforeMs: number): string[];
  dispose(): void;
}

interface Waiting {
  delegationId: string;
  offsetMs: number;
  afterMs: number | null;
  createdAt: number;
  deadline: number;
}

export const DEFAULT_FALLBACK_TEXT = '(the spoken request was not transcribed)';

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

export function createDelegationBridge(deps: DelegationBridgeDeps, listener: BridgeListener = {}): DelegationBridge {
  const human: TranscriptBuffer = createTranscriptBuffer();
  const model: TranscriptBuffer = createTranscriptBuffer();
  const waitMs = deps.transcriptWaitMs ?? TRANSCRIPT_WAIT_MS;
  const seen = new Set<string>();
  let waiting: Waiting[] = [];
  let lastOffset: number | null = null;
  let cancelTimer: (() => void) | null = null;
  let disposed = false;

  const modelTurns = (beforeMs: number): string[] =>
    model
      .turns(beforeMs)
      .map((turn) => normalizeHumanText(turn.text, {}))
      .filter((text) => text !== '');

  const buildContext = (offsetMs: number, startMs: number | null): Record<string, unknown> => {
    const turns = [
      ...human.turns(offsetMs).filter((turn) => startMs === null || turn.startMs < startMs).map((turn) => ({ role: 'human', at: turn.startMs, text: turn.text })),
      ...model.turns(offsetMs).map((turn) => ({ role: 'assistant', at: turn.startMs, text: normalizeHumanText(turn.text, {}) })),
    ]
      .filter((turn) => turn.text !== '')
      .sort((a, b) => a.at - b.at)
      .slice(-CONTEXT_TURNS)
      .map((turn) => ({ role: turn.role, text: clip(turn.text, CONTEXT_TURN_CHARS) }));
    const open = (deps.openRequests?.() ?? []).slice(-CONTEXT_OPEN_REQUESTS).map((request) => ({ requestId: request.requestId, text: clip(request.text, CONTEXT_TURN_CHARS), state: request.state }));
    return { recentTurns: turns, openRequests: open };
  };

  const send = async (item: Waiting, text: string, partial: boolean, startMs: number | null): Promise<void> => {
    const transcriptWaitMs = deps.now() - item.createdAt;
    const input: BridgeSubmitInput = {
      conversationId: deps.conversationId,
      voiceSessionId: deps.voiceSessionId,
      delegationId: item.delegationId,
      text,
      context: buildContext(item.offsetMs, startMs),
      transcriptPartial: partial,
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await deps.submit(input);
        if (disposed) return;
        listener.requestSubmitted?.({ delegationId: item.delegationId, requestId: result.requestId, jobId: result.jobId, created: result.created, transcriptPartial: partial, waitedMs: deps.now() - item.createdAt, transcriptWaitMs });
        return;
      } catch {
        const delay = SUBMIT_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || disposed) {
          if (!disposed) listener.submitFailed?.({ delegationId: item.delegationId, attempts: attempt + 1 });
          return;
        }
        await new Promise<void>((resolveDelay) => {
          deps.setTimer(resolveDelay, delay);
        });
      }
    }
  };

  /** Отправляет готовых по порядку создания: следующая делегация не обгоняет предыдущую (порядок `seq` на хосте). */
  const flush = (): void => {
    cancelTimer?.();
    cancelTimer = null;
    while (waiting.length > 0 && !disposed) {
      const head = waiting[0] as Waiting;
      const collected = human.collect(head.offsetMs, head.afterMs);
      const caughtUp = collected.text !== '' && human.highWaterMs !== null && human.highWaterMs >= head.offsetMs - COVERAGE_GAP_MS;
      if (!caughtUp && deps.now() < head.deadline) break;
      waiting = waiting.slice(1);
      const text = collected.text === '' ? (deps.fallbackText ?? DEFAULT_FALLBACK_TEXT) : collected.text;
      void send(head, text, !caughtUp, collected.firstStartMs);
    }
    const next = waiting[0];
    if (next !== undefined && !disposed) cancelTimer = deps.setTimer(flush, Math.max(0, next.deadline - deps.now()));
  };

  return {
    handle(event) {
      if (disposed) return;
      switch (event.type) {
        case 'inputTranscript':
          human.push({ text: event.text, startMs: event.startMs, endMs: event.endMs });
          if (waiting.length > 0) flush();
          return;
        case 'outputTranscript':
          model.push({ text: event.text, startMs: event.startMs, endMs: event.endMs });
          return;
        case 'delegationCreated': {
          if (seen.has(event.delegationId)) return;
          seen.add(event.delegationId);
          const createdAt = deps.now();
          waiting.push({ delegationId: event.delegationId, offsetMs: event.offsetMs, afterMs: lastOffset, createdAt, deadline: createdAt + waitMs });
          lastOffset = lastOffset === null ? event.offsetMs : Math.max(lastOffset, event.offsetMs);
          listener.delegationOpened?.({ delegationId: event.delegationId, createdAt, offsetMs: event.offsetMs });
          flush();
          return;
        }
      }
    },
    modelTurns,
    dispose() {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      waiting = [];
    },
  };
}
