import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('миниатюра картинки в транскрипте агента открывает просмотр (в панели свой диалог просмотра)', async () => {
    const SHOT = '/h/feed-images/shot.png';
    const SMALL = 'data:image/png;base64,SMALL';
    const BIG = 'data:image/png;base64,BIG';
    const bridge = createFakeBridge();
    bridge.setThumbnail(SHOT, SMALL);
    bridge.setThumbnail(SHOT, BIG, 1600);
    // Вызовы агента в карточке картинок не несут (редьюсер их там срезает); они есть в транскрипте агента — его «Full transcript».
    const screenshot: FeedTool = {
      ...call,
      id: 'tool:shot',
      toolUseId: 'shot',
      name: 'mcp__chrome-devtools__take_screenshot',
      input: {},
      response: { text: '[image png, 1 KB]', size: 18, truncated: false, images: [{ path: SHOT, mime: 'image/png' }] },
    };
    bridge.setHandler('feed.snapshot', () => ({ items: [screenshot] as FeedItem[], revision: 0, schemaVersion: 2, mode: null }));
    render(<AgentDetail bridge={bridge} sessionRef={REF} items={[agent()]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.fullTranscript }));
    const thumbnail = await screen.findByRole('button', { name: 'Image 1 of 1' });
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe(SMALL);

    fireEvent.click(thumbnail);
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 1' });
    await waitFor(() => expect(within(dialog).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG));
    expect(bridge.thumbnailRequests).toContainEqual({ path: SHOT, maxPx: 1600 });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(thumbnail);
  });

  it('агента больше нет в ленте — строка gone и кнопка назад', () => {
    render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[]} pick={{ by: 'item', id: 'agent:zz' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.gone)).toBeTruthy();
  });
});
