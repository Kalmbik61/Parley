/**
 * Long polling `getUpdates` (план B, задача 5). Смещение хранит вызывающий (`offset`/`setOffset`) и двигается только
 * после обработки апдейта, поэтому падение хоста посреди апдейта не теряет его. 409 (второй опрос тем же ботом) и
 * 401 (токен отклонён) останавливают цикл: повторять их бессмысленно.
 */

import type { TelegramPolling } from '@parley/protocol';
import { BotApiError, type BotApi } from './api.js';
import type { TgUpdate } from './types.js';

export interface Poller {
  start(options: { skipBacklog: boolean }): void;
  stop(): void;
  running(): boolean;
}

const POLL_TIMEOUT_S = 25;
const REQUEST_TIMEOUT_MS = 45_000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export function createPoller(deps: {
  api: BotApi;
  offset(): number | null;
  setOffset(next: number): void;
  seen(updateId: number): boolean;
  onUpdate(update: TgUpdate): Promise<void>;
  onStatus(polling: TelegramPolling, error: string | null): void;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
}): Poller {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let controller: AbortController | null = null;

  /** Гасит текущий цикл без сообщения о статусе. */
  const halt = (): void => {
    controller?.abort();
    controller = null;
  };

  const loop = async (mine: AbortController, skipBacklog: boolean): Promise<void> => {
    let backoff = BACKOFF_START_MS;
    let skip = skipBacklog;
    while (!mine.signal.aborted) {
      try {
        if (skip) {
          const updates = await deps.api.call<TgUpdate[]>('getUpdates', { offset: -1, timeout: 0 }, { signal: mine.signal });
          if (updates.length > 0) deps.setOffset(Math.max(...updates.map((update) => update.update_id)) + 1);
          skip = false;
        } else {
          const offset = deps.offset();
          const updates = await deps.api.call<TgUpdate[]>(
            'getUpdates',
            { ...(offset === null ? {} : { offset }), timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
            { timeoutMs: REQUEST_TIMEOUT_MS, signal: mine.signal },
          );
          for (const update of updates) {
            if (mine.signal.aborted) return;
            if (!deps.seen(update.update_id)) {
              try {
                await deps.onUpdate(update);
              } catch (error) {
                deps.log(`telegram poller: update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            deps.setOffset(update.update_id + 1);
          }
        }
        backoff = BACKOFF_START_MS;
        deps.onStatus('ok', null);
      } catch (error) {
        if (mine.signal.aborted) return;
        const status = error instanceof BotApiError ? error.status : 0;
        const description = error instanceof BotApiError ? error.description : error instanceof Error ? error.message : String(error);
        if (status === 409) {
          if (controller === mine) halt();
          deps.onStatus('conflict', description);
          return;
        }
        if (status === 401) {
          if (controller === mine) halt();
          deps.onStatus('error', 'Telegram rejected the token');
          return;
        }
        deps.onStatus('error', description);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  };

  return {
    start(options) {
      if (controller !== null) return;
      const mine = new AbortController();
      controller = mine;
      void loop(mine, options.skipBacklog);
    },
    stop() {
      if (controller === null) return;
      halt();
      deps.onStatus('off', null);
    },
    running: () => controller !== null,
  };
}
