import { defaultRoot, type SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import { useCallback, useRef, type ReactNode } from 'react';
import { Pane } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { SubsessionList } from './components/subsession-list.js';
import { TerminalView } from './components/terminal-view.js';
import { useAgentPty, type AgentPtyState } from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { ctrlByte, DEFAULT_ESCAPE_BYTE, usePtyInput } from './pty/use-pty-input.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
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

  // Ширина левой колонки в символах и высота списков без рамки и заголовка.
  const leftWidth = Math.max(LEFT_MIN_WIDTH, Math.floor(columns * 0.38));
  const sessionsHeight = Math.max(1, Math.floor(((rows - 2) * 2) / 3) - 3);
  const subsessionsHeight = Math.max(1, Math.floor((rows - 2) / 3) - 3);
  // Правая панель за вычетом рамки, отступов и строки заголовка.
  const terminalCols = Math.max(2, columns - leftWidth - 4);
  const terminalRows = Math.max(2, rows - 3);

  const agent = useAgentPty();
  const snapshot = usePtyTerminal(agent.active?.session, {
    cols: terminalCols,
    rows: terminalRows,
  });
  usePtyResize(agent.active?.session, terminalCols, terminalRows);

  // Число подсессий известно только после загрузки дерева, а навигация нужна раньше —
  // отдаём его через ref, который читается в момент нажатия клавиши.
  const subsessionCount = useRef(0);

  const openSelected = useCallback(
    (at: number) => {
      const target = sessions[at];
      if (target !== undefined) agent.open(target, { cols: terminalCols, rows: terminalRows });
    },
    [sessions, agent, terminalCols, terminalRows],
  );

  const restartAgent = useCallback(() => {
    agent.restart({ cols: terminalCols, rows: terminalRows });
  }, [agent, terminalCols, terminalRows]);

  // Ввод перехватывает только живой процесс: после его завершения панель снова
  // обычная, иначе из неё было бы не выйти.
  const agentAlive = agent.active !== undefined && agent.active.exit === undefined;

  const { focus, selectedSession, selectedSubsession, setFocus } = useNavigation({
    sessionCount: sessions.length,
    getSubsessionCount: () => subsessionCount.current,
    onOpen: openSelected,
    onRestart: restartAgent,
    terminalCaptures: agentAlive,
    ...(onRescan === undefined ? {} : { onRescan }),
  });

  const backToLists = useCallback(() => setFocus('sessions'), [setFocus]);
  usePtyInput(agent.active?.session, focus === 'terminal' && agentAlive, {
    escapeByte: escapeByteFromEnv(),
    onEscape: backToLists,
  });
  // Мышь и вставка в скобках: включаем у себя ровно то, что запросил агент.
  useHostTerminalModes(
    focus === 'terminal' && agentAlive,
    snapshot?.mouseTracking ?? 'none',
    snapshot?.bracketedPaste ?? false,
  );

  const { subsessions, loading } = useSubsessions(sessions[selectedSession], root);
  subsessionCount.current = subsessions.length;

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

      <Pane title={terminalTitle(agent)} active={focus === 'terminal'} flexGrow={1}>
        {agent.error !== undefined ? (
          <Text color="red">{agent.error}</Text>
        ) : (
          <>
            {agent.liveCount > 1 && (
              <Text color="yellow">
                Параллельно работает агентов: {agent.liveCount}. Это расходует лимиты подписки.
              </Text>
            )}
            {agent.active?.exit !== undefined && (
              <Text color="yellow">
                {exitLine(agent.active.exit)} · R — перезапустить · Tab — к спискам
              </Text>
            )}
            {snapshot === undefined ? (
              <>
                <Text dimColor>Enter на сессии — открыть её здесь через claude --resume.</Text>
                <Text dimColor> </Text>
                <Text dimColor>↑↓ / j k — список · Tab — панель · r — ре-скан · q — выход</Text>
                <Text dimColor>
                  Внутри терминала весь ввод идёт агенту; Ctrl+Q — назад к спискам.
                </Text>
              </>
            ) : (
              <TerminalView snapshot={snapshot} height={terminalRows} />
            )}
          </>
        )}
      </Pane>
    </Box>
  );
}

/** Клавиша возврата фокуса настраивается: HARNAS_ESCAPE_KEY=w значит Ctrl+W. */
function escapeByteFromEnv(): number {
  const letter = process.env['HARNAS_ESCAPE_KEY'];
  return (letter === undefined ? undefined : ctrlByte(letter)) ?? DEFAULT_ESCAPE_BYTE;
}

/** Сигнал важнее кода: снятый по сигналу процесс — это не «штатный выход». */
function exitLine(exit: { exitCode: number; signal: number | undefined }): string {
  if (exit.signal !== undefined && exit.signal !== 0) {
    return `Агент завершился по сигналу ${exit.signal}`;
  }
  return exit.exitCode === 0
    ? 'Агент завершился штатно'
    : `Агент завершился с кодом ${exit.exitCode}`;
}

function terminalTitle(agent: AgentPtyState): string {
  if (agent.active === undefined) return 'TERMINAL';
  const name = agent.active.target.title ?? agent.active.target.id;
  return agent.active.exit === undefined ? `TERMINAL — ${name}` : `TERMINAL — ${name} (завершён)`;
}
