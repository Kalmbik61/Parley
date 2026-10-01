/** Тест 8 куска 3.1: статус хоста — из `onStatus` моста в стор, отсюда же `useHostSupports`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useHostSupports } from '../lib/capabilities.js';
import { useHostStore } from './host.js';

afterEach(() => {
  useHostStore.setState({ status: { state: 'connecting' }, connections: 0, appVersion: null });
});

describe('useHostStore', () => {
  it('init берёт версию окна у моста (app.version, 0.2.0)', async () => {
    const bridge = createFakeBridge();
    bridge.setAppVersion('0.2.0');
    expect(useHostStore.getState().appVersion).toBeNull();
    const dispose = useHostStore.getState().init(bridge);
    await vi.waitFor(() => expect(useHostStore.getState().appVersion).toBe('0.2.0'));
    dispose();
  });

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

  it('connections растёт на каждый переход в connected, повтор connected не считается (fix-7.3)', () => {
    const bridge = createFakeBridge();
    const dispose = useHostStore.getState().init(bridge);
    expect(useHostStore.getState().connections).toBe(1);
    act(() => bridge.setHostMethods(null));
    expect(useHostStore.getState().connections).toBe(1);
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'closed' }));
    act(() => bridge.setHostMethods(null));
    expect(useHostStore.getState().connections).toBe(2);
    dispose();
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
