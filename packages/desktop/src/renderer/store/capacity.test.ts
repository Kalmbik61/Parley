/**
 * Снимок ёмкости машины в окне (спека сна агентов и ёмкости, 4.5): начальное значение из `capacity.get`
 * (хост шлёт первое `capacity.changed` только на первое событие), дальше события, отказ старого хоста — тихий.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CapacitySnapshot } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useCapacityStore } from './capacity.js';

const snapshot = (live: number, patch: Partial<CapacitySnapshot['machine']> = {}): CapacitySnapshot => ({
  machine: { live, limit: 18, queued: 0, pressure: 'normal', swapGb: null, sleepMinutes: 60, ...patch },
  queue: [],
});

/** Ответы моста приходят через несколько микрозадач: ждём таймер, а не считаем их. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useCapacityStore.setState({ snapshot: null });
});

describe('useCapacityStore', () => {
  it('init берёт снимок из capacity.get и применяет capacity.changed', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('capacity.get', async () => snapshot(3));
    const dispose = useCapacityStore.getState().init(bridge);
    await flush();
    expect(useCapacityStore.getState().snapshot?.machine.live).toBe(3);
    bridge.emit('capacity.changed', snapshot(5));
    expect(useCapacityStore.getState().snapshot?.machine.live).toBe(5);
    dispose();
  });

  it('событие, пришедшее раньше ответа capacity.get, ответом не откатывается', async () => {
    const bridge = createFakeBridge();
    let answer: (value: CapacitySnapshot) => void = () => {};
    bridge.setHandler('capacity.get', () => new Promise((resolve) => (answer = resolve)));
    const dispose = useCapacityStore.getState().init(bridge);
    bridge.emit('capacity.changed', snapshot(7));
    answer(snapshot(2));
    await flush();
    expect(useCapacityStore.getState().snapshot?.machine.live).toBe(7);
    dispose();
  });

  it('хост без capacity.get — снимка нет, ошибки не вылетает', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('capacity.get', async () => {
      throw new Error('unknown method');
    });
    const dispose = useCapacityStore.getState().init(bridge);
    await flush();
    expect(useCapacityStore.getState().snapshot).toBeNull();
    dispose();
  });

  it('после отписки событие не применяется, а ответ capacity.get не записывается', async () => {
    const bridge = createFakeBridge();
    let answer: (value: CapacitySnapshot) => void = () => {};
    bridge.setHandler('capacity.get', () => new Promise((resolve) => (answer = resolve)));
    const dispose = useCapacityStore.getState().init(bridge);
    dispose();
    bridge.emit('capacity.changed', snapshot(4));
    answer(snapshot(9));
    await flush();
    expect(useCapacityStore.getState().snapshot).toBeNull();
  });

  it('новое подключение начинает с пустого снимка: прежний хост мог быть другим процессом', () => {
    const bridge = createFakeBridge();
    useCapacityStore.setState({ snapshot: snapshot(8) });
    const dispose = useCapacityStore.getState().init(bridge);
    expect(useCapacityStore.getState().snapshot).toBeNull();
    dispose();
  });
});
