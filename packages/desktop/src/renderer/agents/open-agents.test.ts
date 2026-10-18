// Входы в панель Agents: тулбар и строка поповера (спека 2026-10-07, 5.1).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey, type SessionRef } from '@parley/protocol';

const room = vi.hoisted(() => ({ value: true, real: false }));
vi.mock('../shell/RightSidebar.js', async (importOriginal) => { const actual = await importOriginal<typeof import('../shell/RightSidebar.js')>(); return { ...actual, rightSidebarHasRoom: () => room.real ? actual.rightSidebarHasRoom() : room.value }; });
vi.mock('../attention/focus-target.js', () => ({ applyFocusTarget: vi.fn(() => true), buildFocusTargetDeps: vi.fn(() => ({})) }));
vi.mock('../chat/open-agent.js', () => ({ openAgentCard: vi.fn() }));

import { openAgentCard } from '../chat/open-agent.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { useUiStore } from '../store/ui.js';
import { openAgentInPanel, openAgentsPanel, openPlanInPanel } from './open-agents.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

beforeEach(() => {
  resetChatUiStoreForTests();
  vi.mocked(openAgentCard).mockClear();
  room.value = true;
  room.real = false;
});

describe('openAgentsPanel', () => {
  it('есть место — вкладка Agents и список (выбор сброшен)', () => {
    useChatUiStore.getState().selectAgent(refKey(REF), { by: 'agent', id: 'old' });
    openAgentsPanel(REF, 'a1');
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'agents' });
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toBeNull();
  });

  it('нет места — просьба показать первую карточку, сайдбар не трогается', () => {
    room.value = false;
    openAgentsPanel(REF, 'a1');
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

it('pins a plan, opens Agents, and preserves the active room', () => {
 const before = useLayoutStore.getState();
 openPlanInPanel(REF);
 expect(useChatUiStore.getState().agentsPin['/tmp/p w-01']).toBe('s-01');
 expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toBeNull();
 expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'agents' });
 expect(useLayoutStore.getState()).toBe(before);
});
it.each([true, false])('existing entrypoints clear an older pin with room=%s', (hasRoom) => {
 room.value = hasRoom;
 useChatUiStore.getState().pinAgentsSession('/tmp/p w-01', 'other'); openAgentsPanel(REF, null);
 expect(useChatUiStore.getState().agentsPin['/tmp/p w-01']).toBeNull();
 useChatUiStore.getState().pinAgentsSession('/tmp/p w-01', 'other'); openAgentInPanel(REF, 'a7');
 expect(useChatUiStore.getState().agentsPin['/tmp/p w-01']).toBeNull();
});
import { useLayoutStore } from '../layout/store.js';

import { fitRightSidebar } from '../../shared/ui-types.js';
it('at 800px closes the left sidebar so Agents fits and keeps the room focused', () => {
 const width = window.innerWidth; Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
 room.real = true;
 useUiStore.getState().setSidebar('left', { open: true, width: 288 });
 const key = '/tmp/p w-01';
 useLayoutStore.setState({ activeWorkKey: key, layouts: { [key]: { root: { type: 'group', id: 'g', tabs: [{ kind: 'room', id: 'room:r-01', roomId: 'r-01' }], activeTabId: 'room:r-01' }, activeGroupId: 'g', closedTabs: [] } } });
 const before = useLayoutStore.getState();
 try {
  openPlanInPanel(REF);
  const { ui } = useUiStore.getState();
  expect(ui.leftSidebar.open).toBe(false); expect(ui.rightSidebar).toMatchObject({ open: true, tab: 'agents' });
  expect(fitRightSidebar(ui.rightSidebar.width, 800, 0)).not.toBeNull();
  expect(useChatUiStore.getState().agentsPin[key]).toBe('s-01'); expect(useLayoutStore.getState()).toBe(before);
 } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});
