import { Text } from 'ink';
import type { ReactNode } from 'react';
import { App } from './app.js';
import { useSessions } from './use-sessions.js';

export interface RootProps {
  /** Корень истории. По умолчанию ~/.claude/projects — строго на чтение. */
  root?: string;
}

/** Связывает живой список сессий с приложением. */
export function Root({ root }: RootProps): ReactNode {
  const { sessions, loading, rescan } = useSessions(root);

  if (loading) return <Text dimColor>читаю ~/.claude/projects…</Text>;
  return <App sessions={sessions} onRescan={rescan} {...(root === undefined ? {} : { root })} />;
}
