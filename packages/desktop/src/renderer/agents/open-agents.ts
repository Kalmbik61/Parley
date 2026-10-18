/**
 * Входы в панель Agents (спека 2026-10-07, 5.1). «N agents running» в тулбаре открывает вкладку со списком; строка
 * поповера агентов в сайдбаре и у участника комнаты — вкладку сессии и сразу экран этого агента. Правому сайдбару не
 * хватает места — прежнее поведение: прокрутка ленты к карточке агента.
 */

import { refKey, type SessionRef } from '@parley/protocol';
import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { openAgentCard } from '../chat/open-agent.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { rightSidebarHasRoom } from '../shell/RightSidebar.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';

/** Тулбар «N agents running»: вкладка Agents; нет места — прокрутка к первой карточке (прежнее поведение). */
export function openAgentsPanel(ref: SessionRef, firstAgentId: string | null): void {
  const sessionKey = refKey(ref);
  useChatUiStore.getState().pinAgentsSession(workKey(ref.projectPath, ref.workId), null);
  if (!rightSidebarHasRoom()) {
    if (firstAgentId !== null) useChatUiStore.getState().requestReveal(sessionKey, firstAgentId);
    return;
  }
  useChatUiStore.getState().selectAgent(sessionKey, null);
  useUiStore.getState().setSidebar('right', { open: true, tab: 'agents' });
}

/** Строка поповера агентов: вкладка сессии в фокусе, вкладка Agents и экран агента; нет места — openAgentCard. */
export function openAgentInPanel(ref: SessionRef, agentId: string): void {
  useChatUiStore.getState().pinAgentsSession(workKey(ref.projectPath, ref.workId), null);
  if (!rightSidebarHasRoom()) {
    openAgentCard(ref, agentId);
    return;
  }
  if (!applyFocusTarget({ kind: 'session', ref }, buildFocusTargetDeps())) {
    toast(S.notifications.targetGone);
    return;
  }
  useChatUiStore.getState().selectAgent(refKey(ref), { by: 'agent', id: agentId });
  useUiStore.getState().setSidebar('right', { open: true, tab: 'agents' });
}

/** Open a participant plan without changing the main tab, making room at the minimum window width. */
export function openPlanInPanel(ref: SessionRef): void {
  if (!rightSidebarHasRoom()) useUiStore.getState().setSidebar('left', { open: false });
  useChatUiStore.getState().pinAgentsSession(workKey(ref.projectPath, ref.workId), ref.sessionId);
  useChatUiStore.getState().selectAgent(refKey(ref), null);
  useUiStore.getState().setSidebar('right', { open: true, tab: 'agents' });
}
