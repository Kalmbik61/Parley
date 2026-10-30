/**
 * Открыватель диалога «Continue on another provider…» (спека 2026-10-30, 5.7): меню строки, баннер чата, уведомление
 * и панель провайдеров зовут `openSwitchAgent(ref)`, а `SwitchAgentDialogHost` (в `AppShell`) показывает диалог.
 */

import { create } from 'zustand';
import type { SessionRef } from '@parley/protocol';

interface SwitchAgentState {
  /** Сессия открытого диалога; `null` — закрыт. */
  ref: SessionRef | null;
}

export const useSwitchAgentStore = create<SwitchAgentState>(() => ({ ref: null }));

export function openSwitchAgent(ref: SessionRef): void {
  useSwitchAgentStore.setState({ ref });
}

export function closeSwitchAgent(): void {
  useSwitchAgentStore.setState({ ref: null });
}
