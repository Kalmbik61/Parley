import { Text } from 'ink';
import type { ReactNode } from 'react';
import { App } from './app.js';
import { theme } from './theme/index.js';
import { useSessions } from './use-sessions.js';

export interface RootProps {
  /** Корень истории Claude Code. По умолчанию ~/.claude/projects — строго на чтение. */
  root?: string;
  /** Корень истории Codex. По умолчанию ~/.codex/sessions — тоже только чтение. */
  codexRoot?: string;
}

/** Связывает живой список сессий всех провайдеров с приложением. */
export function Root({ root, codexRoot }: RootProps): ReactNode {
  const { sessions, loading } = useSessions({
    ...(root === undefined ? {} : { claudeRoot: root }),
    ...(codexRoot === undefined ? {} : { codexRoot }),
  });

  if (loading) return <Text {...theme().fg.muted}>читаю историю сессий…</Text>;
  return (
    <App
      sessions={sessions}
      {...(root === undefined ? {} : { root })}
      {...(codexRoot === undefined ? {} : { codexRoot })}
    />
  );
}
