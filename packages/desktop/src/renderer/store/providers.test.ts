/**
 * Провайдеры для строки статуса (спека окна 2026-09-29, 1.1): `providers.list` окно зовёт при подключении
 * к хосту и после переподключения, а не на каждый рендер. Метода нет или отказ — сегментов провайдеров
 * нет, остальное работает.
 *
 * Лимиты подписок (спека комнат Organic, 3.5): приходят с `providers.list` полем `limits`, а событие
 * `providers.limitsChanged` обновляет ровно одного провайдера. Хост без поля — лимитов просто нет.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimits } from '@parley/protocol';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useProvidersStore } from './providers.js';

beforeEach(() => {
  useProvidersStore.setState({ providers: [], loaded: false });
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
    expect(useProvidersStore.getState().loaded).toBe(false);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    // Первый ответ пришёл — вид вкладки (lib/feed-view.ts) перестаёт ждать.
    expect(useProvidersStore.getState().loaded).toBe(true);
    expect(useProvidersStore.getState().providers).toEqual([
      { id: 'claude', label: 'Claude', available: true, version: '2.1.276', limits: null },
      { id: 'codex', label: 'Codex', available: false, version: null, limits: null },
    ]);
    dispose();
  });

  it('хост, переживший окно, версию не шлёт: поля нет — «версии нет» (null)', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [{ id: 'claude', label: 'Claude', available: true }] }));

    useProvidersStore.getState().init(bridge);
    await flush();

    expect(useProvidersStore.getState().providers).toEqual([
      { id: 'claude', label: 'Claude', available: true, version: null, limits: null },
    ]);
  });

  it('отказ providers.list — список пуст, остальное работает: ни падения, ни необработанного отказа', async () => {
    const bridge = createFakeBridge();
    // Обработчика нет — fake-bridge отклоняет вызов.
    useProvidersStore.setState({ providers: [{ id: 'claude', label: 'Claude', available: true, version: null, limits: null }] });

    const dispose = useProvidersStore.getState().init(bridge);
    await flush();

    expect(useProvidersStore.getState().providers).toEqual([]);
    // Отказ — тоже ответ: версия неизвестна, вид вкладки — терминал, а не вечное ожидание.
    expect(useProvidersStore.getState().loaded).toBe(true);
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

// Лимиты подписок (спека комнат Organic, 3.5): числа хоста — из `providers.list` и события.
describe('useProvidersStore — лимиты подписок', () => {
  const claudeLimits: ProviderLimits = {
    fiveHour: { usedPercent: 58.7, resetsAt: '2026-09-29T21:30:00.000Z' },
    week: { usedPercent: 41, resetsAt: '2026-10-03T09:05:00.000Z' },
    at: '2026-09-29T18:20:00.000Z',
  };
  const codexLimits: ProviderLimits = {
    fiveHour: { usedPercent: 85, resetsAt: '2026-09-29T22:00:00.000Z' },
    week: null,
    at: '2026-09-29T18:25:00.000Z',
  };

  /** Список хоста с двумя провайдерами; лимиты Claude — из ответа, у Codex поля нет. */
  async function connect(bridge = createFakeBridge()) {
    bridge.setHandler('providers.list', () => ({
      providers: [
        { id: 'claude', label: 'Claude', available: true, version: '2.1.276', limits: claudeLimits },
        { id: 'codex', label: 'Codex', available: true, version: '0.44.0' },
      ],
    }));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    return { bridge, dispose };
  }

  const limitsOf = (id: string): ProviderLimits | null | undefined =>
    useProvidersStore.getState().providers.find((provider) => provider.id === id)?.limits;

  it('providers.list: limits в ответе — в сторе как есть; нет поля (хост без 9a) или null — лимитов нет', async () => {
    const { dispose } = await connect();
    expect(limitsOf('claude')).toEqual(claudeLimits);
    expect(limitsOf('codex')).toBeNull();
    dispose();
  });

  it('providers.limitsChanged обновляет одного провайдера: у остальных те же объекты, а не копии', async () => {
    const { bridge, dispose } = await connect();
    const claudeBefore = useProvidersStore.getState().providers[0];

    bridge.emit('providers.limitsChanged', { id: 'codex', limits: codexLimits });

    expect(limitsOf('codex')).toEqual(codexLimits);
    expect(useProvidersStore.getState().providers[0]).toBe(claudeBefore);
    expect(useProvidersStore.getState().providers[1]).toEqual({
      id: 'codex',
      label: 'Codex',
      available: true,
      version: '0.44.0',
      limits: codexLimits,
    });
    dispose();
  });

  it('limits: null в событии — данные пропали, сегмент остаётся без лимитов', async () => {
    const { bridge, dispose } = await connect();

    bridge.emit('providers.limitsChanged', { id: 'claude', limits: null });

    expect(limitsOf('claude')).toBeNull();
    expect(useProvidersStore.getState().providers).toHaveLength(2);
    dispose();
  });

  it('событие о неизвестном провайдере ничего не меняет: список остаётся тем же объектом', async () => {
    const { bridge, dispose } = await connect();
    const before = useProvidersStore.getState().providers;

    bridge.emit('providers.limitsChanged', { id: 'gemini', limits: codexLimits });

    expect(useProvidersStore.getState().providers).toBe(before);
    dispose();
  });

  it('событие раньше ответа providers.list не ломает стор; ответ — не старее события — ложится как есть', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({
      providers: [{ id: 'claude', label: 'Claude', available: true, version: null, limits: claudeLimits }],
    }));
    const dispose = useProvidersStore.getState().init(bridge);

    bridge.emit('providers.limitsChanged', { id: 'claude', limits: null });
    expect(useProvidersStore.getState().providers).toEqual([]);
    await flush();

    expect(limitsOf('claude')).toEqual(claudeLimits);
    dispose();
  });

  it('после отписки события в стор не попадают; повторный init (переподключение) снова их слушает', async () => {
    const { bridge, dispose } = await connect();
    dispose();

    bridge.emit('providers.limitsChanged', { id: 'claude', limits: null });
    expect(limitsOf('claude')).toEqual(claudeLimits);

    const again = useProvidersStore.getState().init(bridge);
    await flush();
    bridge.emit('providers.limitsChanged', { id: 'claude', limits: null });
    expect(limitsOf('claude')).toBeNull();
    again();
  });
});
