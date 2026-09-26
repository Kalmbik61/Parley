/**
 * `use-layout-persistence` — тесты 3 и 4 куска 2.2 плана окна: панель мёртвой
 * сессии выброшена при восстановлении, пять изменений раскладки подряд дают
 * одно сохранение. `isPanelValid` (тест 3) проверен отдельно как чистая
 * функция — она же используется хуком при восстановлении.
 *
 * `DockviewApi` подменён фейком в объёме `LayoutApi` — настоящий dockview
 * этому файлу не нужен (ср. `Workspace.test.tsx`, где он настоящий: там
 * проверяется поведение самой сетки, а не связь с хранилищем).
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import type { PanelSpec } from '../../lib/panel-id.js';
import { isPanelValid, useLayoutPersistence, WORKSPACE_LAYOUT_KEY, type LayoutApi, type LayoutPanel } from './use-layout-persistence.js';

function session(id: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label: id,
    task: '',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

const entry: WorkEntry = {
  projectPath: '/tmp/w-01',
  map: {
    schemaVersion: 1,
    work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-01')],
    messages: [],
  },
};

const workKey = '/tmp/w-01 w-01';
const refAlive: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };
const refDead: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-99' };

describe('isPanelValid', () => {
  it('терминал/изменения годны, пока жива сессия', () => {
    expect(isPanelValid([entry], { kind: 'terminal', ref: refAlive, workKey })).toBe(true);
    expect(isPanelValid([entry], { kind: 'changes', ref: refAlive, workKey })).toBe(true);
  });

  it('терминал удалённой сессии выброшен (тест 3)', () => {
    expect(isPanelValid([entry], { kind: 'terminal', ref: refDead, workKey })).toBe(false);
  });

  it('любая панель удалённой работы выброшена', () => {
    expect(isPanelValid([], { kind: 'mail', workKey })).toBe(false);
    expect(isPanelValid([], { kind: 'terminal', ref: refAlive, workKey })).toBe(false);
  });

  it('почта годна, пока жива работа — комнаты пока проверить нечем', () => {
    expect(isPanelValid([entry], { kind: 'mail', workKey })).toBe(true);
    expect(isPanelValid([entry], { kind: 'room', workKey, roomId: 'r-01' })).toBe(true);
  });
});

/** Фейковый `DockviewApi` в объёме `LayoutApi`: панели фиксированы заранее — как если бы `fromJSON` их уже создал. */
function createFakeApi(initialPanels: LayoutPanel[]): LayoutApi & {
  readonly removed: LayoutPanel[];
  readonly fromJSONCalls: unknown[];
  fireChange(): void;
} {
  let panels = [...initialPanels];
  const listeners = new Set<() => void>();
  const removed: LayoutPanel[] = [];
  const fromJSONCalls: unknown[] = [];

  return {
    get panels() {
      return panels;
    },
    toJSON: () => ({ snapshot: true }),
    fromJSON: (data) => {
      fromJSONCalls.push(data);
    },
    onDidLayoutChange: (callback) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    removePanel: (panel) => {
      removed.push(panel);
      panels = panels.filter((candidate) => candidate.id !== panel.id);
    },
    removed,
    fromJSONCalls,
    fireChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

function panel(id: string, spec: PanelSpec): LayoutPanel {
  return { id, api: { getParameters: () => spec } };
}

let bridge: FakeBridge;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useLayoutPersistence', () => {
  it('панель удалённой сессии при восстановлении выброшена (тест 3)', async () => {
    bridge = createFakeBridge();
    await bridge.app.saveLayout(WORKSPACE_LAYOUT_KEY, { grid: {} });
    bridge.layoutSaves.length = 0; // это seed, а не то сохранение, что проверяет тест

    const alivePanel = panel('terminal:alive', { kind: 'terminal', ref: refAlive, workKey });
    const deadPanel = panel('terminal:dead', { kind: 'terminal', ref: refDead, workKey });
    const api = createFakeApi([alivePanel, deadPanel]);

    renderHook(() => useLayoutPersistence({ api, bridge, works: [entry] }));

    await waitFor(() => expect(api.fromJSONCalls).toHaveLength(1));
    await waitFor(() => expect(api.removed).toEqual([deadPanel]));
    expect(api.panels).toEqual([alivePanel]);
  });

  it('пять изменений за 200 мс → одно сохранение (тест 4)', async () => {
    bridge = createFakeBridge();
    const api = createFakeApi([]);

    renderHook(() => useLayoutPersistence({ api, bridge, works: [] }));
    // Нечего восстанавливать — `loadLayout` резолвится в `null` сразу.
    await waitFor(() => expect(bridge.calls.length + bridge.layoutSaves.length).toBeGreaterThanOrEqual(0));

    vi.useFakeTimers();
    for (let i = 0; i < 5; i += 1) {
      api.fireChange();
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(bridge.layoutSaves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(bridge.layoutSaves).toHaveLength(1);
  });
});
