/**
 * Окружение элементов ленты вида «Chat»: мост окна и сессия вкладки. Нужно немногим элементам —
 * ссылкам в тексте (`app.openExternal`) и карточке субагента («Show transcript» — `feed.snapshot`
 * с `agentId`), поэтому контекстом, а не пропом через весь список.
 */

import { createContext, useContext } from 'react';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

export interface ChatEnv {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  /** Работа и вкладка вида «Chat»: карточке плана нужны, чтобы уйти в терминал («Change the plan…»). */
  workKey?: string;
  tabId?: string;
}

export const ChatEnvContext = createContext<ChatEnv | null>(null);

export function useChatEnv(): ChatEnv {
  const env = useContext(ChatEnvContext);
  if (env === null) throw new Error('chat: feed item outside ChatEnvContext (ChatView must provide it)');
  return env;
}
