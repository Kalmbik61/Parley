/**
 * «Открыть» строку поповера агентов (план 2026-10-01, кусок 4b): из строки сессии сайдбара и с карточки участника
 * комнаты. Вкладку сессии открывает обычный переход окна — тот же, что по клику на уведомление (`applyFocusTarget`:
 * работа активна, вкладка открыта или в фокусе), вид вкладки — «Chat» явным выбором, а прокрутку к карточке делает
 * лента по просьбе из `ui-store.ts`. Карточки в ленте нет (старая лента, сессия без вида «Chat») — вкладка просто открыта.
 */

import { toast } from 'sonner';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { useChatUiStore } from './ui-store.js';

export function openAgentCard(ref: SessionRef, agentId: string): void {
  if (!applyFocusTarget({ kind: 'session', ref }, buildFocusTargetDeps())) {
    // Цели уже нет (сессию или работу убрали) — тот же тост, что у клика по системному уведомлению.
    toast(S.notifications.targetGone);
    return;
  }
  // Вид — тем же путём раскладки, что и открытие вкладки: у работы, ещё не показанной, обе операции ждут её `hydrate` в очереди.
  useLayoutStore.getState().apply(workKey(ref.projectPath, ref.workId), (layout) => updateTab(layout, tabId.terminal(ref.sessionId), { view: 'chat' }));
  useChatUiStore.getState().requestReveal(refKey(ref), agentId);
}
