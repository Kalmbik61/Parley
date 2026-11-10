import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from './deadline.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline', () => {
  it('быстрая работа даёт done и не оставляет таймеров', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(), 1000)).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('бесконечная работа даёт timeout ровно в ms', async () => {
    vi.useFakeTimers();
    let result: string | undefined;
    void withDeadline(new Promise(() => {}), 1000).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ работы пробрасывается', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});
