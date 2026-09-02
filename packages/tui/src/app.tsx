import {
  createWork,
  defaultCodexRoot,
  defaultRoot,
  modelBadge,
  providerBadge,
  requestAutoSummary,
  type Provider,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DetailsPane } from './components/details-pane.js';
import { Dialog } from './components/dialog.js';
import { Pane, type PaneSize } from './components/pane.js';
import { SessionList } from './components/session-list.js';
import { StatusBar } from './components/status-bar.js';
import { SubsessionList } from './components/subsession-list.js';
import { TerminalView } from './components/terminal-view.js';
import { WorkList } from './components/work-list.js';
import { glyphs } from './glyphs.js';
import type { PtyExit } from './pty/pty-session.js';
import {
  targetProvider,
  useAgentPty,
  workRunKey,
  type AgentPtyState,
  type AgentTarget,
} from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { ctrlByte, DEFAULT_ESCAPE_BYTE, usePtyInput } from './pty/use-pty-input.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
import { useLifecycle } from './use-lifecycle.js';
import { useNavigation, type PaneId } from './use-navigation.js';
import { useProviderFilter } from './use-provider-filter.js';
import { useSessionLink } from './use-session-link.js';
import { useStatus, type StatusSource } from './use-status.js';
import { useSubsessions } from './use-subsessions.js';
import { useTerminalSize } from './use-terminal-size.js';
import { useWorks } from './use-works.js';
import {
  launchDialog,
  newSessionDialog,
  newWorkDialog,
  resumeDialog,
  resumePreview,
  summaryDialog,
  type DialogSpec,
} from './work-dialogs.js';
import {
  createPendingSession,
  finishExited,
  planLaunch,
  planResume,
  providerOptions,
  readBrief,
  startSession,
} from './work-launch.js';
import {
  buildRows,
  providerLabel,
  providerMarkOf,
  workKey,
  type LiveMetrics,
  type WorkRow,
  type WorkRowSession,
} from './work-rows.js';

export interface AppProps {
  sessions: SessionIndex[];
  root?: string;
  /** Корень истории Codex: из него читаются метрики и привязка codex-сессий. */
  codexRoot?: string;
  /** Проект, в котором запущен харнесс: его работы читаются с диска. */
  projectPath?: string;
  onRescan?: () => void;
}

/** Левая колонка — 38% ширины, но не уже 30 колонок (specs/ui.md). */
const LEFT_WIDTH = '38%';
const LEFT_MIN_WIDTH = 30;
const LEFT_PERCENT = 38;

/**
 * Ширина тела диалога по размеру окна: рамка и отступы панели съедают четыре
 * колонки — 26 знаков на 80×24 и 41 на 120×40, как в макетах раздела 4. По ней
 * выбирается только форма строк; рисует диалог по своей измеренной ширине.
 */
const dialogWidth = (columns: number): number =>
  Math.max(LEFT_MIN_WIDTH, Math.floor((columns * LEFT_PERCENT) / 100)) - 4;

/** Режим левой колонки; переключается `w` и живёт до конца процесса (дизайн 1). */
type LeftMode = 'sessions' | 'works';

/**
 * Открытый диалог: его содержимое (дизайн 4) и что делать по `Enter`.
 * `id` нужен, чтобы React пересоздавал поля при смене диалога, а не подсовывал
 * новому диалогу значения прошлого.
 */
interface OpenDialog {
  id: number;
  spec: DialogSpec;
  submit: (values: Record<string, string>) => void;
}

