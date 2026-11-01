// Сборка ядра клиента: стор + перечитыватель карточек + действия + подтягивание писем. UI берёт отсюда стор и методы.
import type { FeedDecision } from '@parley/core';
import {
  createRoom,
  checkTrust,
  createSession,
  decide,
  decideConsent,
  sendMessage,
  loadProviders,
  loadRoles,
  readCards,
  resolveProposal,
  sendRoomMessage,
  type CreateRoomOutcome,
  type CreateRoomParams,
  type CreateSessionOutcome,
  type CreateSessionParams,
  type DecideConsentOutcome,
  type DecideOutcome,
  type SendMessageOutcome,
  type SendMessageParams,
  type ResolveOutcome,
  type ResolveProposalParams,
  type Rpc,
  type SendRoomMessageOutcome,
  type SendRoomMessageParams,
} from './actions.js';
import { createLiveSync, type LiveSync } from './live.js';
import { createRefresher, type Clock, type Refresher } from './refresh.js';
import { createRemoteStore, type RemoteStore } from './store.js';
import { workKeyOf, type SessionRef } from './state.js';

export interface RemoteClientOptions {
  rpc: Rpc;
  clock: Clock;
}

export interface RemoteClient {
  store: RemoteStore;
  refresher: Refresher;
  live: LiveSync;
  /** Кадр события моста или хоста. */
  handleEvent(event: string, data: unknown): void;
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Promise<DecideOutcome>;
  resolveProposal(params: ResolveProposalParams): Promise<ResolveOutcome>;
  readCards(ref: SessionRef): ReturnType<typeof readCards>;
  /** Методы из hello моста (`hello.methods`); `null` — соединение потеряно. */
  setBridgeMethods(methods: string[] | null): void;
  createSession(params: CreateSessionParams): Promise<CreateSessionOutcome>;
  createRoom(params: CreateRoomParams): Promise<CreateRoomOutcome>;
  sendRoomMessage(params: SendRoomMessageParams): Promise<SendRoomMessageOutcome>;
  /** Экран сессии открыт: лента подписана, пока вызов закрытия не сделан. */
  openFeed(ref: SessionRef): () => void;
  /** Написать агенту; повтор после `lost` — с тем же `clientMsgId`. */
  sendMessage(params: SendMessageParams): Promise<SendMessageOutcome>;
  decideConsent(id: string, decision: 'allow' | 'deny'): Promise<DecideConsentOutcome>;
  /** Соединение готово / ушло; ведёт и перечитыватель карточек, и подписки. */
  setConnected(connected: boolean): void;
  setForeground(foreground: boolean): void;
  /** Доверена ли папка проекта на Маке (`trust.check`); `null` — неизвестно. */
  checkTrust(folder: string): Promise<boolean | null>;
  loadProviders(): Promise<boolean>;
  loadRoles(projectPath: string): Promise<boolean>;
  dispose(): void;
}

export function createRemoteClient({ rpc, clock }: RemoteClientOptions): RemoteClient {
  const store = createRemoteStore();
  const refresher = createRefresher({ store, rpc, clock });
  const live = createLiveSync({ store, rpc });
  const now = (): number => clock.now();
  const env = { now, sleep: (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms)) };

  // Письма: по счётчику `unread` снимка или `rooms.mail` дочитываем новейшую страницу `context.messages`, когда счётчик
  // сменился и писем в сторе меньше. Один запрос на работу одновременно.
  const fetchedFor = new Map<string, number>();
  const fetching = new Set<string>();
  const unsubscribe = store.subscribe((next, prev) => {
    if (next.epoch !== prev.epoch) fetchedFor.clear();
    if (next.letterUnread === prev.letterUnread) return;
    for (const work of next.snapshot?.works ?? []) {
      const key = workKeyOf(work.projectPath, work.id);
      const unread = next.letterUnread[key] ?? 0;
      if (unread === 0 || fetching.has(key) || fetchedFor.get(key) === unread) continue;
      const held = Object.values(next.letters[key] ?? {}).filter((m) => m.readBy.human === undefined).length;
      if (held >= unread) continue;
      fetchedFor.set(key, unread);
      fetching.add(key);
      const epoch = next.epoch;
      void rpc
        .call('context.messages', { projectPath: work.projectPath, workId: work.id, roomId: null })
        .then((res) => {
          const messages = (res as { messages?: unknown } | null)?.messages;
          if (Array.isArray(messages)) {
            store.dispatch({ t: 'messages', projectPath: work.projectPath, workId: work.id, roomId: null, messages: messages as never[], epoch });
          }
        })
        .catch(() => fetchedFor.delete(key))
        .finally(() => fetching.delete(key));
    }
  });

  return {
    store,
    refresher,
    live,
    handleEvent: (event, data) => store.handleEvent(event, data),
    decide: (ref, cardId, decision) => decide(store, rpc, now, ref, cardId, decision),
    resolveProposal: (params) => resolveProposal(store, rpc, params),
    readCards: (ref) => readCards(store, rpc, now, ref),
    setBridgeMethods: (methods) => store.dispatch({ t: 'hello', methods }),
    createSession: (params) => createSession(store, rpc, env, params),
    createRoom: (params) => createRoom(store, rpc, env, params),
    sendRoomMessage: (params) => sendRoomMessage(store, rpc, env, params),
    openFeed: (ref) => live.openFeed(ref),
    sendMessage: (params) => sendMessage(rpc, env, params),
    decideConsent: (id, decision) => decideConsent(store, rpc, id, decision),
    setConnected: (connected) => {
      refresher.setConnected(connected);
      live.setConnected(connected);
    },
    setForeground: (foreground) => {
      refresher.setForeground(foreground);
      live.setForeground(foreground);
    },
    checkTrust: (folder) => checkTrust(rpc, folder),
    loadProviders: () => loadProviders(store, rpc),
    loadRoles: (projectPath) => loadRoles(store, rpc, projectPath),
    dispose: () => {
      unsubscribe();
      live.dispose();
      refresher.dispose();
    },
  };
}
