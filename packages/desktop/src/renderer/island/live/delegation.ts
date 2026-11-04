/**
 * Проводка моста делегаций и очереди речи (T4) в остров. Чистые модули живут в `@parley/core/voice-live`; здесь только
 * подписки на Live-контроллер, вызовы хоста (`requests.*`) и опрос Request.
 *
 * - `delegationCreated` + фрагменты транскрипта → мост → `requests.submit` (локально, `origin: 'island'` ставит хост).
 * - Готовые итоги (`requests.list`, событие `assistant.job.changed`, опрос раз в секунду, пока есть что ждать) → очередь речи.
 * - Очередь отправляет `commentary.append` через контроллер и отмечает доставку `requests.ack(…, 'live', revision)`.
 * - Новая Live-сессия сразу перечитывает недоставленные итоги (VA-07): они уходят с `delegation_id: null`.
 * - Закрытие голоса job не отменяет: итог остаётся карточкой.
 * Тексты не логируются.
 */
import {
  createAckTracker,
  createDelegationBridge,
  createSpeechQueue,
  type AckTracker,
  type DelegationBridge,
  type OpenRequestSummary,
  type QueueItem,
  type ResultInput,
  type SpeechPhrases,
  type SpeechQueue,
} from '@parley/core/voice-live';
import type { AssistantRequestView } from '@parley/protocol';
import { ISLAND_CONVERSATION_ID, type IslandBridge } from '../../../shared/island.js';
import type { LiveController, LiveControllerEvent } from './controller.js';

/** Так хост называет потребителя Live (`LIVE_CONSUMER` в host/assistant/requests.ts). */
export const LIVE_CONSUMER_ID = 'live';
export const DELEGATION_TICK_MS = 250;
/** Опрос Request раз в столько тиков (≈1 с), пока есть открытые или ожидающие. */
const POLL_EVERY_TICKS = 4;

export interface LiveDelegationDeps {
  controller: Pick<LiveController, 'subscribe' | 'snapshot' | 'sendAppend'>;
  call: IslandBridge['call'];
  onHostEvent: IslandBridge['on'];
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
  setTick(callback: () => void, ms: number): () => void;
  phrases: SpeechPhrases;
  fallbackText: string;
  conversationId?: string;
}

/** Что показывает остров: итог, который вышел на экран, или удержанный (held) итог. */
export interface LiveResultView {
  requestId: string;
  text: string;
  kind: 'card' | 'held';
}

export interface LiveDelegation {
  items(): QueueItem[];
  results(): LiveResultView[];
  subscribe(listener: () => void): () => void;
  /** Убирает карточку с экрана (итог остаётся в очереди). */
  dismiss(requestId: string): void;
  dispose(): void;
}

/** Вид Request хоста → вход очереди. */
export function toResultInput(view: AssistantRequestView, delegationId: string | null): ResultInput {
  const terminal = view.job.state !== 'queued' && view.job.state !== 'running';
  return {
    requestId: view.requestId,
    jobId: view.job.jobId,
    revision: view.job.revision,
    state: view.job.state,
    text: view.job.result?.answer ?? view.job.resultSummary ?? '',
    gate: view.gate,
    heldSince: view.heldSince,
    stale: view.stale,
    delegationId,
    deliveredLive: terminal && (view.delivery[LIVE_CONSUMER_ID] ?? -1) >= view.job.revision,
  };
}

interface Session {
  voiceSessionId: string;
  bridge: DelegationBridge;
  ack: AckTracker;
}