export function App({
  sessions,
  root = defaultRoot(),
  codexRoot = defaultCodexRoot(),
  projectPath = process.cwd(),
  onRescan,
}: AppProps): ReactNode {
  const { columns, rows } = useTerminalSize();

  // Корни истории провайдеров: по ним читаются метрики и ищется привязка сессии
  // к логу. Оба задаются снаружи — в тестах это временные каталоги.
  const roots = useMemo(() => ({ claudeRoot: root, codexRoot }), [root, codexRoot]);

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
        // Последняя запись лога — от неё ДЕТАЛИ считают «молчит Nм» (дизайн 3).
        lastRecordAt: found?.endedAt ?? null,
      };
    },
    [byProviderId],
  );

  const [expandedWorks, setExpandedWorks] = useState<Map<string, boolean>>(new Map());
  const workRows = useMemo(
    () => buildRows(works, { expanded: expandedWorks, filter, live }),
    [works, expandedWorks, filter, live],
  );

  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const dialogId = useRef(0);
  // Ширина, по которой диалог выбирает форму строк (полный путь брифа или
  // короткий, полное имя провайдера или марка) — макеты раздела 4.
  const specWidth = dialogWidth(columns);
  // Правая панель, когда подключаться не к чему: сессию запустили вне харнесса.
  const [note, setNote] = useState<string | null>(null);
  // Сессии, для которых дозаказ уже запущен: у них в СВОДКЕ «считается…» (4.5).
  const [summaryPending, setSummaryPending] = useState<ReadonlySet<string>>(new Set());

  const push = status.push;
  const fail = useCallback(
    (reason: unknown) => {
      push([{ text: reason instanceof Error ? reason.message : String(reason) }]);
    },
    [push],
  );

  const openDialog = useCallback(
    (spec: DialogSpec, submit: OpenDialog['submit']) =>
      setDialog({ id: dialogId.current++, spec, submit }),
    [],
  );
  const closeDialog = useCallback(() => setDialog(null), []);

  // Процесс запущен — только теперь сессия переходит в `active` с id у
  // провайдера (спецификация, раздел 5): статус «идёт» ставится тому, что идёт.
  const onAgentStart = useCallback(
    (target: AgentTarget) => {
      if (target.kind !== 'work') return;
      void startSession(
        target.projectPath,
        target.workId,
        target.sessionId,
        target.providerSessionId,
      ).catch(fail);
    },
    [fail],
  );

  // Процесс сессии работы завершился: `active`/`idle` → `exited` с кодом выхода
  // и фиксацией метрик (спецификация, раздел 6). Отчитавшуюся сессию не трогаем.
  const onAgentExit = useCallback(
    (target: AgentTarget, exit: PtyExit) => {
      if (target.kind !== 'work') return;
      void finishExited(target.projectPath, target.workId, target.sessionId, exit, roots).catch(
        fail,
      );
    },
    [roots, fail],
  );

  // Процесс не запустился: сессия остаётся как была, а причина уходит в строку
  // статуса — единственный канал уведомлений (дизайн 5, спецификация 8).
  const onAgentFail = useCallback(
    (target: AgentTarget, reason: string) => {
      if (target.kind !== 'work') return;
      push([
        {
          text: `${providerMarkOf(target.provider)}: «${target.title}» не запустилась — ${firstLine(reason)}`,
          source: {
            projectPath: target.projectPath,
            workId: target.workId,
            sessionId: target.sessionId,
          },
        },
      ]);
    },
    [push],
  );

  const agent = useAgentPty({ onStart: onAgentStart, onExit: onAgentExit, onFail: onAgentFail });
  const snapshot = usePtyTerminal(agent.active?.session, {
    cols: terminalCols,
    rows: terminalRows,
  });
  usePtyResize(agent.active?.session, terminalCols, terminalRows);

  // Число подсессий известно только после загрузки дерева, а навигация нужна раньше —
  // отдаём его через ref, который читается в момент нажатия клавиши. По той же
  // причине через ref читается и текущая строка списка.
  const subsessionCount = useRef(0);
  // Число строк панели ДЕТАЛИ: их считает сама панель, а навигации оно нужно,
  // чтобы `↑↓` не уходили за конец содержимого (дизайн 3).
  const detailLineCount = useRef(0);
  const selectedRow = useRef(0);
  const currentMode = useRef<LeftMode>(mode);
  currentMode.current = mode;
  const currentRows = useRef<WorkRow[]>(workRows);
  currentRows.current = workRows;
  const selectRow = useRef<(at: number) => void>(() => {});
  // Фокус переводится из колбэков, которые объявлены до useNavigation.
  const focusPane = useRef<(pane: PaneId) => void>(() => {});

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

  /**
   * Запуск или возобновление сессии работы: команда и аргументы из реестра с
   * подстановками, cwd проекта работы, переход в `active` (спецификация, 5 и 6).
   */
  const launchWork = useCallback(
    (row: WorkRowSession, resume: boolean) => {
      const { projectPath: project, workId, session } = row;
      const plan = resume
        ? planResume(project, workId, session)
        : planLaunch(project, workId, session);

      void plan
        .then((ready) => {
          setNote(null);
          // В `active` сессию переводит onAgentStart — когда процесс поднялся.
          agent.open(
            {
              kind: 'work',
              projectPath: project,
              workId,
              sessionId: session.id,
              provider: session.provider,
              title: session.label,
              command: ready.command,
              args: ready.args,
              cwd: ready.cwd,
              env: ready.env,
              providerSessionId: ready.providerSessionId,
            },
            { cols: terminalCols, rows: terminalRows },
          );
        })
        .catch(fail);

      closeDialog();
      focusPane.current('terminal');
    },
    [agent, terminalCols, terminalRows, fail, closeDialog],
  );

  /** Живая сессия: подключаемся к её панели, если PTY у харнесса (решение №5). */
  const attachWork = useCallback(
    (row: WorkRowSession) => {
      if (agent.attach(workRunKey(row.projectPath, row.workId, row.session.id))) {
        setNote(null);
        focusPane.current('terminal');
        return;
      }
      setNote(`Сессия «${row.session.label}» запущена вне харнесса — подключиться нельзя.`);
    },
    [agent],
  );

  /** Enter на строке сессии: ветка по статусу (дизайн 8 и схема переходов 9). */
  const openSessionRow = useCallback(
    (row: WorkRowSession) => {
      const { status: state } = row.session;
      if (state === 'active' || state === 'idle') {
        attachWork(row);
        return;
      }

      if (state === 'pending') {
        // Бриф перечитывается с диска: его могли поправить после создания.
        void readBrief(row.projectPath, row.workId, row.session.id)
          .then((brief) =>
            openDialog(launchDialog(row, brief, glyphs(), specWidth), () => launchWork(row, false)),
          )
          .catch(fail);
        return;
      }

      void planResume(row.projectPath, row.workId, row.session)
        .then((ready) =>
          openDialog(
            resumeDialog(
              row,
              resumePreview(ready.command, ready.args, row.session.providerSessionId),
              glyphs(),
              specWidth,
            ),
            () => launchWork(row, true),
          ),
        )
        .catch(fail);
    },
    [attachWork, launchWork, openDialog, fail, specWidth],
  );

  const openSelected = useCallback(
    (at: number) => {
      // В режиме работ Enter на работе сворачивает и разворачивает её (раздел 8),
      // а на сессии открывает диалог по её статусу.
      if (currentMode.current === 'works') {
        const row = currentRows.current[at];
        if (row === undefined) return;
        if (row.kind === 'work') setWorkExpanded(at, !row.expanded);
        else openSessionRow(row);
        return;
      }
      const session = visible[at];
      if (session !== undefined) {
        setNote(null);
        agent.open({ kind: 'session', session }, { cols: terminalCols, rows: terminalRows });
      }
    },
    [visible, agent, terminalCols, terminalRows, setWorkExpanded, openSessionRow],
  );

  // Новая сессия: провайдера берём из активного фильтра, иначе из выбранной
  // строки. Только так дотягиваемся до раннеров без истории — GLM в списке нет.
  const openNew = useCallback(() => {
    // В режиме работ `n` — диалог новой сессии в выбранной работе (дизайн 4.2).
    if (currentMode.current === 'works') {
      const row = currentRows.current[selectedRow.current];
      if (row === undefined) return;
      const workId = row.kind === 'work' ? row.work.id : row.workId;
      const key = workKey(row.projectPath, workId);
      const work = currentRows.current.find((item) => item.kind === 'work' && item.key === key);
      const title = work?.kind === 'work' ? work.work.title : workId;

      void providerOptions()
        .then((providers) =>
          openDialog(newSessionDialog(title, providers), (values) => {
            closeDialog();
            void createPendingSession(row.projectPath, workId, {
              provider: values['provider'] ?? '',
              label: values['label'] ?? '',
              task: values['task'] ?? '',
            }).catch(fail);
          }),
        )
        .catch(fail);
      return;
    }

    const provider: Provider =
      activeFilter.current ?? visible[selectedRow.current]?.provider ?? 'claude';
    setNote(null);
    agent.open({ kind: 'new', provider }, { cols: terminalCols, rows: terminalRows });
  }, [visible, agent, terminalCols, terminalRows, openDialog, closeDialog, fail]);

  /**
   * `s` — дозаказ резюме для сессии, вышедшей без отчёта (дизайн 4.5). Считается
   * в фоне: пока идёт, в СВОДКЕ «авто-резюме: считается…», по готовности запись
   * карты приходит через watcher и всплывает в строке статуса.
   */
  const openSummary = useCallback(() => {
    if (currentMode.current !== 'works') return;
    const row = currentRows.current[selectedRow.current];
    // Дозаказ есть только у вышедшей без отчёта: у остальных резюме либо будет,
    // либо уже есть (дизайн 8, таблица клавиш).
    if (row?.kind !== 'session' || row.session.status !== 'exited') return;

    const { projectPath: project, workId, session } = row;
    openDialog(summaryDialog(row, glyphs(), specWidth), () => {
      closeDialog();
      const key = workRunKey(project, workId, session.id);
      setSummaryPending((current) => new Set(current).add(key));
      void requestAutoSummary(project, workId, session.id, roots)
        .catch(fail)
        .finally(() =>
          setSummaryPending((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          }),
        );
    });
  }, [openDialog, closeDialog, specWidth, roots, fail]);

  /** `N` — новая работа; проект всегда cwd харнесса (дизайн 4.1, решение №9). */
  const openNewWork = useCallback(() => {
    if (currentMode.current !== 'works') return;
    openDialog(newWorkDialog(projectPath), (values) => {
      closeDialog();
      void createWork(projectPath, {
        title: values['title'] ?? '',
        goal: values['goal'] ?? '',
      }).catch(fail);
    });
  }, [projectPath, openDialog, closeDialog, fail]);

  const countDetailLines = useCallback((count: number) => {
    detailLineCount.current = count;
  }, []);

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
    getSubsessionCount: () =>
      currentMode.current === 'works' ? detailLineCount.current : subsessionCount.current,
    onOpen: openSelected,
    onRestart: restartAgent,
    onCycleProvider: cycle,
    onNewSession: openNew,
    onNewWork: openNewWork,
    onSummary: openSummary,
    onToggleMode: toggleMode,
    onCollapse: () => setSelectedExpanded(false),
    onExpand: () => setSelectedExpanded(true),
    onKey: status.keyPressed,
    focusTerminalOnOpen: mode === 'sessions',
    // В режиме «все сессии» `n` сразу запускает агента справа; в режиме работ
    // она открывает диалог в левой колонке, и фокус остаётся на списках.
    newSessionOpensTerminal: mode === 'sessions',
    // Диалог модален для левой колонки: клавиши списков на это время молчат.
    suspended: dialog !== null,
    terminalCaptures: agentAlive,
    onRescan: rescan,
  });

  selectedRow.current = selectedSession;
  selectRow.current = select;
  focusPane.current = setFocus;

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

  // Статусы, которые ведёт харнесс: `active ↔ idle` по молчанию лога (раздел 6).
  // `idle` — «жив, но молчит», поэтому его получают только сессии со своим PTY.
  useLifecycle({
    works,
    live,
    alive: (project, workId, sessionId) => agent.alive(workRunKey(project, workId, sessionId)),
  });

  // Сессии провайдеров без внешнего id (codex) привязываются к своему логу по
  // cwd и времени запуска: без этого нет ни метрик, ни возобновления (раздел 5).
  useSessionLink({ works, sessions, roots });

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

  // В режиме работ подсессии — секция СУБАГЕНТЫ панели ДЕТАЛИ: сессия работы
  // ищется в индексе логов по providerSessionId (дизайн 3).
  const { subsessions, workflows, loading } = useSubsessions(
    mode === 'works' ? sessionOf(selectedWorkRow, byProviderId) : visible[selectedSession],
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
            // Диалог занимает место нижней панели; правая колонка не трогается.
            title={
              dialog !== null
                ? dialog.spec.title
                : mode === 'works'
                  ? detailsTitle(selectedWorkRow)
                  : `SUBSESSIONS (${subsessions.length})`
            }
            active={dialog !== null || focus === 'subsessions'}
            flexGrow={1}
          >
            {(size) =>
              dialog !== null ? (
                <Dialog
                  key={dialog.id}
                  fields={dialog.spec.fields}
                  info={dialog.spec.info}
                  quote={dialog.spec.quote}
                  footer={dialog.spec.footer}
                  width={size.width}
                  height={size.height}
                  onSubmit={dialog.submit}
                  onCancel={closeDialog}
                />
              ) : mode === 'works' ? (
                <DetailsPane
                  row={selectedWorkRow}
                  width={size.width}
                  height={size.height}
                  selected={selectedSubsession}
                  subsessions={subsessions}
                  onLines={countDetailLines}
                  summaryPending={
                    selectedWorkRow?.kind === 'session' &&
                    summaryPending.has(
                      workRunKey(
                        selectedWorkRow.projectPath,
                        selectedWorkRow.workId,
                        selectedWorkRow.session.id,
                      ),
                    )
                  }
                />
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
            <TerminalPane
              size={size}
              agent={agent}
              snapshot={snapshot}
              note={note}
              onSize={setTerminalSize}
            />
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
  /** Подключаться не к чему: сессия запущена вне харнесса (решение №5). */
  note: string | null;
  onSize: (size: PaneSize) => void;
}

/** Содержимое правой панели: статус агента и его экран. */
function TerminalPane({ size, agent, snapshot, note, onSize }: TerminalPaneProps): ReactNode {
  // Сообщаем размер наверх: от него зависят и PTY, и буфер VT.
  useEffect(() => onSize(size), [size, onSize]);

  return (
    <>
      {note !== null ? (
        <>
          <Text color="yellow">{note}</Text>
          <Text dimColor>Детали сессии — в левой колонке.</Text>
        </>
      ) : agent.error !== undefined ? (
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

/** Сессия работы в индексе логов: по ней читаются подсессии для ДЕТАЛЕЙ. */
function sessionOf(
  row: WorkRow | undefined,
  byProviderId: ReadonlyMap<string, SessionIndex>,
): SessionIndex | undefined {
  if (row?.kind !== 'session' || row.session.providerSessionId === null) return undefined;
  return byProviderId.get(row.session.providerSessionId);
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

/** В строку статуса помещается одна строка: у ошибки запуска это её суть. */
const firstLine = (text: string): string => text.split('\n')[0] ?? text;

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
