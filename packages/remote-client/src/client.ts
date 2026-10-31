// Сборка ядра клиента: стор + перечитыватель карточек + действия + подтягивание писем. UI берёт отсюда стор и методы.
import type { FeedDecision } from '@parley/core';
import { decide, readCards, resolveProposal, type DecideOutcome, type ResolveOutcome, type ResolveProposalParams, type Rpc } from './actions.js';
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
  /** Кадр события моста или хоста. */
  handleEvent(event: string, data: unknown): void;
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Promise<DecideOutcome>;
  resolveProposal(params: ResolveProposalParams): Promise<ResolveOutcome>;
  readCards(ref: SessionRef): ReturnType<typeof readCards>;
  dispose(): void;
}

export function createRemoteClient({ rpc, clock }: RemoteClientOptions): RemoteClient {
  const store = createRemoteStore();
  const refresher = createRefresher({ store, rpc, clock });
  const now = (): number => clock.now();

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
    handleEvent: (event, data) => store.handleEvent(event, data),
    decide: (ref, cardId, decision) => decide(store, rpc, now, ref, cardId, decision),
    resolveProposal: (params) => resolveProposal(store, rpc, params),
    readCards: (ref) => readCards(store, rpc, now, ref),
    dispose: () => {
      unsubscribe();
      refresher.dispose();
    },
  };
}
