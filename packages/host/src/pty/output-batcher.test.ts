import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_BATCH_MAX_CHARS, OutputBatcher } from './output-batcher.js';

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

  it('кусок меньше потолка ведёт себя как раньше — один сброс через 16 мс', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush);
    const data = 'x'.repeat(OUTPUT_BATCH_MAX_CHARS - 1);

    batcher.push(data);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(data);
  });

  it('после накопления 256 КиБ сбрасывает сразу, остаток — по таймеру', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush);
    const half = 'a'.repeat(128 * 1024);

    batcher.push(half);
    expect(flush).not.toHaveBeenCalled();

    batcher.push(half);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0]).toHaveLength(256 * 1024);

    batcher.push(half);
    expect(flush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]?.[0]).toHaveLength(128 * 1024);
  });

  it('один push на 1 МиБ даёт четыре сброса по 256 КиБ без таймера', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush);

    batcher.push('y'.repeat(1024 * 1024));

    expect(flush).toHaveBeenCalledTimes(4);
    for (const [chunk] of flush.mock.calls) expect(chunk).toHaveLength(256 * 1024);

    vi.advanceTimersByTime(16);
    expect(flush).toHaveBeenCalledTimes(4);
  });

  it('порядок данных сохраняется: куски в сумме равны входу', () => {
    const flush = vi.fn();
    const batcher = new OutputBatcher(flush);
    // Разные символы по позициям, чтобы перестановка кусков не прошла незамеченной.
    const input = Array.from({ length: 700 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

    batcher.push(input.slice(0, 300 * 1024));
    batcher.push(input.slice(300 * 1024));
    vi.advanceTimersByTime(16);

    expect(flush.mock.calls.map(([chunk]) => chunk).join('')).toBe(input);
  });
});
