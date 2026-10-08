// Входы в панель Agents: тулбар и строка поповера (спека 2026-10-07, 5.1).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey, type SessionRef } from '@parley/protocol';

const room = vi.hoisted(() => ({ value: true }));
vi.mock('../shell/RightSidebar.js', () => ({ rightSidebarHasRoom: () => room.value }));
vi.mock('../attention/focus-target.js', () => ({ applyFocusTarget: vi.fn(() => true), buildFocusTargetDeps: vi.fn(() => ({})) }));
vi.mock('../chat/open-agent.js', () => ({ openAgentCard: vi.fn() }));

import { openAgentCard } from '../chat/open-agent.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { useUiStore } from '../store/ui.js';
import { openAgentInPanel, openAgentsPanel } from './open-agents.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

beforeEach(() => {
  resetChatUiStoreForTests();
  vi.mocked(openAgentCard).mockClear();
  room.value = true;
});

describe('openAgentsPanel', () => {
  it('есть место — вкладка Agents и список (выбор сброшен)', () => {
    useChatUiStore.getState().selectAgent(refKey(REF), { by: 'agent', id: 'old' });
    openAgentsPanel(refKey(REF), 'a1');
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'agents' });
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toBeNull();
  });

  it('нет места — просьба показать первую карточку, сайдбар не трогается', () => {
    room.value = false;
    openAgentsPanel(refKey(REF), 'a1');
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: refKey(REF), agentId: 'a1' });
  });
});

describe('openAgentInPanel', () => {
  it('есть место — экран этого агента во вкладке Agents', () => {
    openAgentInPanel(REF, 'a7');
    expect(useUiStore.getState().ui.rightSidebar.tab).toBe('agents');
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toEqual({ by: 'agent', id: 'a7' });
    expect(openAgentCard).not.toHaveBeenCalled();
  });

  it('нет места — прежний переход к карточке', () => {
    room.value = false;
    openAgentInPanel(REF, 'a7');
    expect(openAgentCard).toHaveBeenCalledWith(REF, 'a7');
  });
});