export function createLiveDelegation(deps: LiveDelegationDeps): LiveDelegation {
  const conversationId = deps.conversationId ?? ISLAND_CONVERSATION_ID;
  const listeners = new Set<() => void>();
  const delegationByRequest = new Map<string, string>();
  const dismissed = new Set<string>();
  let session: Session | null = null;
  let openRequests: OpenRequestSummary[] = [];
  let refreshing = false;
  let refreshAgain = false;
  let ticks = 0;
  let disposed = false;
  /** Ack-трекер живёт и вне сессии (пустой), чтобы очередь могла спрашивать его всегда. */
  let idleAck = createAckTracker({ now: deps.now });

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // подписчик не должен ломать остальных
      }
    }
  };

  const queue: SpeechQueue = createSpeechQueue({
    now: deps.now,
    phrases: deps.phrases,
    canAppend: (delegationId, purpose) => (session?.ack ?? idleAck).canAppend(delegationId, purpose),
    effects: {
      send: ({ delegationId, content }) => deps.controller.sendAppend({ kind: 'commentary', delegationId, content }),
      ack: (requestId, revision) => void deps.call('requests.ack', { requestId, consumer: LIVE_CONSUMER_ID, revision }).catch(() => {}),
      cardShown: (item) => void deps.call('jobs.ackInline', { jobId: item.jobId, revision: item.revision }).catch(() => {}),
      changed: notify,
    },
  });

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        let requests: AssistantRequestView[];
        try {
          requests = (await deps.call('requests.list', { conversationId, consumer: LIVE_CONSUMER_ID })).requests;
        } catch {
          return;
        }
        if (disposed) return;
        openRequests = requests
          .filter((request) => request.job.state === 'queued' || request.job.state === 'running')
          .map((request) => ({ requestId: request.requestId, text: request.text, state: request.job.state }));
        queue.observe(requests.map((request) => toResultInput(request, delegationByRequest.get(request.requestId) ?? null)));
        queue.step();
      } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  };

  const startSession = (voiceSessionId: string): Session => {
    const ack = createAckTracker({ now: deps.now });
    const bridge = createDelegationBridge(
      {
        conversationId,
        voiceSessionId,
        now: deps.now,
        setTimer: deps.setTimer,
        fallbackText: deps.fallbackText,
        openRequests: () => openRequests,
        submit: async (input) => {
          const { request, created } = await deps.call('requests.submit', input);
          return { requestId: request.requestId, jobId: request.jobId, created };
        },
      },
      {
        delegationOpened: ({ delegationId }) => ack.open(delegationId),
        requestSubmitted: ({ delegationId, requestId }) => {
          delegationByRequest.set(requestId, delegationId);
          void refresh();
        },
      },
    );
    const next: Session = { voiceSessionId, bridge, ack };
    session = next;
    const signals = deps.controller.snapshot();
    queue.setHumanSpeaking(signals.humanSpeaking);
    queue.setModelPlaying(signals.modelPlaying);
    // Восстановление: недоставленные итоги прошлых сессий уходят с `delegation_id: null`.
    void refresh();
    return next;
  };

  const endSession = (): void => {
    const current = session;
    if (current === null) return;
    session = null;
    current.bridge.dispose();
    idleAck = createAckTracker({ now: deps.now });
    queue.sessionEnded();
    void refresh();
  };

  /** Сессия создаётся лениво: первое событие канала может прийти раньше, чем контроллер объявит фазу `live`. */
  const ensureSession = (): Session | null => {
    if (session !== null) return session;
    const snapshot = deps.controller.snapshot();
    if (snapshot.voiceSessionId === null || snapshot.phase === 'idle') return null;
    return startSession(snapshot.voiceSessionId);
  };

  const onEvent = (event: LiveControllerEvent): void => {
    if (disposed) return;
    switch (event.type) {
      case 'phase':
        if (event.phase === 'live') ensureSession();
        return;
      case 'sessionClosed':
        endSession();
        return;
      case 'humanSpeaking':
        queue.setHumanSpeaking(event.value);
        return;
      case 'modelPlaying':
        queue.setModelPlaying(event.value);
        session?.ack.modelPlaying(event.value);
        return;
      case 'inputTranscript':
        ensureSession()?.bridge.handle({ type: 'inputTranscript', text: event.text, startMs: event.startMs, endMs: event.endMs });
        return;
      case 'outputTranscript':
        ensureSession()?.bridge.handle({ type: 'outputTranscript', text: event.text, startMs: event.startMs, endMs: event.endMs });
        queue.outputText(event.text);
        return;
      case 'delegationCreated': {
        const current = ensureSession();
        if (current === null) return;
        current.bridge.handle({ type: 'delegationCreated', delegationId: event.delegationId, offsetMs: event.offsetMs });
        return;
      }
      default:
        return;
    }
  };

  const unsubscribeController = deps.controller.subscribe(onEvent);
  const unsubscribeHost = deps.onHostEvent('assistant.job.changed', () => void refresh());
  const stopTick = deps.setTick(() => {
    queue.step();
    session?.ack.tick();
    ticks += 1;
    if (ticks % POLL_EVERY_TICKS === 0 && (session !== null || openRequests.length > 0 || queue.items().some((item) => item.speech === 'queued'))) void refresh();
  }, DELEGATION_TICK_MS);
  // Остров мог открыться при уже идущей сессии или с недоставленными итогами: один раз читаем.
  if (deps.controller.snapshot().phase === 'live') ensureSession();
  else void refresh();

  return {
    items: () => queue.items(),
    results: () =>
      queue
        .items()
        .filter((item) => !dismissed.has(item.requestId))
        .flatMap((item): LiveResultView[] => {
          if (item.speech === 'dropped') return [];
          if (item.card === 'shown') return [{ requestId: item.requestId, text: item.text, kind: 'card' }];
          if (item.speech === 'queued' && item.gate === 'held') return [{ requestId: item.requestId, text: '', kind: 'held' }];
          return [];
        }),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dismiss(requestId) {
      dismissed.add(requestId);
      notify();
    },
    dispose() {
      disposed = true;
      stopTick();
      unsubscribeController();
      unsubscribeHost();
      session?.bridge.dispose();
      session = null;
      listeners.clear();
    },
  };
}
