import type { SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { Pane } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { useTerminalSize } from './use-terminal-size.js';

export type PaneId = 'sessions' | 'subsessions' | 'terminal';

export interface AppProps {
  sessions: SessionIndex[];
  /** Какая панель в фокусе. Навигация появится отдельной задачей. */
  focus?: PaneId;
  /** Выбранная сессия. Пока задаётся снаружи — клавиатура появится отдельной задачей. */
  selected?: number;
}

/** Левая колонка — 38% ширины, но не уже 30 колонок (specs/ui.md). */
const LEFT_WIDTH = '38%';
const LEFT_MIN_WIDTH = 30;

export function App({ sessions, focus = 'sessions', selected = 0 }: AppProps): ReactNode {
  const { rows, columns } = useTerminalSize();

  // Ширина левой колонки в символах и высота списка без рамки и заголовка.
  const leftWidth = Math.max(LEFT_MIN_WIDTH, Math.floor(columns * 0.38));
  const sessionsHeight = Math.max(1, Math.floor(((rows - 2) * 2) / 3) - 3);

  return (
    <Box flexDirection="row" height={rows}>
      <Box flexDirection="column" width={LEFT_WIDTH} minWidth={LEFT_MIN_WIDTH}>
        <Pane title={`SESSIONS (${sessions.length})`} active={focus === 'sessions'} flexGrow={2}>
          <SessionList
            sessions={sessions}
            selected={selected}
            height={sessionsHeight}
            width={leftWidth - 4}
          />
        </Pane>
        <Pane title="SUBSESSIONS" active={focus === 'subsessions'} flexGrow={1}>
          <Text dimColor>подсессии выбранной сессии</Text>
        </Pane>
      </Box>

      <Pane title="TERMINAL" active={focus === 'terminal'} flexGrow={1}>
        <Text dimColor>v0: только просмотр. Встроенный терминал появится в v1.</Text>
      </Pane>
    </Box>
  );
}
