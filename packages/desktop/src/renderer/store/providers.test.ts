/**
 * Провайдеры для строки статуса (спека окна 2026-09-29, 1.1): `providers.list` окно зовёт при подключении
 * к хосту и после переподключения, а не на каждый рендер. Метода нет или отказ — сегментов провайдеров
 * нет, остальное работает.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useProvidersStore } from './providers.js';

beforeEach(() => {
  useProvidersStore.setState({ providers: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useProvidersStore.init', () => {
  it('один вызов providers.list при подключении; ответ — в сторе в порядке хоста', async () => {
    const bridge = createFakeBridge();
    const handler = vi.fn(() => ({
      providers: [
        { id: 'claude', label: 'Claude', available: true, version: '2.1.276' },
        { id: 'codex', label: 'Codex', available: false, version: null },
      ],
    }));
    bridge.setHandler('providers.list', handler);

    const dispose = useProvidersStore.getState().init(bridge);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(useProvidersStore.getState().providers).toEqual([
      { id: 'claude', label: 'Claude', available: true, version: '2.1.276' },
      { id: 'codex', label: 'Codex', available: false, version: null },
    ]);
    dispose();
  });

  it('хост, переживший окно, версию не шлёт: поля нет — «версии нет» (null)', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [{ id: 'claude', label: 'Claude', available: true }] }));

    useProvidersStore.getState().init(bridge);
    await flush();

    expect(useProvidersStore.getState().providers).toEqual([{ id: 'claude', label: 'Claude', available: true, version: null }]);
  });

  it('отказ providers.list — список пуст, остальное работает: ни падения, ни необработанного отказа', async () => {
    const bridge = createFakeBridge();
    // Обработчика нет — fake-bridge отклоняет вызов.
    useProvidersStore.setState({ providers: [{ id: 'claude', label: 'Claude', available: true, version: null }] });

    const dispose = useProvidersStore.getState().init(bridge);
    await flush();

    expect(useProvidersStore.getState().providers).toEqual([]);
    dispose();
  });

  it('хост без метода providers.list отвечает unknown_method — список пуст, как при любом отказе', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => {
      throw encodeIpcError({ code: 'unknown_method', message: 'нет метода' });
    });

    useProvidersStore.getState().init(bridge);
    await flush();

    expect(useProvidersStore.getState().providers).toEqual([]);
  });

  it('ответ, пришедший после отписки, в стор не попадает; повторный init (переподключение) перечитывает список', async () => {
    const bridge = createFakeBridge();
    let call = 0;
    bridge.setHandler('providers.list', () => {
      call += 1;
      return { providers: [{ id: 'claude', label: 'Claude', available: true, version: `2.1.${call}` }] };
    });

    const first = useProvidersStore.getState().init(bridge);
    first();
    await flush();
    expect(useProvidersStore.getState().providers).toEqual([]);

    const second = useProvidersStore.getState().init(bridge);
    await flush();
    expect(call).toBe(2);
    expect(useProvidersStore.getState().providers[0]?.version).toBe('2.1.2');
    second();
  });
});
