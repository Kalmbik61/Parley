/**
 * Мост preload острова (спека 2026-10-12, 5.2): набор ключей узкий, события и статус хоста раскладываются по
 * подписчикам, свои каналы — `island:*`. Электрон подменён так же, как в `index.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../shared/bridge.js';
import type { IslandBridge, IslandConfig } from '../shared/island.js';

type Handler = (event: unknown, ...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
/** Каналы, на которые preload подписался через `ipcRenderer.on`, — по порядку вызовов, без схлопывания повторов. */
const subscribed: string[] = [];
let exposed: IslandBridge | null = null;
let exposedKey: string | null = null;
const send = vi.fn();
const invoke = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: Handler) => {
      subscribed.push(channel);
      handlers.set(channel, handler);
    },
    send,
    invoke,
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposedKey = key;
      exposed = api as IslandBridge;
    },
  },
}));

/** Свежий модуль preload на каждый тест: его состояние — на уровне модуля. */
async function loadPreload(): Promise<IslandBridge> {
  handlers.clear();
  subscribed.length = 0;
  exposed = null;
  exposedKey = null;
  vi.resetModules();
  await import('./island.js');
  if (exposed === null) throw new Error('preload острова не выставил мост');
  return exposed;
}

const emit = (channel: string, ...args: unknown[]): void => handlers.get(channel)?.({}, ...args);

describe('preload острова', () => {
  beforeEach(() => {
    send.mockClear();
    invoke.mockClear();
  });

  it('в мосте только узкий набор: ни app, ни files, ни browser, ни voice, ни notify', async () => {
    const bridge = await loadPreload();
    expect(Object.keys(bridge).sort()).toEqual(['activitySnapshot', 'call', 'island', 'on', 'onStatus']);
    expect(Object.keys(bridge.island).sort()).toEqual(
      ['beep', 'config', 'dragEnd', 'dragMove', 'dragStart', 'failed', 'hintShown', 'onConfig', 'onHover', 'open', 'setHitRect', 'setVisible'].sort(),
    );
  });

  it('события хоста раскладываются по подписчикам, статус отдаётся и опоздавшему', async () => {
    const bridge = await loadPreload();
    const seen: unknown[] = [];
    bridge.on('works.changed', (data) => seen.push(data));
    emit('host:event', { event: 'works.changed', data: { x: 1 } });
    emit('host:status', { state: 'connecting' } satisfies HostStatus);
    const statuses: HostStatus[] = [];
    bridge.onStatus((status) => statuses.push(status));
    expect(seen).toEqual([{ x: 1 }]);
    expect(statuses).toEqual([{ state: 'connecting' }]);
  });

  it('настройки острова приходят событием island:config', async () => {
    const bridge = await loadPreload();
    const configs: IslandConfig[] = [];
    bridge.island.onConfig((config) => configs.push(config));
    emit('island:config', { sound: false, hintShown: true, topInset: 38, anchor: 'right' });
    expect(configs).toEqual([{ sound: false, hintShown: true, topInset: 38, anchor: 'right' }]);
  });

  it('наведение от main приходит событием island:hover', async () => {
    const bridge = await loadPreload();
    const seen: boolean[] = [];
    bridge.island.onHover((hovered) => seen.push(hovered));
    emit('island:hover', true);
    emit('island:hover', false);
    expect(seen).toEqual([true, false]);
  });

  it('каналы острова — island:*', async () => {
    const bridge = await loadPreload();
    bridge.island.setHitRect({ x: 100, y: 0, width: 280, height: 40 });
    bridge.island.setHitRect(null);
    bridge.island.setVisible(true);
    bridge.island.dragEnd({ screenX: 1, screenY: 2 });
    bridge.island.beep();
    expect(send.mock.calls).toEqual([
      ['island:hit-rect', { x: 100, y: 0, width: 280, height: 40 }],
      ['island:hit-rect', null],
      ['island:visible', true],
      ['island:drag-end', { screenX: 1, screenY: 2 }],
      ['island:beep'],
    ]);
    void bridge.island.config();
    expect(invoke).toHaveBeenCalledWith('island:config');
  });

  it('остальные каналы острова и вызовы хоста: каждому члену моста — свой канал', async () => {
    const bridge = await loadPreload();
    bridge.island.dragStart({ screenX: 3, screenY: 4 });
    bridge.island.dragMove({ screenX: 5, screenY: 6 });
    const target = { kind: 'mail', projectPath: '/p', workId: 'w' } as const;
    bridge.island.open(target);
    bridge.island.hintShown();
    bridge.island.failed();
    expect(send.mock.calls).toEqual([
      ['island:drag-start', { screenX: 3, screenY: 4 }],
      ['island:drag-move', { screenX: 5, screenY: 6 }],
      ['island:open', target],
      ['island:hint-shown'],
      ['island:failed'],
    ]);
    void bridge.call('works.list', {});
    expect(invoke).toHaveBeenLastCalledWith('host:call', 'works.list', {});
    void bridge.activitySnapshot();
    expect(invoke).toHaveBeenLastCalledWith('host:activity-snapshot');
  });

  it('мост выставлен под ключом parley, а подписки ipcRenderer.on — ровно четыре канала', async () => {
    await loadPreload();
    expect(exposedKey).toBe('parley');
    expect([...subscribed].sort()).toEqual(['host:event', 'host:status', 'island:config', 'island:hover']);
  });

  it('отписка работает: после неё слушатель событий хоста, статуса, настроек и наведения молчит, соседний — нет', async () => {
    const bridge = await loadPreload();

    const first: unknown[] = [];
    const second: unknown[] = [];
    const offFirst = bridge.on('works.changed', (data) => first.push(data));
    bridge.on('works.changed', (data) => second.push(data));
    emit('host:event', { event: 'works.changed', data: 1 });
    offFirst();
    emit('host:event', { event: 'works.changed', data: 2 });
    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);

    const statuses: HostStatus[] = [];
    const offStatus = bridge.onStatus((status) => statuses.push(status));
    emit('host:status', { state: 'connecting' } satisfies HostStatus);
    offStatus();
    emit('host:status', { state: 'disconnected', reason: 'x' } satisfies HostStatus);
    expect(statuses).toEqual([{ state: 'connecting' }]);

    const configs: IslandConfig[] = [];
    const offConfig = bridge.island.onConfig((config) => configs.push(config));
    emit('island:config', { sound: true, hintShown: false, topInset: 0, anchor: 'center' });
    offConfig();
    emit('island:config', { sound: false, hintShown: true, topInset: 38, anchor: 'left' });
    expect(configs).toEqual([{ sound: true, hintShown: false, topInset: 0, anchor: 'center' }]);

    const hoversOfFirst: boolean[] = [];
    const hoversOfSecond: boolean[] = [];
    const offHover = bridge.island.onHover((hovered) => hoversOfFirst.push(hovered));
    bridge.island.onHover((hovered) => hoversOfSecond.push(hovered));
    emit('island:hover', true);
    offHover();
    emit('island:hover', false);
    expect(hoversOfFirst).toEqual([true]);
    expect(hoversOfSecond).toEqual([true, false]);
  });
});
