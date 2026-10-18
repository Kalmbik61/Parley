/**
 * Список панели Agents (спека 2026-10-07, 5.1): работающие со шагом, свёрнутое Finished, выбор по клику,
 * «Starting…», пустое состояние и сессия без вида Chat.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useFeedStore } from '../chat/store.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AgentsPanel, AgentsPanelView } from './AgentsPanel.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-07T10:00:00.000Z';
const LONG = 'Найти все места, где карточка агента рисуется в ленте, и проверить, что длинные описания не ломают строку';

function agent(over: Partial<FeedAgent>): FeedAgent {
  return { id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore', description: LONG,
    prompt: 'p', model: 'haiku', background: false, status: 'running', toolCount: 0, children: [], ...over };
}
const bash: FeedTool = { id: 'tool:c1', at: AT, kind: 'tool', toolUseId: 'c1', name: 'Bash', input: { command: 'rg FeedAgent packages' }, status: 'running', agentId: 'a1' };

function withFeed(items: FeedItem[]): void {
  useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision: 1, mode: null, decisions: null, status: 'ready' } } });
}

beforeEach(() => resetChatUiStoreForTests());
afterEach(() => { cleanup(); useFeedStore.setState({ feeds: {} }); });

describe('AgentsPanelView', () => {
  it('работающие с текущим шагом; закончившие — свёрнутым блоком Finished (n)', () => {
    withFeed([
      agent({ children: [bash], toolCount: 1 }),
      agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2', status: 'done', durationMs: 4000, description: 'Готовый' }),
    ]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    const running = screen.getAllByTestId('agents-row-running');
    expect(running).toHaveLength(1);
    expect(within(running[0]!).getByText(LONG)).toBeTruthy();
    expect(within(running[0]!).getByText('rg FeedAgent packages')).toBeTruthy();
    expect(screen.queryByText('Готовый')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.finished(1) }));
    expect(screen.getByText('Готовый')).toBeTruthy();
    expect(useChatUiStore.getState().finishedOpen[refKey(REF)]).toBe(true);
  });

  it('клик по строке выбирает агента по id карточки', () => {
    withFeed([agent({})]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    fireEvent.click(screen.getByTestId('agents-row-running'));
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toEqual({ by: 'item', id: 'agent:t1' });
  });

  it('агент без agentId — «Starting…»', () => {
    withFeed([agent({ agentId: null })]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    expect(screen.getByText(S.agentsPanel.starting)).toBeTruthy();
  });

  it('нет агентов — пустое состояние', () => {
    withFeed([]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    expect(screen.getByText(S.agentsPanel.empty)).toBeTruthy();
  });

  it('сессия без ленты — список из метрик без провала и строка про Chat', () => {
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed={false}
      tasks={[{ id: 'a1', agentType: 'Explore', description: LONG, background: true }]} />);
    expect(screen.getByText(LONG)).toBeTruthy();
    expect(screen.getByText(S.agentsPanel.needsChat)).toBeTruthy();
    expect(screen.queryByTestId('agents-row-running')).toBeNull();
  });
});

import { capPlan } from '@parley/core/agent-plan';
import { makeWork, makeSession, makeActivity } from '../test-utils/work-fixtures.js';
import { useActivityStore } from '../store/activity.js';
import { useLayoutStore } from '../layout/store.js';
it('pins the participant label and plan for a session without a feed', () => {
 const entry = makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-01', 'Alice'), makeSession('s-02', 'Bob')] });
 const key = '/tmp/p w-01';
 useLayoutStore.setState({ activeWorkKey: key, layouts: { [key]: { root: { type: 'group', id: 'g', tabs: [{ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }], activeTabId: 'terminal:s-02' }, activeGroupId: 'g', closedTabs: [] } } });
 const plan = capPlan({ items: [{ id: '1', subject: 'Alice plan', status: 'in_progress', description: null, activeForm: null }], explanation: null, partial: false, updatedAt: AT });
 useActivityStore.setState({ byRef: { [refKey(REF)]: { ...makeActivity(REF, 'idle'), metrics: { plan, tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 0, model: null } } } });
 useChatUiStore.getState().pinAgentsSession(key, 's-01');
 render(<AgentsPanel bridge={createFakeBridge()} entry={entry} />);
 expect(screen.getByRole('heading', { name: /Alice/ })).toBeTruthy(); expect(screen.getByText('Alice plan')).toBeTruthy(); expect(screen.getByText('Plan · 0/1')).toBeTruthy();
 act(() => useActivityStore.setState({ byRef: {} }));
});
it('old metrics without plan show a discoverable empty state', () => {
 render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed={false} tasks={[]} />);
 expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
 expect(screen.getByText(S.agentsPanel.noPlan)).toBeTruthy();
});

it('shows Plan above the agent list for a session with a feed', () => {
 const plan = capPlan({ items: [], explanation: 'Feed plan', partial: false, updatedAt: AT });
 render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} plan={plan} />);
 expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
 expect(screen.getByText(S.agentsPanel.noPlan)).toBeTruthy();
 expect(screen.getByText('Feed plan')).toBeTruthy();
});
