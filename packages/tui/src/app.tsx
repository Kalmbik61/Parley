/**
 * Композиция TUI v2: сайдбар слева, одна панель справа, строка статуса внизу
 * (дизайн `2026-09-05-tui-v2-design.md`, разделы 2, 3, 5; макеты 1–4).
 *
 * Здесь только связывание: панель — `use-panel.ts` и `components/panel.tsx`,
 * клавиши и мышь — `use-actions.ts`, оверлеи — `use-overlays.ts`, состояния —
 * `use-activity.ts`, выбор — `use-selection.ts`, карты — `use-map-sync.ts`.
 */

import { defaultCodexRoot, defaultRoot, type SessionIndex, type WorkSession } from '@harnas/core';
import { Box, useApp } from 'ink';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { overlayCovers, OverlayHost, overlayRoom } from './components/overlay.js';
import { cardFor, Panel, PANEL_FRAME } from './components/panel.js';
import {
  Sidebar,
  SidebarOverlay,
  sidebarSessions,
  sidebarWidth,
  sidebarWorks,
  WIDE,
} from './components/sidebar.js';
import { StatusBar } from './components/status-bar.js';
import { Thread } from './components/thread.js';
import { MIN_PTY } from './pty/pty-session.js';
import { workRunKey } from './pty/use-agent-pty.js';
import { useActions } from './use-actions.js';
import { activityWork, useActivity } from './use-activity.js';
import { useChannelProbe } from './use-channel.js';
import { useConfig } from './use-config.js';
import { useGitBranch } from './use-git-branch.js';
import { useLogIndex } from './use-log-index.js';
import { useAutoLaunch } from './use-auto-launch.js';
import { useMapSync } from './use-map-sync.js';
import { useOverlays } from './use-overlays.js';
import { usePanel } from './use-panel.js';
import { ctrlByte } from './use-prefix-input.js';
import { useAttachSession, useSelection } from './use-selection.js';
import { useSessionLink } from './use-session-link.js';
import { useStatus } from './use-status.js';
import { useTerminalSize } from './use-terminal-size.js';
import { useThread } from './use-thread.js';
import { useWorks } from './use-works.js';
import { sessionOrders, workKey } from './work-rows.js';

export interface AppProps {
  /** Индекс логов провайдера: заголовки, метрики и страховка activity. */
  sessions: SessionIndex[];
  root?: string;
  codexRoot?: string;
  /** Проект, в котором запущен харнесс: его работы видны в сайдбаре. */
  projectPath?: string;
}

