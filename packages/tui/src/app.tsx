import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { Pane } from './components/pane.js';
import { useTerminalSize } from './use-terminal-size.js';

export type PaneId = 'sessions' | 'subsessions' | 'terminal';

export interface AppProps {
  /** Какая панель в фокусе. Навигация появится отдельной задачей. */
  focus?: PaneId;
}

/** Левая колонка — 38% ширины, но не уже 30 колонок (specs/ui.md). */
const LEFT_WIDTH = '38%';
const LEFT_MIN_WIDTH = 30;

export function App({ focus = 'sessions' }: AppProps): ReactNode {
  const { rows } = useTerminalSize();

  return (
    <Box flexDirection="row" height={rows}>
      <Box flexDirection="column" width={LEFT_WIDTH} minWidth={LEFT_MIN_WIDTH}>
        <Pane title="SESSIONS" active={focus === 'sessions'} flexGrow={2}>
          <Text dimColor>список сессий</Text>
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
