/** Тест 8 куска 3.1: статус хоста — из `onStatus` моста в стор, отсюда же `useHostSupports`. */

import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useHostSupports } from '../lib/capabilities.js';
import { useHostStore } from './host.js';

afterEach(() => {
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('useHostStore', () => {
  it('до init — connecting; onStatus подставного моста пишет статус в стор', () => {
    expect(useHostStore.getState().status).toEqual({ state: 'connecting' });
    const bridge = createFakeBridge();
    const dispose = useHostStore.getState().init(bridge);
    expect(useHostStore.getState().status.state).toBe('connected');

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'closed' }));
    expect(useHostStore.getState().status).toEqual({ state: 'disconnected', reason: 'closed' });

    dispose();
    act(() => bridge.emitStatus({ state: 'connecting' }));
    expect(useHostStore.getState().status.state).toBe('disconnected');
  });

  it('useHostSupports(works.rename): true по умолчанию моста, false после setHostMethods(null)', () => {
    const bridge = createFakeBridge();
    const dispose = useHostStore.getState().init(bridge);
    const { result } = renderHook(() => useHostSupports('works.rename'));
    expect(result.current).toBe(true);

    act(() => bridge.setHostMethods(null));
    expect(result.current).toBe(false);
    dispose();
  });
});
