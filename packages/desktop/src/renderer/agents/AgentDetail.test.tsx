import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AgentDetail } from './AgentDetail.js';

vi.mock('../chat/open-agent.js', () => ({ openAgentCard: vi.fn() }));
import { openAgentCard } from '../chat/open-agent.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-07T10:00:00.000Z';
const PROMPT = Array.from({ length: 20 }, (_, n) => `Строка задания ${n + 1}`).join('\n');
function agent(over: Partial<FeedAgent> = {}): FeedAgent {
  return { id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore', description: 'Найти вызовы',
    prompt: PROMPT, model: 'haiku', background: false, status: 'running', toolCount: 1, children: [], ...over };
}
const call: FeedTool = { id: 'tool:c1', at: AT, kind: 'tool', toolUseId: 'c1', name: 'Bash', input: { command: 'rg FeedAgent' }, status: 'done', agentId: 'a1' };

afterEach(cleanup);

describe('AgentDetail', () => {
  it('шапка, задание свёрнуто до Show all, вызовы, итога у работающего нет', () => {
    render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [call] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.getByText('Найти вызовы')).toBeTruthy();
    expect(screen.queryByText('Строка задания 20')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.showAll }));
    expect(screen.getByText(/Строка задания 20/)).toBeTruthy();
    expect(screen.getByText('rg FeedAgent')).toBeTruthy();
    expect(screen.queryByText(S.agentsPanel.result)).toBeNull();
  });

  it('этапы из TodoWrite показываются, без них раздела нет', () => {
    const todo: FeedTool = { ...call, id: 'tool:c2', toolUseId: 'c2', name: 'TodoWrite', input: { todos: [{ content: 'Шаг один', status: 'in_progress' }] } };
    const { rerender } = render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [todo] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.steps)).toBeTruthy();
    expect(screen.getByText('Шаг один')).toBeTruthy();
    rerender(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [call] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.queryByText(S.agentsPanel.steps)).toBeNull();
  });

  it('агент закончил при открытом экране — итог появился, экран остался (Review Focus 4)', () => {
    const { rerender } = render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent()]} pick={{ by: 'agent', id: 'a1' }} onBack={() => undefined} />);
    rerender(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ status: 'done', result: 'Нашёл 3 места', durationMs: 9000 })]} pick={{ by: 'agent', id: 'a1' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.result)).toBeTruthy();
    expect(screen.getByText('Нашёл 3 места')).toBeTruthy();
    expect(screen.getByRole('button', { name: S.agentsPanel.back })).toBeTruthy();
  });

  it('Full transcript грузит ленту агента; Show in chat ведёт к карточке; назад — onBack', () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: [] as FeedItem[], revision: 0, schemaVersion: 2, mode: null }));
    const onBack = vi.fn();
    render(<AgentDetail bridge={bridge} sessionRef={REF} items={[agent()]} pick={{ by: 'item', id: 'agent:t1' }} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.fullTranscript }));
    expect(bridge.calls).toContainEqual({ method: 'feed.snapshot', params: { ref: REF, agentId: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.showInChat }));
    expect(openAgentCard).toHaveBeenCalledWith(REF, 'a1');
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.back }));
    expect(onBack).toHaveBeenCalled();
  });

  it('агента больше нет в ленте — строка gone и кнопка назад', () => {
    render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[]} pick={{ by: 'item', id: 'agent:zz' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.gone)).toBeTruthy();
  });
});