export function App({
  sessions,
  root = defaultRoot(),
  codexRoot = defaultCodexRoot(),
  projectPath = process.cwd(),
}: AppProps): ReactNode {
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();
  const roots = useMemo(() => ({ claudeRoot: root, codexRoot }), [root, codexRoot]);

  const status = useStatus();
  const { push, seen, keyPressed } = status;
  const fail = useCallback(
    (err: unknown) => push([{ text: err instanceof Error ? err.message : String(err) }]),
    [push],
  );
  const { config, fromEnv, update: updateConfig } = useConfig(push);
  // Push через channel: настройка плюс проба версии `claude` — старая сборка
  // флага канала не принимает (разговор агентов, 4.4).
  const channelSupported = useChannelProbe(config.channelPush, push);
  const channel = config.channelPush && channelSupported;
  const warn = useCallback((text: string) => push([{ text }]), [push]);
  const prefixName = `ctrl+${config.prefix}`;
  const { works, loading } = useWorks({
    projectPath,
    prefix: prefixName,
    messageRate: config.messageRate,
    autoLaunch: config.autoLaunch,
    onEvents: push,
  });

  const { index, log } = useLogIndex(sessions);
  const activity = useActivity({
    works: works.map(activityWork),
    log,
    silenceThresholdMs: config.silenceThresholdMs,
    onEvents: push,
  });

  const [hidden, setHidden] = useState(false);
  // Работы чужих проектов, выбранные пикером, живут в сайдбаре до выхода (2.1).
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const width = hidden ? null : sidebarWidth(columns, config.sidebarWidth);
  // Разделителя между сайдбаром и панелью больше нет — его место заняла
  // правая грань сайдбара, нарисованная внутри его собственной ширины (план
  // рамок, задача 5, решение №6).
  const panelLeft = width === null ? 0 : width;
  const panelCols = Math.max(2, columns - panelLeft);
  const panelRows = Math.max(2, rows - 1);
  // Тред справа от панели: пока он докован, гостю остаётся меньше колонок, и
  // PTY узнаёт о них тем же путём, что при ресайзе терминала (разговор
  // агентов, 6.1). Состояние хука нужно раньше самой панели, поэтому вид
  // выбранной сессии он отдаёт отдельно — записи работы здесь ещё нет.
  const thread = useThread({
    panelCols,
    height: panelRows,
    overlayRoom: overlayRoom(rows),
    width: config.threadWidth,
  });
  const bodyCols = thread.docked ? panelCols - thread.width - 1 : panelCols;
  // Рамка панели (план рамок, задача 6) съедает по колонке слева и справа и по
  // строке сверху и снизу; вычитаем её тут же, где уже вычтены колонки дока
  // треда — иначе размер до node-pty не дойдёт, и экран агента поедет.
  //
  // Пол — тот же `MIN_PTY`, что у `pty-session` и у буфера xterm: иначе на
  // терминале в три строки гостю выставлялся бы один размер, а панель
  // показывала бы другой, и его экран ушёл бы в никуда.
  const guestCols = Math.max(MIN_PTY, bodyCols - 2 * PANEL_FRAME);
  const guestRows = Math.max(MIN_PTY, panelRows - 2 * PANEL_FRAME);
  const panel = usePanel({
    projectPath,
    roots,
    cols: guestCols,
    rows: guestRows,
    mouseCapture: config.mouseCapture,
    channel,
    onFail: fail,
    onWarn: warn,
  });

  // Ветка работы: приоритетно из индекса логов, у работы без логов — из `.git/HEAD`.
  const branch = useGitBranch(works);
  const workRows = sidebarWorks(works, {
    projectPath,
    workState: activity.workState,
    index,
    branch,
    pinned,
  });
  const order = useMemo(() => sessionOrders(works), [works]);

  const selection = useSelection({
    works: workRows.map((work) => ({ key: work.key, sessions: order.get(work.key) ?? [] })),
    // Подключение к панели: `unseen` гаснет, событие сессии-источника тоже (4.1, 6).
    onAttach: useAttachSession({ works, markSeen: activity.markSeen, seen, attach: panel.attach }),
  });

  const chosen = works.find(
    (entry) => workKey(entry.projectPath, entry.map.work.id) === selection.work,
  );
  const current = chosen?.map.sessions.find((item) => item.id === selection.session) ?? null;
  const runKey =
    chosen === undefined || current === null
      ? null
      : workRunKey(chosen.projectPath, chosen.map.work.id, current.id);
  const sessionOrder = order.get(selection.work ?? '') ?? [];

  const sidebar = {
    works: workRows,
    sessions: sidebarSessions(chosen, {
      state: activity.stateOf,
      index,
      subagents: (session: WorkSession) => activity.activityOf(session.id)?.subagents ?? 0,
    }),
    selectedWork: selection.work,
    selectedSession: selection.session,
    width: width ?? WIDE,
    height: panelRows,
  };

  // Лента считается только там, где её видно: закрытому треду обход поддерева и
  // перенос всех писем на каждую новую карту ни к чему. Запасник просит свой вид
  // сам, через тот же кэш (6.1).
  const threadPane = thread.docked ? thread.viewOf(chosen, current?.id ?? null) : null;
  // Выбранная сессия исчезла (удалили её или работу) — тред закрывается: без
  // сессии `t` его и не открывает, а док съедал бы колонки под пустую колонку.
  useEffect(() => {
    if (current === null) thread.close();
  }, [current, thread.close]);

  const overlays = useOverlays({
    projectPath,
    prefixName,
    works,
    sessions,
    index,
    log,
    activityOf: activity.activityOf,
    stateOf: activity.stateOf,
    workState: activity.workState,
    entry: chosen,
    session: current,
    runKey,
    order: sessionOrder,
    branch,
    panel,
    selection,
    thread,
    config,
    fromEnv,
    updateConfig,
    pin: (key) => setPinned((current) => new Set([...current, key])),
    push,
    fail,
    exit,
  });

  const actions = useActions({
    prefixByte: ctrlByte(config.prefix) ?? 0x11,
    workRows,
    selection,
    orders: order,
    // Работа вместе с её проектом: сессия ложится в проект записи, а не в
    // проект харнесса — работа могла быть закреплена из чужого (макет 4.2).
    work:
      chosen === undefined ? null : { projectPath: chosen.projectPath, workId: chosen.map.work.id },
    session: current,
    panel,
    overlays,
    thread,
    // Мышь: цели клика берутся из раскладки самого сайдбара (3.3).
    sidebar: width === null ? null : sidebar,
    panelLeft,
    // Без дока панель доходит до края терминала, и правее неё ничего нет (6.3).
    panelRight: panelLeft + bodyCols,
    // Рамка панели: экран гостя начинается на колонку правее и строку ниже,
    // и его координаты мыши надо сдвигать на неё (план рамок, задача 6).
    panelInset: PANEL_FRAME,
    mouseCapture: config.mouseCapture,
    onKey: keyPressed,
    // Уже 60 колонок сайдбара нет вовсе: `b` открывает его оверлеем (решение №9).
    toggleSidebar: () => {
      if (sidebarWidth(columns, config.sidebarWidth) === null) return false;
      setHidden((value) => !value);
      return true;
    },
  });

  // Сессии провайдеров без внешнего id привязываются к логу по cwd и времени.
  useSessionLink({ works, sessions, roots });
  // `pending` от агента поднимается сама, в фоне: панель остаётся у пользователя (5.2).
  useAutoLaunch({
    works,
    loading,
    enabled: config.autoLaunch,
    launch: (project, workId, session) =>
      panel.start(project, workId, session, 'launch', { focus: false }),
  });
  useMapSync({
    works,
    roots,
    index,
    activityOf: activity.activityOf,
    attached: panel.attached,
    held: panel.alive,
    push,
    fail,
  });

  const view = { ...sidebar, navigating: actions.navigating, cursor: actions.cursor };
  // Широкий оверлей ложится и на сайдбар: на этот кадр сайдбар уступает место (§4.0).
  const wide = overlays.kind !== 'sidebar';
  const covers = overlayCovers(overlays.desired, wide, columns, rows, panelLeft);

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        {width !== null && !covers && <Sidebar {...view} />}
        <Box flexDirection="column" flexGrow={1}>
          {overlays.kind === 'sidebar' ? (
            <SidebarOverlay {...view} height={Math.max(3, panelRows - 3)} />
          ) : overlays.kind !== null ? (
            <OverlayHost
              view={overlays.view}
              confirm={overlays.confirm}
              scroll={overlays.scroll}
              focus={overlays.focus}
              columns={columns}
              rows={rows}
              panelLeft={panelLeft}
              onSubmit={overlays.submit}
              onCancel={overlays.close}
            />
          ) : (
            // Панель показывает гостя, пока к ней подключён живой агент, и карточку
            // выбранной сессии, когда гостя нет; ходьба по сайдбару её не трогает (2.2).
            <Panel
              screen={panel.attached === null ? undefined : panel.snapshot}
              card={cardFor(
                chosen,
                current,
                current === null ? 'idle' : activity.stateOf(current),
                prefixName,
                runKey !== null && panel.alive(runKey),
              )}
              width={guestCols}
              height={guestRows}
              navigating={actions.navigating}
            />
          )}
        </Box>
        {/* Модальный оверлей ложится и на тред: док возвращается, закрывшись (6.1). */}
        {thread.docked && overlays.kind === null && (
          <Thread view={threadPane} width={thread.width} height={panelRows} />
        )}
      </Box>

      <StatusBar
        count={status.count}
        event={status.last}
        width={columns}
        prefix={prefixName}
        awaiting={actions.awaiting}
        navigating={actions.navigating}
      />
    </Box>
  );
}
