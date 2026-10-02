/**
 * Методы `feed.*` (план 2026-10-01, Task 2): снимок ленты сессии или субагента, подписка на дельты
 * `feed.changed` и решение человека по карточке. Схемы параметров проверяет сервер (`METHODS`),
 * состояние ленты держит `FeedService`.
 */

import type { Handler } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';

export interface FeedMethodDeps {
  feed: FeedService;
}

export interface FeedHandlers {
  feedSnapshot: Handler<'feed.snapshot'>;
  feedSubscribe: Handler<'feed.subscribe'>;
  feedUnsubscribe: Handler<'feed.unsubscribe'>;
  feedDecide: Handler<'feed.decide'>;
}

export function createFeedHandlers(deps: FeedMethodDeps): FeedHandlers {
  return {
    feedSnapshot: (params) => deps.feed.snapshot(params.ref, params.agentId),
    feedSubscribe: async (params, request) => {
      deps.feed.subscribe(params.ref, request.client);
      return { ok: true };
    },
    feedUnsubscribe: async (params, request) => {
      deps.feed.unsubscribe(params.ref, request.client);
      return { ok: true };
    },
    feedDecide: async (params) => deps.feed.decide(params.ref, params.cardId, params.decision),
  };
}
