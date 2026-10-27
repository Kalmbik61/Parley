/**
 * Мост preload острова (спека 2026-10-12, 5.2): набор ключей узкий, события и статус хоста раскладываются по
 * подписчикам, свои каналы — `island:*`. Электрон подменён так же, как в `index.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../shared/bridge.js';
import { ISLAND_TTS_PORT, type IslandBridge, type IslandConfig } from '../shared/island.js';

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

/** Настройки острова (план 3b, B12/B15): звук и движение вместо прежнего `sound`. */
const config = (patch: Partial<IslandConfig> = {}): IslandConfig => ({
  islandEnabled: true,
  assistant: {
    enabled: false, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null },
    speech: { enabled: false, voice: 'qwen3-0.6b/serena', gender: 'female', available: false },
  },
  islandSound: { needs: true, finished: false, palette: 'soft', volume: 0.6, ui: false },
  motion: 'system',
  topInset: 38,
  anchor: 'center',
  ...patch,
});

describe('preload острова', () => {
  beforeEach(() => {
    send.mockClear();
    invoke.mockClear();
  });

  it('в мосте только узкий набор: ни app, ни files, ни browser, ни voice, ни notify', async () => {
    const bridge = await loadPreload();
    expect(Object.keys(bridge).sort()).toEqual(['activitySnapshot', 'call', 'island', 'on', 'onStatus']);
    expect(Object.keys(bridge.island).sort()).toEqual(
      [
        'config', 'dragEnd', 'dragMove', 'dragStart', 'failed', 'keyboard', 'markSeen', 'onKeyboardBlur', 'onAssistantOpen', 'onConfig',
        'onHover', 'onNavigatePending', 'onVisibility', 'visibility', 'open', 'setHitRect', 'setVisible', 'speech', 'voice',
      ].sort(),
    );
    expect(Object.keys(bridge.island.speech).sort()).toEqual(['cancel', 'connect', 'setSpeak', 'speak', 'warmup']);
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
    emit('island:config', config({ anchor: 'right', motion: 'reduce' }));
    expect(configs).toEqual([config({ anchor: 'right', motion: 'reduce' })]);
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
    expect(send.mock.calls).toEqual([
      ['island:hit-rect', { x: 100, y: 0, width: 280, height: 40 }],
      ['island:hit-rect', null],
      ['island:visible', true],
      ['island:drag-end', { screenX: 1, screenY: 2 }],
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
    const refs = [{ projectPath: '/p', workId: 'w-1', sessionId: 's-01' }];
    bridge.island.markSeen(refs);
    bridge.island.failed();
    expect(send.mock.calls).toEqual([
      ['island:drag-start', { screenX: 3, screenY: 4 }],
      ['island:drag-move', { screenX: 5, screenY: 6 }],
      ['island:open', target],
      ['island:mark-seen', refs],
      ['island:failed'],
    ]);
    void bridge.call('works.list', {});
    expect(invoke).toHaveBeenLastCalledWith('host:call', 'works.list', {});
    void bridge.activitySnapshot();
    expect(invoke).toHaveBeenLastCalledWith('host:activity-snapshot');
  });

  it('мост выставлен под ключом parley, а подписки ipcRenderer.on — ровно эти каналы', async () => {
    await loadPreload();
    expect(exposedKey).toBe('parley');
    expect([...subscribed].sort()).toEqual([
      'host:event', 'host:status', 'island:assistant-open', 'island:config', 'island:hover', 'island:keyboard-blur', 'island:navigate-pending',
      'island:session-visibility', 'island:tts-port',
    ]);
  });

  it('нейроголос: каналы island:tts-* и island:assistant-speak; отмена без id — null (вся очередь)', async () => {
    const bridge = await loadPreload();
    bridge.island.speech.connect();
    bridge.island.speech.cancel('u-1');
    bridge.island.speech.cancel();
    expect(send.mock.calls).toEqual([['island:tts-connect'], ['island:tts-cancel', 'u-1'], ['island:tts-cancel', null]]);
    const request = { utteranceId: 'u-1', text: 'Hello.', voice: 'qwen3-0.6b/serena', language: 'en' } as const;
    void bridge.island.speech.speak(request);
    expect(invoke).toHaveBeenLastCalledWith('island:tts-speak', request);
    void bridge.island.speech.warmup();
    expect(invoke).toHaveBeenLastCalledWith('island:tts-warmup');
    void bridge.island.speech.setSpeak(true);
    expect(invoke).toHaveBeenLastCalledWith('island:assistant-speak', true);
  });

  it('порт голоса от main уходит в главный мир сообщением окна с передачей порта', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('window', { postMessage });
    try {
      await loadPreload();
      const port = { name: 'port2' };
      handlers.get('island:tts-port')!({ ports: [port] });
      expect(postMessage).toHaveBeenCalledWith(ISLAND_TTS_PORT, '*', [port]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('session visibility has an island-only snapshot getter and removable event listener', async () => {
    const bridge = await loadPreload();
    const snapshot = { version: 3, refs: [{ projectPath: '/p', workId: 'w-1', sessionId: 's-01' }] };
    invoke.mockResolvedValueOnce(snapshot);
    const listener = vi.fn();
    const off = bridge.island.onVisibility(listener);
    expect(await bridge.island.visibility()).toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('island:session-visibility');
    emit('island:session-visibility', snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    off();
    emit('island:session-visibility', { version: 4, refs: [] });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('generic keyboard blur приходит request/assistant слушателям и снимается dispose', async () => {
    const bridge = await loadPreload();
    expect(bridge.island).toHaveProperty('onKeyboardBlur', expect.any(Function));
    const listener = vi.fn();
    const off = bridge.island.onKeyboardBlur(listener);
    emit('island:keyboard-blur');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    emit('island:keyboard-blur');
    expect(listener).toHaveBeenCalledTimes(1);
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
    emit('island:config', config({ topInset: 0 }));
    offConfig();
    emit('island:config', config({ anchor: 'left' }));
    expect(configs).toEqual([config({ topInset: 0 })]);

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
