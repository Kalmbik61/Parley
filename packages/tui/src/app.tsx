import {
  defaultRoot,
  modelBadge,
  providerBadge,
  type Provider,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DetailsPane } from './components/details-pane.js';
import { Pane, type PaneSize } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { StatusBar } from './components/status-bar.js';
import { SubsessionList } from './components/subsession-list.js';
import { TerminalView } from './components/terminal-view.js';
import { WorkList } from './components/work-list.js';
import { targetProvider, useAgentPty, type AgentPtyState } from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { ctrlByte, DEFAULT_ESCAPE_BYTE, usePtyInput } from './pty/use-pty-input.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
import { useNavigation } from './use-navigation.js';
import { useProviderFilter } from './use-provider-filter.js';
import { useStatus, type StatusSource } from './use-status.js';
import { useSubsessions } from './use-subsessions.js';
import { useTerminalSize } from './use-terminal-size.js';
import { useWorks } from './use-works.js';
import {
  buildRows,
  providerLabel,
  providerMarkOf,
  workKey,
  type LiveMetrics,
  type WorkRow,
} from './work-rows.js';

export interface AppProps {
  sessions: SessionIndex[];
  root?: string;
  /** Проект, в котором запущен харнесс: его работы читаются с диска. */
  projectPath?: string;
  onRescan?: () => void;
}

/** Левая колонка — 38% ширины, но не уже 30 колонок (specs/ui.md). */
const LEFT_WIDTH = '38%';
const LEFT_MIN_WIDTH = 30;

/** Режим левой колонки; переключается `w` и живёт до конца процесса (дизайн 1). */
type LeftMode = 'sessions' | 'works';

