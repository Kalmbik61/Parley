import { defaultRoot, providerBadge, type SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pane, type PaneSize } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { SubsessionList } from './components/subsession-list.js';
import { TerminalView } from './components/terminal-view.js';
import { useAgentPty, type AgentPtyState } from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { ctrlByte, DEFAULT_ESCAPE_BYTE, usePtyInput } from './pty/use-pty-input.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
import { useNavigation } from './use-navigation.js';
import { useProviderFilter } from './use-provider-filter.js';
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
  const { rows } = useTerminalSize();

  // Размеры панелей приходят из замера (см. Pane), а не из формул по размеру окна.
  const [terminalSize, setTerminalSize] = useState<PaneSize>({ width: 80, height: 24 });
  const terminalCols = Math.max(2, terminalSize.width);
  const terminalRows = Math.max(2, terminalSize.height);

  // Фильтр по провайдеру: списком дальше живут уже отфильтрованные сессии.
  const { filter, visible, present, cycle } = useProviderFilter(sessions);

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
      const target = visible[at];
      if (target !== undefined) agent.open(target, { cols: terminalCols, rows: terminalRows });
    },
    [visible, agent, terminalCols, terminalRows],
  );

  const restartAgent = useCallback(() => {
    agent.restart({ cols: terminalCols, rows: terminalRows });
  }, [agent, terminalCols, terminalRows]);

  // Ввод перехватывает только живой процесс: после его завершения панель снова
  // обычная, иначе из неё было бы не выйти.
  const agentAlive = agent.active !== undefined && agent.active.exit === undefined;

  const { focus, selectedSession, selectedSubsession, setFocus } = useNavigation({
    sessionCount: visible.length,
    getSubsessionCount: () => subsessionCount.current,
    onOpen: openSelected,
    onRestart: restartAgent,
    onCycleProvider: cycle,
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

  const { subsessions, loading } = useSubsessions(visible[selectedSession], root);
  subsessionCount.current = subsessions.length;

  return (
    <Box flexDirection="row" height={rows}>
      <Box flexDirection="column" width={LEFT_WIDTH} minWidth={LEFT_MIN_WIDTH}>
        <Pane
          title={sessionsTitle(visible.length, filter)}
          active={focus === 'sessions'}
          flexGrow={2}
        >
          {(size) => (
            <SessionList
              sessions={visible}
              selected={selectedSession}
              height={size.height}
              width={size.width}
              showProvider={present.length > 1}
            />
          )}
        </Pane>
        <Pane
          title={`SUBSESSIONS (${subsessions.length})`}
          active={focus === 'subsessions'}
          flexGrow={1}
        >
          {(size) => (
            <SubsessionList
              subsessions={subsessions}
              selected={selectedSubsession}
              height={size.height}
              width={size.width}
              loading={loading}
            />
          )}
        </Pane>
      </Box>

      <Pane title={terminalTitle(agent)} active={focus === 'terminal'} flexGrow={1}>
        {(size) => (
          <TerminalPane size={size} agent={agent} snapshot={snapshot} onSize={setTerminalSize} />
        )}
      </Pane>
    </Box>
  );
}

interface TerminalPaneProps {
  size: PaneSize;
  agent: AgentPtyState;
  snapshot: ReturnType<typeof usePtyTerminal>;
  onSize: (size: PaneSize) => void;
}

/** Содержимое правой панели: статус агента и его экран. */
function TerminalPane({ size, agent, snapshot, onSize }: TerminalPaneProps): ReactNode {
  // Сообщаем размер наверх: от него зависят и PTY, и буфер VT.
  useEffect(() => onSize(size), [size, onSize]);

  return (
    <>
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
              <Text dimColor>Enter на сессии — открыть её здесь.</Text>
              <Text dimColor> </Text>
              <Text dimColor>↑↓ / j k — список · Tab — панель · Enter — открыть</Text>
              <Text dimColor>p — провайдер · r — ре-скан · q — выход</Text>
              <Text dimColor> </Text>
              <Text dimColor>В терминале весь ввод идёт агенту, Ctrl+Q — назад.</Text>
            </>
          ) : (
            <TerminalView snapshot={snapshot} height={size.height} />
          )}
        </>
      )}
    </>
  );
}

/** Заголовок списка показывает, действует ли фильтр по провайдеру. */
function sessionsTitle(count: number, filter: SessionIndex['provider'] | null): string {
  return filter === null ? `SESSIONS (${count})` : `SESSIONS (${count}) · ${providerBadge(filter)}`;
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
