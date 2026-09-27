/**
 * `Workspace` — тесты 2, 3, 5а куска 2.1 плана окна: открыть уже открытую
 * сессию не плодит вторую панель и фокусирует её; ⌘W закрывает активную
 * панель без остановки сессии; переключение вкладок отцепляет ушедшую и
 * цепляет пришедшую (видимость — источник `pty.attach`/`pty.detach`, а не
 * монтирование React).
 *
 * xterm подменён фейком, как в `TerminalPanel.test.tsx`/`use-terminal.test.ts`
 * — реальный xterm рисует в канву, которой в jsdom нет.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { useUiStore } from '../../store/ui.js';
import { Workspace, type WorkspaceHandle } from './Workspace.js';

const state = vi.hoisted(() => ({ terminals: [] as unknown[] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => {
    const instance = {};
    state.terminals.push(instance);
    return {
      cols: 80,
      rows: 24,
      // `use-terminal.ts` меняет тему на лету через `options.theme` — без
      // этого объекта присвоение упало бы (`Cannot set properties of undefined`).
      options: { ...initialOptions },
      open: () => {},
      loadAddon: () => {},
      write: () => {},
      reset: () => {},
      dispose: () => {},
      resize: () => {},
      onData: () => ({ dispose: () => {} }),
      attachCustomKeyEventHandler: () => {},
      hasSelection: () => false,
      getSelection: () => '',
    };
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn().mockImplementation(() => ({ findNext: () => true })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

/** jsdom не знает `ResizeObserver` — и наш `use-terminal.ts`, и dockview сами его заводят. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
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
    schemaVersion: 2,
    rooms: [],
    work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-01', 'план'), session('s-02', 'бэкенд')],
    messages: [],
  },
};

const workKey = '/tmp/w-01 w-01';
const refA: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };
const refB: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-02' };

let bridge: FakeBridge;

beforeEach(() => {
  state.terminals = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  useUiStore.setState({
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
    lastSessionByWork: {},
    activePanelId: null,
    visibleSessionRefs: {},
    recentSessionRefs: [],
    picker: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWorkspace(): { current: WorkspaceHandle | null } {
  const handle: { current: WorkspaceHandle | null } = { current: null };
  render(<Workspace ref={handle} bridge={bridge} works={[entry]} fontFamily="Menlo" fontSize={13} />);
  return handle;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Workspace.openSession', () => {
  it('второе открытие той же сессии не плодит вторую панель (тест 2)', async () => {
    const ws = renderWorkspace();
    act(() => ws.current?.openSession(refA, workKey, 'S01 план'));
    await flush();
    act(() => ws.current?.openSession(refA, workKey, 'S01 план'));
    await flush();

    expect(state.terminals).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.method === 'pty.attach')).toHaveLength(1);
  });

  it('переключение на вторую сессию отцепляет первую и цепляет вторую; обратно — наоборот (тест 5а)', async () => {
    const ws = renderWorkspace();

    act(() => ws.current?.openSession(refA, workKey, 'S01'));
    await flush();
    expect(useUiStore.getState().visibleSessionRefs[refKey(refA)]).toBe(true);
    expect(bridge.calls.filter((call) => call.method === 'pty.attach')).toHaveLength(1);

    act(() => ws.current?.openSession(refB, workKey, 'S02'));
    await flush();

    // Ушедшая (A) невидима и отцеплена, пришедшая (B) видна и подключена —
    // тест 5а: «сессия невидимой вкладки не отмечается просмотренной» опирается
    // именно на то, что A здесь больше не в `visibleSessionRefs`.
    expect(useUiStore.getState().visibleSessionRefs[refKey(refA)]).toBeUndefined();
    expect(useUiStore.getState().visibleSessionRefs[refKey(refB)]).toBe(true);
    expect(bridge.calls.filter((call) => call.method === 'pty.detach' && sameRef(call.params, refA))).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.method === 'pty.attach' && sameRef(call.params, refB))).toHaveLength(1);

    act(() => ws.current?.openSession(refA, workKey, 'S01'));
    await flush();

    expect(useUiStore.getState().visibleSessionRefs[refKey(refA)]).toBe(true);
    expect(useUiStore.getState().visibleSessionRefs[refKey(refB)]).toBeUndefined();
    // Та же панель, не новая: подключение A — второе (снова видна), а не третье.
    expect(bridge.calls.filter((call) => call.method === 'pty.attach' && sameRef(call.params, refA))).toHaveLength(2);
    expect(bridge.calls.filter((call) => call.method === 'pty.detach' && sameRef(call.params, refB))).toHaveLength(1);
    expect(state.terminals).toHaveLength(2);
  });
});

describe('Workspace — split-right (кусок 2.3, тест 10)', () => {
  it('зовёт store/ui.ts#openPicker с работой активной панели и id сессий её открытых терминалов', async () => {
    const ws = renderWorkspace();
    act(() => ws.current?.openSession(refA, workKey, 'S01'));
    await flush();

    act(() => bridge.emitMenu('split-right'));
    await flush();

    expect(useUiStore.getState().picker).toEqual({ workKey, direction: 'right', openSessionIds: ['s-01'] });
  });

  it('openBeside открывает вторую сессию рядом с активной панелью', async () => {
    const ws = renderWorkspace();
    act(() => ws.current?.openSession(refA, workKey, 'S01'));
    await flush();

    act(() => ws.current?.openBeside(refB, workKey, 'S02', 'right'));
    await flush();

    expect(state.terminals).toHaveLength(2);
    expect(bridge.calls.filter((call) => call.method === 'pty.attach' && sameRef(call.params, refB))).toHaveLength(1);
  });
});

describe('Workspace — ⌘W', () => {
  it('закрывает активную панель: pty.detach вызван, sessions.stop — нет (тест 3)', async () => {
    const ws = renderWorkspace();
    act(() => ws.current?.openSession(refA, workKey, 'S01'));
    await flush();

    act(() => bridge.emitMenu('close-panel'));
    await flush();

    expect(bridge.calls.filter((call) => call.method === 'pty.detach')).toEqual([
      { method: 'pty.detach', params: { ref: refA } },
    ]);
    expect(bridge.calls.some((call) => call.method === 'sessions.stop')).toBe(false);
  });
});

function sameRef(params: unknown, ref: SessionRef): boolean {
  const candidate = params as { ref?: SessionRef } | undefined;
  return (
    candidate?.ref?.projectPath === ref.projectPath &&
    candidate.ref.workId === ref.workId &&
    candidate.ref.sessionId === ref.sessionId
  );
}