export function App({
  sessions,
  root = defaultRoot(),
  projectPath = process.cwd(),
  onRescan,
}: AppProps): ReactNode {
  const { columns, rows } = useTerminalSize();

  // Размеры панелей приходят из замера (см. Pane), а не из формул по размеру окна.
  const [terminalSize, setTerminalSize] = useState<PaneSize>({ width: 80, height: 24 });
  const terminalCols = Math.max(2, terminalSize.width);
  const terminalRows = Math.max(2, terminalSize.height);

  const [mode, setMode] = useState<LeftMode>('sessions');

  const status = useStatus();
  const { works, rescan: rescanWorks } = useWorks({ projectPath, onEvents: status.push });

  // Провайдеры сессий работ: у работы, созданной через CLI или MCP, логов ещё
  // нет, и по одному индексу логов её провайдер было бы не выбрать (дизайн 6.5).
  const workProviders = useMemo(
    () => [...new Set(works.flatMap((entry) => entry.map.sessions.map((s) => s.provider)))],
    [works],
  );

  // Фильтр по провайдеру: списком дальше живут уже отфильтрованные сессии.
  // Значение дублируется в ref: между нажатиями «p» и «n» состояние ещё не
  // успеет доехать до замыкания, и новая сессия ушла бы не тому провайдеру.
  const { filter, visible, present, cycle } = useProviderFilter(sessions, workProviders);
  const activeFilter = useRef<Provider | null>(filter);
  activeFilter.current = filter;

  // Метрики живой сессии берутся из уже построенного индекса логов: он живёт по
  // событиям watcher, отдельного чтения файлов режиму работ не нужно.
  const byProviderId = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const live = useCallback(
    (session: WorkSession): LiveMetrics => {
      const found =
        session.providerSessionId === null
          ? undefined
          : byProviderId.get(session.providerSessionId);
      return {
        durationMs: found?.durationMs ?? null,
        tokens: found?.tokens ?? null,
        model: found?.primaryModel ?? null,
      };
    },
    [byProviderId],
  );

  const [expandedWorks, setExpandedWorks] = useState<Map<string, boolean>>(new Map());
  const workRows = useMemo(
    () => buildRows(works, { expanded: expandedWorks, filter, live }),
    [works, expandedWorks, filter, live],
  );

  const agent = useAgentPty();
  const snapshot = usePtyTerminal(agent.active?.session, {
    cols: terminalCols,
    rows: terminalRows,
  });
  usePtyResize(agent.active?.session, terminalCols, terminalRows);

  // Число подсессий известно только после загрузки дерева, а навигация нужна раньше —
  // отдаём его через ref, который читается в момент нажатия клавиши. По той же
  // причине через ref читается и текущая строка списка.
  const subsessionCount = useRef(0);
  const selectedRow = useRef(0);
  const currentMode = useRef<LeftMode>(mode);
  currentMode.current = mode;
  const currentRows = useRef<WorkRow[]>(workRows);
  currentRows.current = workRows;
  const selectRow = useRef<(at: number) => void>(() => {});

  const setWorkExpanded = useCallback((at: number, open: boolean) => {
    const row = currentRows.current[at];
    if (row === undefined) return;
    const key = row.kind === 'work' ? row.key : workKey(row.projectPath, row.workId);
    // Свернули работу из строки её сессии — выбор переезжает на саму работу,
    // иначе он остался бы на индексе, за которым уже другая строка.
    if (row.kind === 'session' && !open) {
      const workAt = currentRows.current.findIndex(
        (item) => item.kind === 'work' && item.key === key,
      );
      if (workAt !== -1) selectRow.current(workAt);
    }
    setExpandedWorks((current) => new Map(current).set(key, open));
  }, []);

  // ←→ и h l принадлежат только режиму работ (дизайн 8): в «все сессии» выбранная
  // строка — индекс чужого списка, и по нему свернулась бы посторонняя работа.
  const setSelectedExpanded = useCallback(
    (open: boolean) => {
      if (currentMode.current !== 'works') return;
      setWorkExpanded(selectedRow.current, open);
    },
    [setWorkExpanded],
  );

  const openSelected = useCallback(
    (at: number) => {
      // В режиме работ Enter на работе сворачивает и разворачивает её (раздел 8).
      if (currentMode.current === 'works') {
        const row = currentRows.current[at];
        if (row?.kind === 'work') setWorkExpanded(at, !row.expanded);
        return;
      }
      const session = visible[at];
      if (session !== undefined) {
        agent.open({ kind: 'session', session }, { cols: terminalCols, rows: terminalRows });
      }
    },
    [visible, agent, terminalCols, terminalRows, setWorkExpanded],
  );

  // Новая сессия: провайдера берём из активного фильтра, иначе из выбранной
  // строки. Только так дотягиваемся до раннеров без истории — GLM в списке нет.
  const openNew = useCallback(() => {
    const provider: Provider =
      activeFilter.current ?? visible[selectedRow.current]?.provider ?? 'claude';
    agent.open({ kind: 'new', provider }, { cols: terminalCols, rows: terminalRows });
  }, [visible, agent, terminalCols, terminalRows]);

  const restartAgent = useCallback(() => {
    agent.restart({ cols: terminalCols, rows: terminalRows });
  }, [agent, terminalCols, terminalRows]);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'sessions' ? 'works' : 'sessions'));
    // Списки разные: индекс из одного в другом указывал бы в случайную строку.
    selectRow.current(0);
  }, []);

  const rescan = useCallback(() => {
    onRescan?.();
    rescanWorks();
  }, [onRescan, rescanWorks]);

  // Ввод перехватывает только живой процесс: после его завершения панель снова
  // обычная, иначе из неё было бы не выйти.
  const agentAlive = agent.active !== undefined && agent.active.exit === undefined;

  const { focus, selectedSession, selectedSubsession, setFocus, select } = useNavigation({
    sessionCount: mode === 'works' ? workRows.length : visible.length,
    getSubsessionCount: () => subsessionCount.current,
    onOpen: openSelected,
    onRestart: restartAgent,
    onCycleProvider: cycle,
    onNewSession: openNew,
    onToggleMode: toggleMode,
    onCollapse: () => setSelectedExpanded(false),
    onExpand: () => setSelectedExpanded(true),
    onKey: status.keyPressed,
    focusTerminalOnOpen: mode === 'sessions',
    // `n` в режиме работ — диалог 4.2, которого ещё нет: до него клавиша молчит,
    // иначе она запускала бы агента по индексу из списка сессий (дизайн 8).
    newSessionEnabled: mode === 'sessions',
    terminalCaptures: agentAlive,
    onRescan: rescan,
  });

  selectedRow.current = selectedSession;
  selectRow.current = select;

  const selectedWorkRow = mode === 'works' ? workRows[selectedSession] : undefined;

  // Событие считается просмотренным, когда фокус побывал на его строке (дизайн 5).
  const seen = status.seen;
  useEffect(() => {
    seen(sourceOf(selectedWorkRow));
  }, [seen, selectedWorkRow]);

  // Предупреждение о параллельных агентах живёт в строке статуса, а не поверх
  // правой панели: канал уведомлений один на оба режима (дизайн 5, решение №8).
  // Считаются живые сессии того же провайдера: лимиты подписки общие у него, а
  // не у соседнего — иначе про Claude утверждалось бы неверное (дизайн 5).
  const push = status.push;
  const wasLive = useRef(0);
  const activeProvider = agent.active === undefined ? null : targetProvider(agent.active.target);
  const liveSameProvider = activeProvider === null ? 0 : agent.liveOf(activeProvider);
  useEffect(() => {
    if (liveSameProvider > 1 && wasLive.current <= 1 && activeProvider !== null) {
      push([
        {
          text: `${providerMarkOf(activeProvider)}: уже есть активная сессия — лимиты подписки общие`,
        },
      ]);
    }
    wasLive.current = liveSameProvider;
  }, [liveSameProvider, activeProvider, push]);

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

  // В режиме работ подсессии не показываются: строка выбрана в другом списке.
  const { subsessions, workflows, loading } = useSubsessions(
    mode === 'works' ? undefined : visible[selectedSession],
    root,
  );
  subsessionCount.current = subsessions.length;

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={LEFT_WIDTH} minWidth={LEFT_MIN_WIDTH}>
          <Pane
            title={
              mode === 'works'
                ? withFilter('РАБОТЫ', countWorks(workRows), filter)
                : withFilter('SESSIONS', visible.length, filter)
            }
            active={focus === 'sessions'}
            flexGrow={2}
          >
            {(size) =>
              mode === 'works' ? (
                <WorkList
                  rows={workRows}
                  selected={selectedSession}
                  height={size.height}
                  width={size.width}
                />
              ) : (
                <SessionList
                  sessions={visible}
                  selected={selectedSession}
                  height={size.height}
                  width={size.width}
                  showProvider={present.length > 1}
                />
              )
            }
          </Pane>
          <Pane
            title={
              mode === 'works'
                ? detailsTitle(selectedWorkRow)
                : `SUBSESSIONS (${subsessions.length})`
            }
            active={focus === 'subsessions'}
            flexGrow={1}
          >
            {(size) =>
              mode === 'works' ? (
                <DetailsPane row={selectedWorkRow} width={size.width} />
              ) : (
                <SubsessionList
                  subsessions={subsessions}
                  workflows={workflows}
                  selected={selectedSubsession}
                  height={size.height}
                  width={size.width}
                  loading={loading}
                />
              )
            }
          </Pane>
        </Box>

        <Pane
          title={terminalTitle(agent)}
          subtitle={terminalSubtitle(agent)}
          active={focus === 'terminal'}
          flexGrow={1}
        >
          {(size) => (
            <TerminalPane size={size} agent={agent} snapshot={snapshot} onSize={setTerminalSize} />
          )}
        </Pane>
      </Box>

      <StatusBar count={status.count} event={status.last} width={columns} />
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
              <Text dimColor>n — новая сессия · p — провайдер · r — ре-скан · q — выход</Text>
              <Text dimColor>w — режим: все сессии ↔ работы</Text>
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

