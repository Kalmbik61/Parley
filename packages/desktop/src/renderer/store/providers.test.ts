/**
 * Провайдеры для строки статуса (спека окна 2026-09-29, 1.1): `providers.list` окно зовёт при подключении
 * к хосту и после переподключения, а не на каждый рендер. Метода нет или отказ — сегментов провайдеров
 * нет, остальное работает.
 *
 * Лимиты подписок (спека комнат Organic, 3.5): приходят с `providers.list` полем `limits`, а событие
 * `providers.limitsChanged` обновляет ровно одного провайдера. Хост без поля — лимитов просто нет.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimits, Result } from '@parley/protocol';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useProvidersStore } from './providers.js';

beforeEach(() => {
  useProvidersStore.setState({ providers: [], loaded: false });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('useProvidersStore — подключение ключа и поколения', () => {
  const snapshot = (available: boolean): Result<'providers.list'> => ({ providers: [{
    id: 'glm', label: 'GLM', available, family: 'claude', needs: available ? null : 'key',
    keyHint: available ? '••••1234' : null, version: '2.1.287',
  }] });
  const deferred = () => {
    let resolve!: (value: Result<'providers.list'>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Result<'providers.list'>>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  it('новые поля сохраняются; changed перечитывает список и после отписки молчит', async () => {
    const bridge = createFakeBridge();
    let ready = false;
    bridge.setHandler('providers.list', () => snapshot(ready));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    expect(useProvidersStore.getState().providers[0]).toMatchObject({ family: 'claude', needs: 'key', keyHint: null });
    ready = true;
    bridge.emit('providers.changed', { provider: 'glm' });
    await flush();
    expect(useProvidersStore.getState().providers[0]).toMatchObject({ available: true, keyHint: '••••1234' });
    dispose();
    bridge.emit('providers.changed', { provider: 'glm' });
    expect(bridge.calls).toHaveLength(2);
  });

  it('старый ответ не возвращает удалённый ключ после нового reload', async () => {
    const bridge = createFakeBridge();
    const first = deferred();
    const second = deferred();
    let count = 0;
    bridge.setHandler('providers.list', () => (++count === 1 ? first.promise : second.promise));
    const dispose = useProvidersStore.getState().init(bridge);
    const newer = useProvidersStore.getState().reload();
    second.resolve(snapshot(false));
    await newer;
    first.resolve(snapshot(true));
    await flush();
    expect(useProvidersStore.getState().providers[0]).toMatchObject({ available: false, keyHint: null });
    dispose();
  });

  it('отказ старого reload не стирает успешный новый снимок', async () => {
    const bridge = createFakeBridge();
    const first = deferred();
    let count = 0;
    bridge.setHandler('providers.list', () => (++count === 1 ? first.promise : snapshot(false)));
    const dispose = useProvidersStore.getState().init(bridge);
    await useProvidersStore.getState().reload();
    first.reject(new Error('старый запрос'));
    await flush();
    expect(useProvidersStore.getState().providers[0]?.needs).toBe('key');
    dispose();
  });

  it('новое подключение сбрасывает loaded; старый ответ и старые события не меняют новый хост', async () => {
    const oldBridge = createFakeBridge();
    const pending = deferred();
    oldBridge.setHandler('providers.list', () => pending.promise);
    const oldDispose = useProvidersStore.getState().init(oldBridge);
    const nextBridge = createFakeBridge();
    nextBridge.setHandler('providers.list', () => snapshot(false));
    const nextDispose = useProvidersStore.getState().init(nextBridge);
    expect(useProvidersStore.getState().loaded).toBe(false);
    await flush();
    pending.resolve(snapshot(true));
    oldBridge.emit('providers.changed', { provider: 'glm' });
    oldDispose();
    await flush();
    expect(useProvidersStore.getState().providers[0]?.available).toBe(false);
    await useProvidersStore.getState().reload();
    expect(nextBridge.calls).toHaveLength(2);
    nextDispose();
  });

  it('GLM никогда не принимает claude.ai лимиты из списка или события старого хоста', async () => {
    const bridge = createFakeBridge();
    const limits: ProviderLimits = { fiveHour: { usedPercent: 91, resetsAt: '2026-10-04T12:00:00Z' }, week: null, at: '2026-10-03T12:00:00Z' };
    bridge.setHandler('providers.list', () => ({ providers: [{ ...snapshot(true).providers[0]!, limits }] }));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    expect(useProvidersStore.getState().providers[0]?.limits).toBeNull();
    bridge.emit('providers.limitsChanged', { id: 'glm', limits });
    expect(useProvidersStore.getState().providers[0]?.limits).toBeNull();
    dispose();
  });
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


describe('useProvidersStore — ручное обновление лимитов', () => {
  const snapshot = (percent: number): Result<'providers.list'> => ({ providers: [{
    id: 'glm', label: 'GLM', available: true,
    limits: { source: 'zai', fiveHour: { usedPercent: percent, resetsAt: null }, week: null, at: '2026-10-03T12:00:00Z' },
  }] });
  const pendingRefresh = () => {
    let resolve!: (value: { ok: true }) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<{ ok: true }>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  it('принимает только подтверждённые квоты GLM из списка и событий; null очищает их', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => snapshot(42));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(42);
    const limits = snapshot(57).providers[0]!.limits!;
    bridge.emit('providers.limitsChanged', { id: 'glm', limits });
    expect(useProvidersStore.getState().providers[0]?.limits).toEqual(limits);
    bridge.emit('providers.limitsChanged', { id: 'glm', limits: { ...limits, source: undefined } });
    expect(useProvidersStore.getState().providers[0]?.limits).toEqual(limits);
    bridge.emit('providers.limitsChanged', { id: 'glm', limits: null });
    expect(useProvidersStore.getState().providers[0]?.limits).toBeNull();
    dispose();
  });

  it('обновляет все лимиты одним вызовом, объединяет повторный клик и затем перечитывает снимок', async () => {
    const bridge = createFakeBridge();
    let percent = 42;
    bridge.setHandler('providers.list', () => snapshot(percent));
    const pending = pendingRefresh();
    bridge.setHandler('providers.refreshLimits', () => pending.promise);
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    const first = useProvidersStore.getState().refreshLimits();
    const second = useProvidersStore.getState().refreshLimits();
    expect(useProvidersStore.getState().refreshing).toBe(true);
    expect(bridge.calls.filter(({ method }) => method === 'providers.refreshLimits')).toEqual([
      { method: 'providers.refreshLimits', params: {} },
    ]);
    percent = 57;
    pending.resolve({ ok: true });
    await Promise.all([first, second]);
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(57);
    expect(useProvidersStore.getState().refreshing).toBe(false);
    expect(bridge.calls.map(({ method }) => method)).toEqual(['providers.list', 'providers.refreshLimits', 'providers.list']);
    dispose();
  });

  it('после отказа перечитывает частичный результат и отдаёт ошибку вызывающему; можно повторить', async () => {
    const bridge = createFakeBridge();
    let percent = 42;
    const error = encodeIpcError({ code: 'internal', message: 'private text' });
    bridge.setHandler('providers.list', () => snapshot(percent));
    bridge.setHandler('providers.refreshLimits', () => { percent = 57; throw error; });
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    await expect(useProvidersStore.getState().refreshLimits()).rejects.toBe(error);
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(57);
    expect(useProvidersStore.getState().refreshing).toBe(false);
    bridge.setHandler('providers.refreshLimits', () => ({ ok: true }));
    await expect(useProvidersStore.getState().refreshLimits()).resolves.toBeUndefined();
    dispose();
  });

  it.each([false, true])('старое обновление после нового подключения не перечитывает новый мост и не показывает ошибку (%s)', async (reject) => {
    const oldBridge = createFakeBridge();
    oldBridge.setHandler('providers.list', () => snapshot(42));
    const pending = pendingRefresh();
    oldBridge.setHandler('providers.refreshLimits', () => pending.promise);
    const oldDispose = useProvidersStore.getState().init(oldBridge);
    await flush();
    const oldRefresh = useProvidersStore.getState().refreshLimits();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => snapshot(57));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    expect(useProvidersStore.getState().refreshing).toBe(false);
    if (reject) pending.reject(new Error('old connection'));
    else pending.resolve({ ok: true });
    await expect(oldRefresh).resolves.toBeUndefined();
    expect(bridge.calls).toHaveLength(1);
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(57);
    oldDispose();
    dispose();
  });

  it('завершение старого моста не снимает busy с обновления нового подключения', async () => {
    const oldBridge = createFakeBridge();
    oldBridge.setHandler('providers.list', () => snapshot(42));
    const oldPending = pendingRefresh();
    oldBridge.setHandler('providers.refreshLimits', () => oldPending.promise);
    const oldDispose = useProvidersStore.getState().init(oldBridge);
    await flush();
    const oldRefresh = useProvidersStore.getState().refreshLimits();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => snapshot(57));
    const pending = pendingRefresh();
    bridge.setHandler('providers.refreshLimits', () => pending.promise);
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    const refresh = useProvidersStore.getState().refreshLimits();
    oldDispose();
    oldPending.resolve({ ok: true });
    await oldRefresh;
    expect(useProvidersStore.getState().refreshing).toBe(true);
    const repeat = useProvidersStore.getState().refreshLimits();
    expect(bridge.calls.filter(({ method }) => method === 'providers.refreshLimits')).toHaveLength(1);
    pending.resolve({ ok: true });
    await Promise.all([refresh, repeat]);
    expect(useProvidersStore.getState().refreshing).toBe(false);
    dispose();
  });

  it('без активного моста обновление ничего не вызывает', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => snapshot(42));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    dispose();
    await useProvidersStore.getState().refreshLimits();
    expect(bridge.calls).toHaveLength(1);
  });
});
