import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { requestTranscript, useLiveTranscript, type Transcript, type TranscriptUpdate } from './transcript.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const ITEMS: FeedItem[] = [{ id: 'p', at: '2026-10-07T10:00:00.000Z', kind: 'prompt', text: 'go', images: 0 }];

function holder(initial: Transcript | null) {
  let value = initial;
  return { get: () => value, set: (update: TranscriptUpdate) => { value = update(value); } };
}

afterEach(() => vi.useRealTimers());

describe('requestTranscript', () => {
  it('впервые — loading, потом ready', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: ITEMS, revision: 0, schemaVersion: 2, mode: null }));
    const box = holder(null);
    requestTranscript(bridge, REF, 'a1', box.set);
    expect(box.get()).toEqual({ state: 'loading' });
    await vi.waitFor(() => expect(box.get()).toEqual({ state: 'ready', items: ITEMS }));
  });

  it('перечитывание показанного не мигает loading, а ошибка оставляет прежние элементы', async () => {
    const bridge = createFakeBridge(); // без обработчика — вызов отклоняется
    const box = holder({ state: 'ready', items: ITEMS });
    requestTranscript(bridge, REF, 'a1', box.set);
    expect(box.get()).toEqual({ state: 'ready', items: ITEMS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.get()).toEqual({ state: 'ready', items: ITEMS });
  });

  it('скрытый (null) пока шёл запрос — не воскресает', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: ITEMS, revision: 0, schemaVersion: 2, mode: null }));
    const box = holder(null);
    requestTranscript(bridge, REF, 'a1', box.set);
    box.set(() => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.get()).toBeNull();
  });
});

describe('useLiveTranscript', () => {
  it('рост toolCount у работающего — перечитать, но не чаще раза в 3 с; конец агента — ещё раз', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const { rerender } = renderHook(({ count, status }) => useLiveTranscript({ agentId: 'a1', status, toolCount: count }, true, reload), {
      initialProps: { count: 1, status: 'running' as const },
    });
    rerender({ count: 2, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    rerender({ count: 3, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalledTimes(2);
    rerender({ count: 3, status: 'done' });
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('транскрипт скрыт — не перечитывать', () => {
    const reload = vi.fn();
    const { rerender } = renderHook(({ count }) => useLiveTranscript({ agentId: 'a1', status: 'running', toolCount: count }, false, reload), {
      initialProps: { count: 1 },
    });
    rerender({ count: 2 });
    expect(reload).not.toHaveBeenCalled();
  });
});
