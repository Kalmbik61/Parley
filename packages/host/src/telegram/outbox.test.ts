import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApiError } from './api.js';
import { createOutbox, type Priority } from './outbox.js';

const log = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  log.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const job = (priority: Priority, trace: string[], name: string, key?: string) => ({
  priority,
  ...(key === undefined ? {} : { key }),
  run: async (): Promise<void> => {
    trace.push(name);
  },
});

describe('createOutbox', () => {
  it('card раньше notice раньше typing, внутри приоритета FIFO', async () => {
    const outbox = createOutbox({ log });
    const trace: string[] = [];
    // Первое задание уходит сразу; порядок проверяем по остальным, пока оно «выполняется».
    let release = (): void => {};
    outbox.enqueue({ priority: 'typing', run: () => new Promise<void>((resolve) => (release = resolve)) });
    outbox.enqueue(job('typing', trace, 't1'));
    outbox.enqueue(job('notice', trace, 'n1'));
    outbox.enqueue(job('card', trace, 'c1'));
    outbox.enqueue(job('card', trace, 'c2'));
    outbox.enqueue(job('notice', trace, 'n2'));
    release();
    await outbox.idle();
    expect(trace).toEqual(['c1', 'c2', 'n1', 'n2', 't1']);
  });

  it('key заменяет уже стоящее задание', async () => {
    const outbox = createOutbox({ log });
    const trace: string[] = [];
    let release = (): void => {};
    outbox.enqueue({ priority: 'card', run: () => new Promise<void>((resolve) => (release = resolve)) });
    outbox.enqueue(job('typing', trace, 'old', 'typing:1'));
    outbox.enqueue(job('typing', trace, 'new', 'typing:1'));
    expect(outbox.size()).toBe(1);
    release();
    await outbox.idle();
    expect(trace).toEqual(['new']);
  });

  it('429: пауза retryAfter и повтор того же задания первым', async () => {
    const outbox = createOutbox({ log });
    const trace: string[] = [];
    let attempts = 0;
    outbox.enqueue({
      priority: 'notice',
      run: async () => {
        attempts += 1;
        trace.push(`a${attempts}`);
        if (attempts === 1) throw new BotApiError('sendMessage', 429, 'Too Many Requests', 3);
      },
    });
    outbox.enqueue(job('card', trace, 'card'));
    await vi.advanceTimersByTimeAsync(2_900);
    expect(trace).toEqual(['a1']);
    await vi.advanceTimersByTimeAsync(200);
    await outbox.idle();
    expect(trace).toEqual(['a1', 'a2', 'card']);
  });

  it('429 без retryAfter ждёт не меньше секунды', async () => {
    const outbox = createOutbox({ log });
    let attempts = 0;
    outbox.enqueue({
      priority: 'card',
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new BotApiError('sendMessage', 429, 'slow down', 0);
      },
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(2);
  });

  it('статус 0: три повтора через 2 с, потом задание снимается и пишется строка в лог', async () => {
    const outbox = createOutbox({ log });
    let attempts = 0;
    outbox.enqueue({
      priority: 'card',
      run: async () => {
        attempts += 1;
        throw new BotApiError('sendMessage', 0, 'fetch failed', null);
      },
    });
    await vi.advanceTimersByTimeAsync(6_100);
    await outbox.idle();
    expect(attempts).toBe(4);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('прочая ошибка снимает задание сразу, следующее выполняется', async () => {
    const outbox = createOutbox({ log });
    const trace: string[] = [];
    outbox.enqueue({
      priority: 'card',
      run: async () => {
        throw new BotApiError('sendMessage', 400, 'bad request', null);
      },
    });
    outbox.enqueue(job('notice', trace, 'next'));
    await outbox.idle();
    expect(trace).toEqual(['next']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('clear выбрасывает очередь и прерывает повтор', async () => {
    const outbox = createOutbox({ log });
    const trace: string[] = [];
    let attempts = 0;
    outbox.enqueue({
      priority: 'card',
      run: async () => {
        attempts += 1;
        throw new BotApiError('sendMessage', 429, 'wait', 10);
      },
    });
    outbox.enqueue(job('notice', trace, 'n'));
    await vi.advanceTimersByTimeAsync(10);
    outbox.clear();
    expect(outbox.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000);
    await outbox.idle();
    expect(attempts).toBe(1);
    expect(trace).toEqual([]);
  });
});
