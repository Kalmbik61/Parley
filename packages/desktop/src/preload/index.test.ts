/**
 * Мост preload (0.1.1): статус хоста и тема, пришедшие до подписки страницы, не теряются.
 *
 * main шлёт `host:status` и `app:appearance` на `did-finish-load`, а страница подписывается в
 * эффекте React — уже после первой отрисовки. В 0.1.0 пришедшее раньше подписки уходило в пустой
 * набор слушателей, и окно навсегда оставалось на «Connecting to host…» (медленный старт сборки
 * для Intel под Rosetta). Электрон подменён: тест держит обработчики `ipcRenderer.on` и сам мост.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus, ParleyBridge } from '../shared/bridge.js';

type Handler = (event: unknown, ...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
let exposed: ParleyBridge | null = null;

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
    send: vi.fn(),
    invoke: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      exposed = api as ParleyBridge;
    },
  },
  webUtils: { getPathForFile: vi.fn() },
}));

/** Свежий модуль preload на каждый тест: его состояние — на уровне модуля. */
async function loadPreload(): Promise<ParleyBridge> {
  handlers.clear();
  exposed = null;
  vi.resetModules();
  await import('./index.js');
  if (exposed === null) throw new Error('preload не выставил мост');
  return exposed;
}

function emit(channel: string, ...args: unknown[]): void {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`нет обработчика ${channel}`);
  handler({}, ...args);
}

const CONNECTED: HostStatus = { state: 'connected', hostVersion: '0.1.1', methods: null };

describe('preload: последний статус и тема', () => {
  let bridge: ParleyBridge;

  beforeEach(async () => {
    bridge = await loadPreload();
  });

  it('статус, пришедший до подписки, отдаётся подписчику сразу', () => {
    emit('host:status', CONNECTED);
    const seen: HostStatus[] = [];
    bridge.onStatus((status) => seen.push(status));
    expect(seen).toEqual([CONNECTED]);
  });

  it('без статуса подписчик ничего не получает, пока статус не придёт', () => {
    const seen: HostStatus[] = [];
    bridge.onStatus((status) => seen.push(status));
    expect(seen).toEqual([]);
    emit('host:status', CONNECTED);
    expect(seen).toEqual([CONNECTED]);
  });

  it('подписчику отдаётся именно последний статус, дальше статусы идут как прежде', () => {
    emit('host:status', { state: 'connecting' });
    emit('host:status', CONNECTED);
    const seen: HostStatus[] = [];
    const unsubscribe = bridge.onStatus((status) => seen.push(status));
    emit('host:status', { state: 'disconnected', reason: 'host exited' });
    unsubscribe();
    emit('host:status', CONNECTED);
    expect(seen).toEqual([CONNECTED, { state: 'disconnected', reason: 'host exited' }]);
  });

  it('тема, пришедшая до подписки, тоже не теряется', () => {
    emit('app:appearance', true);
    const seen: boolean[] = [];
    bridge.app.onAppearance((dark) => seen.push(dark));
    emit('app:appearance', false);
    expect(seen).toEqual([true, false]);
  });
});
