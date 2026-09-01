import { defaultRoot, type SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import { useRef, type ReactNode } from 'react';
import { Pane } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { SubsessionList } from './components/subsession-list.js';
import { useNavigation } from './use-navigation.js';
import { useSubsessions } from './use-subsessions.js';
import { useTerminalSize } from './use-terminal-size.js';

export interface AppProps {
  sessions: SessionIndex[];
  root?: string;
  onRescan?: () => void;
}

/** Левая колонка — 38% ширины, но не уже 30 колонок (specs/ui.md). */
const LEFT_WIDTH = '38%';
const LEFT_MIN_WIDTH = 30;

export function App({ sessions, root = defaultRoot(), onRescan }: AppProps): ReactNode {
  const { rows, columns } = useTerminalSize();

  // Число подсессий известно только после загрузки дерева, а навигация нужна раньше —
  // отдаём его через ref, который читается в момент нажатия клавиши.
  const subsessionCount = useRef(0);
  const { focus, selectedSession, selectedSubsession } = useNavigation({
    sessionCount: sessions.length,
    getSubsessionCount: () => subsessionCount.current,
    ...(onRescan === undefined ? {} : { onRescan }),
  });
  const { subsessions, loading } = useSubsessions(sessions[selectedSession], root);
  subsessionCount.current = subsessions.length;

  // Ширина левой колонки в символах и высота списков без рамки и заголовка.
  const leftWidth = Math.max(LEFT_MIN_WIDTH, Math.floor(columns * 0.38));
  const sessionsHeight = Math.max(1, Math.floor(((rows - 2) * 2) / 3) - 3);
  const subsessionsHeight = Math.max(1, Math.floor((rows - 2) / 3) - 3);

  return (
    <Box flexDirection="row" height={rows}>
      <Box flexDirection="column" width={LEFT_WIDTH} minWidth={LEFT_MIN_WIDTH}>
        <Pane title={`SESSIONS (${sessions.length})`} active={focus === 'sessions'} flexGrow={2}>
          <SessionList
            sessions={sessions}
            selected={selectedSession}
            height={sessionsHeight}
            width={leftWidth - 4}
          />
        </Pane>
        <Pane
          title={`SUBSESSIONS (${subsessions.length})`}
          active={focus === 'subsessions'}
          flexGrow={1}
        >
          <SubsessionList
            subsessions={subsessions}
            selected={selectedSubsession}
            height={subsessionsHeight}
            width={leftWidth - 4}
            loading={loading}
          />
        </Pane>
      </Box>

      <Pane title="TERMINAL" active={focus === 'terminal'} flexGrow={1}>
        <Text dimColor>v0: только просмотр. Встроенный терминал появится в v1.</Text>
        <Text dimColor> </Text>
        <Text dimColor>↑↓ / j k — список · Tab — панель · r — ре-скан · q — выход</Text>
      </Pane>
    </Box>
  );
}
