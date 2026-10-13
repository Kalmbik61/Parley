/**
 * Мост preload острова (спека 2026-10-12, 5.2): набор ключей узкий, события и статус хоста раскладываются по
 * подписчикам, свои каналы — `island:*`. Электрон подменён так же, как в `index.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../shared/bridge.js';
import type { IslandBridge, IslandConfig } from '../shared/island.js';

type Handler = (event: unknown, ...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
let exposed: IslandBridge | null = null;
const send = vi.fn();
const invoke = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
    send,
    invoke,
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      exposed = api as IslandBridge;
    },
  },
}));

/** Свежий модуль preload на каждый тест: его состояние — на уровне модуля. */
async function loadPreload(): Promise<IslandBridge> {
  handlers.clear();
  exposed = null;
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
      ['beep', 'config', 'dragEnd', 'dragMove', 'dragStart', 'hintShown', 'onConfig', 'open', 'setSize', 'setVisible'].sort(),
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
    emit('island:config', { sound: false, hintShown: true, topInset: 38 });
    expect(configs).toEqual([{ sound: false, hintShown: true, topInset: 38 }]);
  });

  it('каналы острова — island:*', async () => {
    const bridge = await loadPreload();
    bridge.island.setSize(380, 150);
    bridge.island.setVisible(true);
    bridge.island.dragEnd({ screenX: 1, screenY: 2 });
    bridge.island.beep();
    expect(send.mock.calls).toEqual([
      ['island:size', 380, 150],
      ['island:visible', true],
      ['island:drag-end', { screenX: 1, screenY: 2 }],
      ['island:beep'],
    ]);
    void bridge.island.config();
    expect(invoke).toHaveBeenCalledWith('island:config');
  });
});
