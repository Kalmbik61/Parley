/**
 * Методы `feed.*` (план 2026-10-01, Task 2): снимок ленты сессии или субагента, подписка на дельты
 * `feed.changed`, решение человека по карточке и «Stop» (Esc агенту). Схемы параметров проверяет сервер (`METHODS`),
 * состояние ленты держит `FeedService`.
 */

import { progressResult } from '@parley/protocol';
import type { Handler } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';

export interface FeedMethodDeps {
  feed: FeedService;
}

export interface FeedHandlers {
  feedSnapshot: Handler<'feed.snapshot'>;
  feedProgress: Handler<'feed.progress'>;
  feedSubscribe: Handler<'feed.subscribe'>;
  feedUnsubscribe: Handler<'feed.unsubscribe'>;
  feedDecide: Handler<'feed.decide'>;
  feedInterrupt: Handler<'feed.interrupt'>;
}

export function createFeedHandlers(deps: FeedMethodDeps): FeedHandlers {
  return {
    feedSnapshot: (params) => deps.feed.snapshot(params.ref, params.agentId, params.scope),
    feedProgress: async (params, request) => {
      const candidate = await deps.feed.progress(params.ref, request.client);
      const result = progressResult.safeParse(candidate);
      const revision = candidate?.revision;
      // Последняя граница перед generic server: не отправлять невалидный payload/ошибки schema клиенту.
      return result.success ? result.data : {
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
        availability: 'unavailable', current: null, recent: [], truncated: false,
      };
    },
    feedSubscribe: async (params, request) => {
      deps.feed.subscribe(params.ref, request.client);
      return { ok: true };
    },
    feedUnsubscribe: async (params, request) => {
      deps.feed.unsubscribe(params.ref, request.client);
      return { ok: true };
    },
    feedDecide: async (params) => deps.feed.decide(params.ref, params.cardId, params.decision),
    feedInterrupt: async (params) => {
      deps.feed.interrupt(params.ref);
      return { ok: true };
    },
  };
}
