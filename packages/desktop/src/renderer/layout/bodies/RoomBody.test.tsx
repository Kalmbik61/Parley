/**
 * Тело вкладки комнаты (кусок 4b плана 2026-10-01): клик по карточке участника открывает его терминал обычным переходом
 * окна, а клик по агенту в поповере строки субагентов — вкладку сессии в виде «Chat» с просьбой прокрутить ленту к
 * карточке этого агента.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import { refKey, type LiveTask } from '@parley/protocol';
import type { TabSpec, WorkLayout } from '../../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../history.js';
import { useLayoutStore } from '../store.js';
import { groups } from '../tree.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../../chat/ui-store.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { RoomBody } from './RoomBody.js';

vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: vi.fn() }));

const PROJECT = '/tmp/proj';
const KEY = `${PROJECT} w-01`;
const REF = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-01', sessionId });

const entry: WorkEntry = makeWork('w-01', {
  projectPath: PROJECT,
  title: 'Payments',
  sessions: [makeSession('s-01', 'architect'), makeSession('s-02', 'backend')],
  rooms: [{ ...makeRoom('r-01', 'Refunds'), members: ['s-01', 's-02'], lead: 's-01' }],
});

const task = (id: string, extra: Partial<LiveTask> = {}): LiveTask => ({ id, agentType: 'Explore', description: `Task ${id}`, background: true, ...extra });

function setLayout(tabs: TabSpec[]): void {
  const layout: WorkLayout = { root: { type: 'group', id: 'g1', tabs, activeTabId: tabs[0]?.id ?? null }, activeGroupId: 'g1', closedTabs: [] };
  useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: layout }, hydrated: { [KEY]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
}
const tabOf = (id: string): TabSpec | undefined =>
  groups(useLayoutStore.getState().layouts[KEY]!).flatMap((group) => group.tabs).find((tab) => tab.id === id);

beforeEach(() => {
  // Ожидание показа вкладки опрашивает DOM до двух секунд — в тесте оно не нужно.
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(toast).mockClear();
  resetChatUiStoreForTests();
  useUiStore.setState({ composerDrafts: {}, windowFocused: true, documentVisible: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
  useWorksStore.setState({ entries: [entry], branches: {}, loading: false, error: null });
  useActivityStore.setState({
    byRef: activityMap([
      makeActivity(REF('s-01'), 'working', {
        metrics: { tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 2, model: null, tasks: [task('agent-1'), task('agent-2', { agentType: 'Plan' })] },
      }),
    ]),
    loaded: true,
  });
  setLayout([{ kind: 'room', id: 'room:r-01', roomId: 'r-01' }]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetChatUiStoreForTests();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  useActivityStore.setState({ byRef: {}, loaded: false });
  useWorksStore.setState(useWorksStore.getInitialState(), true);
});

const renderBody = () => render(<RoomBody bridge={createFakeBridge()} entry={entry} roomId="r-01" active />);
const participant = (id: string): HTMLElement => document.querySelector(`[data-participant="${id}"]`) as HTMLElement;

describe('RoomBody — переход из ленты участников', () => {
  it('клик по карточке участника — вкладка его сессии, вид не навязывается, просьбы про карточку нет', () => {
    renderBody();
    fireEvent.click(within(participant('s-02')).getByRole('button'));
    expect(tabOf('terminal:s-02')).toEqual({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' });
    expect(useChatUiStore.getState().reveal).toBeNull();
  });

  it('клик по агенту в поповере строки субагентов — вкладка сессии участника в виде Chat и просьба прокрутить к карточке агента', () => {
    renderBody();
    fireEvent.click(within(participant('s-01')).getByTestId('agents-badge'));
    const rows = screen.getAllByTestId('agents-popover-row');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Open Explore', 'Open Plan']);
    // Поповер сам сессию не открывает.
    expect(tabOf('terminal:s-01')).toBeUndefined();
    fireEvent.click(rows[1]!);
    expect(tabOf('terminal:s-01')).toEqual({ kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01', view: 'chat' });
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: refKey(REF('s-01')), agentId: 'agent-2' });
    expect(toast).not.toHaveBeenCalled();
  });

  it('участника уже нет в карте работы — тост «цели нет», вкладка не открывается', () => {
    const gone: WorkEntry = makeWork('w-01', { projectPath: PROJECT, sessions: [makeSession('s-02', 'backend')], rooms: entry.map.rooms });
    useWorksStore.setState({ entries: [gone] });
    renderBody();
    fireEvent.click(within(participant('s-01')).getByTestId('agents-badge'));
    fireEvent.click(screen.getAllByTestId('agents-popover-row')[0]!);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(tabOf('terminal:s-01')).toBeUndefined();
    expect(useChatUiStore.getState().reveal).toBeNull();
  });
});
