/**
 * Меню строки комнаты: «Rename» и «Delete…» с флажком «Also delete its N sessions» (снят по умолчанию). С флажком окно
 * удаляет сессии комнаты путём строки сессии — вкладки файлов их worktree с вопросом, затем `sessions.delete` каждой, —
 * и только потом комнату.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { Room, WorkEntry } from '@parley/core';
import { encodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { RoomRowMenu } from './RoomRowMenu.js';
import { cardRows, type CardRoomRow } from './sort.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const KEY = '/tmp/proj w-01';
let bridge: FakeBridge;

const work = (room: Partial<Room> = {}): WorkEntry =>
  makeWork('w-01', {
    projectPath: '/tmp/proj',
    sessions: [makeSession('s-01', 'lead'), makeSession('s-02', 'build'), makeSession('s-03', 'solo')],
    rooms: [{ ...makeRoom('r-01', 'Refunds'), members: ['s-01', 's-02'], lead: 's-01', ...room }],
  });

function rowOf(entry: WorkEntry): CardRoomRow {
  const row = cardRows(entry.map, false).find((candidate): candidate is CardRoomRow => candidate.kind === 'room');
  if (row === undefined) throw new Error('строки комнаты нет');
  return row;
}

function renderMenu(entry = work(), onRename = vi.fn()): { onRename: ReturnType<typeof vi.fn> } {
  render(
    <RoomRowMenu workKey={KEY} projectPath="/tmp/proj" workId="w-01" row={rowOf(entry)} bridge={bridge} onRename={onRename}>
      <div>room row</div>
    </RoomRowMenu>,
  );
  fireEvent.contextMenu(screen.getByText('room row'));
  return { onRename };
}

const hostWith = (methods: string[]): void => {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods } });
};
const methods = (): string[] => bridge.calls.map((call) => call.method);
const confirmDelete = (): void => {
  fireEvent.click(screen.getByText('Delete…'));
  // Первая по DOM — кнопка подтверждения (крестик диалога — после неё).
  fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
};

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('sessions.delete', () => ({ ok: true as const }));
  bridge.setHandler('rooms.delete', () => ({ ok: true as const }));
  hostWith(['rooms.rename', 'rooms.delete', 'sessions.delete']);
  useUiStore.setState({ sidebarHolds: {} });
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' } });
  useLayoutStore.getState().setCloseGuard(null);
});

describe('RoomRowMenu — пункты', () => {
  it('Rename — колбэк строки; открытое меню держит порядок сайдбара', () => {
    const { onRename } = renderMenu();
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(bridge.calls).toEqual([]);
  });

  it('хост без rooms.rename — только Delete…; без обоих методов меню комнаты нет вовсе', () => {
    hostWith(['rooms.delete']);
    renderMenu();
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.getByText('Delete…')).toBeTruthy();
    cleanup();

    hostWith([]);
    renderMenu();
    expect(screen.queryByText('Delete…')).toBeNull();
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(0);
  });
});

describe('RoomRowMenu — Delete…', () => {
  it('подтверждение с флажком на две сессии комнаты, снятым; Delete — только rooms.delete, сессии остаются', async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    expect(screen.getByText('Delete room "Refunds"?')).toBeTruthy();
    expect(screen.getByText('The room and its feed will be deleted. Its sessions keep running as regular sessions of the workspace.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Also delete its 2 sessions' }).getAttribute('aria-checked')).toBe('false');
    expect(bridge.calls).toEqual([]);

    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await waitFor(() => expect(methods()).toEqual(['rooms.delete']));
    expect(bridge.calls[0]?.params).toEqual({ projectPath: '/tmp/proj', workId: 'w-01', roomId: 'r-01' });
  });

  it('флажок: sessions.delete каждой сессии комнаты по очереди, затем rooms.delete; сессия вне комнаты не тронута', async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete its 2 sessions' }));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);

    await waitFor(() => expect(methods()).toEqual(['sessions.delete', 'sessions.delete', 'rooms.delete']));
    expect(bridge.calls.slice(0, 2).map((call) => call.params)).toEqual([
      { ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' } },
      { ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-02' } },
    ]);
  });

  it('флажок снят при каждом новом открытии подтверждения', () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(bridge.calls).toEqual([]);

    fireEvent.contextMenu(screen.getByText('room row'));
    fireEvent.click(screen.getByText('Delete…'));
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('отказ sessions.delete (грязный worktree) — комната остаётся: rooms.delete нет, тост', async () => {
    bridge.setHandler('sessions.delete', () => {
      throw encodeIpcError({ code: 'conflict', message: 'worktree has uncommitted changes' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't delete room: conflicting state."));
    expect(methods()).toEqual(['sessions.delete']);
    warn.mockRestore();
  });

  it('вкладки файлов worktree её сессий — вопрос о правках; Cancel — ни одного вызова', async () => {
    const wt = { kind: 'worktree', sessionId: 's-02' } as const;
    const own: TabSpec = { kind: 'file', id: tabId.file(wt, 'a.ts'), root: wt, path: 'a.ts' };
    const solo: TabSpec = { kind: 'file', id: tabId.file({ kind: 'worktree', sessionId: 's-03' }, 'a.ts'), root: { kind: 'worktree', sessionId: 's-03' }, path: 'a.ts' };
    useLayoutStore.setState({
      activeWorkKey: KEY,
      layouts: { [KEY]: { root: { type: 'group', id: 'g1', tabs: [own, solo], activeTabId: own.id }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [KEY]: true },
    });
    const guard = vi.fn(async () => false);
    useLayoutStore.getState().setCloseGuard(guard);

    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await act(async () => {
      await Promise.resolve();
    });

    expect(guard).toHaveBeenCalledWith(KEY, [own.id]);
    expect(bridge.calls).toEqual([]);
  });

  it('без флажка вопроса о вкладках нет: сессии и их worktree остаются', async () => {
    const wt = { kind: 'worktree', sessionId: 's-02' } as const;
    const own: TabSpec = { kind: 'file', id: tabId.file(wt, 'a.ts'), root: wt, path: 'a.ts' };
    useLayoutStore.setState({
      activeWorkKey: KEY,
      layouts: { [KEY]: { root: { type: 'group', id: 'g1', tabs: [own], activeTabId: own.id }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [KEY]: true },
    });
    const guard = vi.fn(async () => false);
    useLayoutStore.getState().setCloseGuard(guard);

    renderMenu();
    confirmDelete();
    await waitFor(() => expect(methods()).toEqual(['rooms.delete']));
    expect(guard).not.toHaveBeenCalled();
  });

  it('в комнате не осталось сессий — флажка нет', () => {
    renderMenu(work({ members: ['s-08', 's-09'] }));
    fireEvent.click(screen.getByText('Delete…'));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
