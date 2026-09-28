/** Тест 10 куска 3.3: `useNow` — одна дата раз в период, таймер снимается при размонтировании. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './use-now.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('новая дата раз в 30 с, между тиками — прежняя', () => {
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current;
    expect(first.toISOString()).toBe('2026-09-27T12:00:00.000Z');

    act(() => vi.advanceTimersByTime(29_000));
    expect(result.current).toBe(first);

    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).not.toBe(first);
    expect(result.current.toISOString()).toBe('2026-09-27T12:00:30.000Z');
  });

  it('размонтирование снимает таймер', () => {
    const { unmount } = renderHook(() => useNow(30_000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
