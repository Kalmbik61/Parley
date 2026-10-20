import { describe, expect, it, vi } from 'vitest';
import { BotApiError, type BotApi } from './api.js';
import { createPoller } from './poller.js';
import type { TgUpdate } from './types.js';

const update = (id: number): TgUpdate => ({ update_id: id });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

type Step = TgUpdate[] | Error | 'hang';

/** Фейковый API: ответы `getUpdates` берутся по очереди; 'hang' висит до отмены сигнала. */
function setup(steps: Step[], seen: (id: number) => boolean = () => false) {
  const calls: Array<{ params: Record<string, unknown> | undefined; options: { timeoutMs?: number; signal?: AbortSignal } | undefined }> = [];
  const queue = [...steps];
  const api: BotApi = {
    call: (async (_method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      calls.push({ params, options });
      const step = queue.shift() ?? 'hang';
      if (step === 'hang') {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new BotApiError('getUpdates', 0, 'aborted', null)));
        });
      }
      if (step instanceof Error) throw step;
      return step;
    }) as BotApi['call'],
    download: vi.fn(),
  };
  const events: string[] = [];
  let offset: number | null = null;
  const onStatus = vi.fn((polling: string, error: string | null) => events.push(`status:${polling}:${error ?? ''}`));
  const sleeps: number[] = [];
  const poller = createPoller({
    api,
    offset: () => offset,
    setOffset: (next) => {
      offset = next;
      events.push(`offset:${next}`);
    },
    seen,
    onUpdate: async (item) => {
      events.push(`update:${item.update_id}`);
    },
    onStatus,
    log: vi.fn(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { poller, calls, events, onStatus, sleeps };
}

describe('createPoller', () => {
  it('skipBacklog: первый запрос offset -1 / timeout 0 без обработки, второй с offset = last + 1', async () => {
    const { poller, calls, events } = setup([[update(5), update(7)], []]);
    poller.start({ skipBacklog: true });
    await flush();
    expect(calls[0]?.params).toEqual({ offset: -1, timeout: 0 });
    expect(calls[1]?.params).toEqual({ offset: 8, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    expect(calls[1]?.options?.timeoutMs).toBe(45_000);
    expect(events).not.toContain('update:7');
    poller.stop();
  });

  it('setOffset зовётся после onUpdate, не до', async () => {
    const { poller, events } = setup([[update(10), update(11)]]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(events.slice(0, 4)).toEqual(['update:10', 'offset:11', 'update:11', 'offset:12']);
    poller.stop();
  });

  it('повтор update_id не доходит до onUpdate', async () => {
    const { poller, events } = setup([[update(3), update(4)]], (id) => id === 3);
    poller.start({ skipBacklog: false });
    await flush();
    expect(events).not.toContain('update:3');
    expect(events).toContain('update:4');
    poller.stop();
  });

  it('успех сообщает ok', async () => {
    const { poller, onStatus } = setup([[]]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('ok', null);
    poller.stop();
  });

  it('409: останов и conflict', async () => {
    const { poller, onStatus, calls } = setup([new BotApiError('getUpdates', 409, 'Conflict: terminated by other getUpdates', null)]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('conflict', 'Conflict: terminated by other getUpdates');
    expect(poller.running()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('409 про webhook: останов и подсказка про webhook, а не conflict', async () => {
    const { poller, onStatus } = setup([
      new BotApiError('getUpdates', 409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first", null),
    ]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('error', 'This bot has a webhook — remove it with @BotFather or deleteWebhook');
    expect(onStatus).not.toHaveBeenCalledWith('conflict', expect.anything());
    expect(poller.running()).toBe(false);
  });

  it('401: останов и текст про токен', async () => {
    const { poller, onStatus } = setup([new BotApiError('getUpdates', 401, 'Unauthorized', null)]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('error', 'Telegram rejected the token');
    expect(poller.running()).toBe(false);
  });

  it('сетевая ошибка: error, пауза 2 с и следующий запрос', async () => {
    const { poller, onStatus, calls, sleeps } = setup([new BotApiError('getUpdates', 0, 'fetch failed', null), []]);
    poller.start({ skipBacklog: false });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('error', 'fetch failed');
    expect(sleeps).toEqual([2_000]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    poller.stop();
  });

  it('пауза удваивается до 30 с', async () => {
    const failure = (): BotApiError => new BotApiError('getUpdates', 0, 'down', null);
    const { poller, sleeps } = setup(Array.from({ length: 7 }, failure));
    poller.start({ skipBacklog: false });
    await flush();
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    poller.stop();
  });

  it('stop прерывает запрос и сообщает off', async () => {
    const { poller, onStatus, calls } = setup(['hang']);
    poller.start({ skipBacklog: false });
    await flush();
    expect(poller.running()).toBe(true);
    poller.stop();
    await flush();
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith('off', null);
    expect(poller.running()).toBe(false);
  });
});
