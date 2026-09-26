import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputBatcher } from './output-batcher.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutputBatcher', () => {
  it('три push за 10 мс дают одну отправку со склеенными данными', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush, 16);

    batcher.push('a');
    vi.advanceTimersByTime(5);
    batcher.push('b');
    vi.advanceTimersByTime(5);
    batcher.push('c');

    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('abc');
  });

  it('после отправки следующий push открывает новую пачку', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush, 16);

    batcher.push('первая');
    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledTimes(1);

    batcher.push('вторая');
    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith('вторая');
  });

  it('dispose() отменяет ожидающую пачку без отправки', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush, 16);

    batcher.push('пропадёт');
    batcher.dispose();
    vi.advanceTimersByTime(50);

    expect(flush).not.toHaveBeenCalled();
  });
});
