/**
 * Список панели Agents (спека 2026-10-07, 5.1): работающие со шагом, свёрнутое Finished, выбор по клику,
 * «Starting…», пустое состояние и сессия без вида Chat.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useFeedStore } from '../chat/store.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AgentsPanelView } from './AgentsPanel.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-07T10:00:00.000Z';
const LONG = 'Найти все места, где карточка агента рисуется в ленте, и проверить, что длинные описания не ломают строку';

function agent(over: Partial<FeedAgent>): FeedAgent {
  return { id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore', description: LONG,
    prompt: 'p', model: 'haiku', background: false, status: 'running', toolCount: 0, children: [], ...over };
}
const bash: FeedTool = { id: 'tool:c1', at: AT, kind: 'tool', toolUseId: 'c1', name: 'Bash', input: { command: 'rg FeedAgent packages' }, status: 'running', agentId: 'a1' };

function withFeed(items: FeedItem[]): void {
  useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision: 1, mode: null, status: 'ready' } } });
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