/** Строка-источник события: по ней оно гаснет, когда на ней побывал фокус. */
function sourceOf(row: WorkRow | undefined): StatusSource | null {
  if (row === undefined) return null;
  return {
    projectPath: row.projectPath,
    workId: row.kind === 'work' ? row.work.id : row.workId,
    sessionId: row.kind === 'work' ? null : row.session.id,
  };
}

const countWorks = (rows: readonly WorkRow[]): number =>
  rows.filter((row) => row.kind === 'work').length;

/** Заголовок списка показывает, действует ли фильтр по провайдеру. */
function withFilter(title: string, count: number, filter: Provider | null): string {
  return filter === null ? `${title} (${count})` : `${title} (${count}) · ${providerBadge(filter)}`;
}

function detailsTitle(row: WorkRow | undefined): string {
  if (row === undefined) return 'ДЕТАЛИ';
  return `ДЕТАЛИ — ${row.kind === 'work' ? row.work.title : row.session.label}`;
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

/** Заголовок правой панели — имя сессии (дизайн 2.1); пока пусто — общее TERMINAL. */
function terminalTitle(agent: AgentPtyState): string {
  if (agent.active === undefined) return 'TERMINAL';
  const { title, exit } = agent.active;
  return exit === undefined ? title : `${title} (завершён)`;
}

/**
 * Вторая строка заголовка правой панели: провайдер и модель серым — та же пара
 * строк, что в списке и в ДЕТАЛЯХ (дизайн 2.1 и 3). У нового запуска модели ещё
 * нет: остаётся один провайдер.
 */
function terminalSubtitle(agent: AgentPtyState): string | undefined {
  const target = agent.active?.target;
  if (target === undefined) return undefined;
  const provider = providerLabel(targetProvider(target));
  const model = target.kind === 'session' ? modelBadge(target.session.primaryModel) : '—';
  return model === '—' || model === provider ? provider : `${provider} ${model}`;
}
