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
    sendSync: vi.fn(),
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

it('works sync preload acknowledges only after its consumer completes', async () => {
  const bridge = await loadPreload();
  const { ipcRenderer } = await import('electron');
  vi.mocked(ipcRenderer.send).mockClear();
  let complete!: () => void;
  const handled = new Promise<void>((resolve) => { complete = resolve; });
  const stop = bridge.worksSync.subscribe(() => handled, () => {});
  const stream = vi.mocked(ipcRenderer.send).mock.calls[0]?.[1];
  handlers.get('works-sync:batch')?.({}, stream, 1, { index: 0, records: [] });
  expect(ipcRenderer.send).not.toHaveBeenCalledWith('works-sync:ack', stream, 1);
  complete();
  await vi.waitFor(() => expect(ipcRenderer.send).toHaveBeenCalledWith('works-sync:ack', stream, 1));
  stop();
});

it('works sync consumer failure stays visible and explicit repair resubscribes without acknowledging invalid batches', async () => {
  const bridge = await loadPreload();
  const { ipcRenderer } = await import('electron');
  const send = vi.mocked(ipcRenderer.send);
  send.mockClear();
  const batch = vi.fn().mockRejectedValueOnce(new Error('reducer rejected')).mockResolvedValue(undefined);
  const status = vi.fn();
  bridge.worksSync.subscribe(batch, status);
  const oldStream = send.mock.calls[0]?.[1];
  const payload = { kind: 'works-sync-batch', transaction: { mode: 'reset', epoch: 'a', base: 0, target: 1 }, index: 0, records: [], commit: true };
  handlers.get('works-sync:batch')?.({}, oldStream, 1, payload);
  await vi.waitFor(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ state: 'error', retryable: true })));
  expect(send).not.toHaveBeenCalledWith('works-sync:ack', oldStream, 1);
  handlers.get('works-sync:status')?.({}, oldStream, { state: 'current', epoch: 'a', applied: 1 });
  expect(status).toHaveBeenCalledTimes(1);
  bridge.worksSync.retry();
  const streams = send.mock.calls.filter(([channel]) => channel === 'works-sync:subscribe');
  expect(streams).toHaveLength(2);
  const newStream = streams[1]?.[1];
  expect(newStream).not.toBe(oldStream);
  handlers.get('works-sync:batch')?.({}, oldStream, 2, payload);
  handlers.get('works-sync:batch')?.({}, newStream, 3, payload);
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('works-sync:ack', newStream, 3));
  expect(batch).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalledWith('works-sync:ack', oldStream, 2);
});

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

  it('voice: прогресс скачивания приходит подписчику, отписка снимает его', async () => {
    const bridge = await loadPreload();
    const listener = vi.fn();
    const off = bridge.voice.onProgress(listener);
    emit('voice:progress', { id: 'base', receivedBytes: 1, totalBytes: 2 });
    off();
    emit('voice:progress', { id: 'base', receivedBytes: 2, totalBytes: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ id: 'base', receivedBytes: 1, totalBytes: 2 });
  });

  it('озвучка помощника: состояние — канал app:assistant-voice-state; события приходят подписчикам, отписка снимает их; каналов весов нет', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    void bridge.app.assistantVoiceState();
    expect(vi.mocked(ipcRenderer.invoke).mock.calls.slice(-1)).toEqual([['app:assistant-voice-state']]);
    const app = bridge.app as unknown as Record<string, unknown>;
    for (const name of ['assistantVoices', 'assistantVoiceModels', 'assistantVoiceDownload', 'assistantVoiceCancel', 'assistantVoiceRemove', 'onAssistantVoiceProgress']) {
      expect(app[name], name).toBeUndefined();
    }
    const state = vi.fn();
    const offState = bridge.app.onAssistantVoiceState(state);
    emit('app:assistant-voice-state', { state: 'speaking' });
    offState();
    emit('app:assistant-voice-state', { state: 'ready' });
    expect(state.mock.calls).toEqual([[{ state: 'speaking' }]]);
  });

  it('app.imageThumbnail: путь и необязательная сторона миниатюры уходят в канал app:image-thumbnail, ответ main возвращается как есть', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    vi.mocked(ipcRenderer.invoke).mockResolvedValue('data:image/png;base64,AAAA');
    expect(await bridge.app.imageThumbnail('/h/shot.png', 1600)).toBe('data:image/png;base64,AAAA');
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('app:image-thumbnail', '/h/shot.png', 1600);
    await bridge.app.imageThumbnail('/h/shot.png');
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('app:image-thumbnail', '/h/shot.png', undefined);
  });

  it('islandActive — синхронный вопрос main', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    vi.mocked(ipcRenderer.sendSync).mockReturnValueOnce(true);
    expect(bridge.app.islandActive()).toBe(true);
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('app:island-active');
  });

  it('browser.onDevtools: пачка приходит подписчику, отписка снимает его (спека 2026-10-07, 3.5)', async () => {
    const bridge = await loadPreload();
    const listener = vi.fn();
    const off = bridge.browser.onDevtools(listener);
    const batch = { webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [], network: [] };
    emit('browser:devtools', batch);
    off();
    emit('browser:devtools', batch);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(batch);
  });

  it('browser.onAgentOpenTab: просьба агента приходит подписчику, отписка снимает его; agentOpenTabResult зовёт browser:agent-open-tab-result (этап B2)', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    const listener = vi.fn();
    const off = bridge.browser.onAgentOpenTab(listener);
    const request = { requestId: 'r1', workKey: '/p w-1', url: 'http://localhost:5173/', sessionId: 's-02', session: 'S02', owner: { kind: 'session' as const, sessionId: 's-02' } };
    emit('browser:agent-open-tab', request);
    off();
    emit('browser:agent-open-tab', request);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(request);
    await bridge.browser.agentOpenTabResult('r1', { tabId: 'browser:abc123', reused: false, mounted: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:agent-open-tab-result', 'r1', { tabId: 'browser:abc123', reused: false, mounted: true });
  });

  it('browser.agentCaptureReady зовёт browser:agent-capture-ready с id поверхности снимка', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    await bridge.browser.agentCaptureReady('c-77');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:agent-capture-ready', 'c-77');
  });

  it('browser.agentStop и agentFocusReady зовут browser:agent-stop и browser:agent-focus-ready (этап D)', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    await bridge.browser.agentStop(7);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:agent-stop', 7);
    await bridge.browser.agentFocusReady('f-1', true);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:agent-focus-ready', 'f-1', true);
  });

  it('browser.onAgentResize: событие browser:agent-resize приходит подписчику, отписка снимает его (этап D)', async () => {
    const bridge = await loadPreload();
    const listener = vi.fn();
    const off = bridge.browser.onAgentResize(listener);
    emit('browser:agent-resize', { webContentsId: 7, viewport: null });
    off();
    emit('browser:agent-resize', { webContentsId: 7, viewport: null });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ webContentsId: 7, viewport: null });
  });

  it('browser.registerTab зовёт browser:register-tab; onAgentActivity: событие приходит подписчику, отписка снимает его (этап C)', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    await bridge.browser.registerTab({ kind: 'gone', generation: 'g1', workKey: '/p w-1', pageId: 'bp-aaaaaa' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:register-tab', { kind: 'gone', generation: 'g1', workKey: '/p w-1', pageId: 'bp-aaaaaa' });
    const listener = vi.fn();
    const off = bridge.browser.onAgentActivity(listener);
    emit('browser:agent-activity', { webContentsId: 7, session: 'S02', op: 'tabs', phase: 'start' });
    off();
    emit('browser:agent-activity', { webContentsId: 7, session: 'S02', op: 'tabs', phase: 'end' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
