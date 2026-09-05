/**
 * Композиция TUI v2: сайдбар слева, одна панель справа, строка статуса внизу
 * (дизайн `2026-09-05-tui-v2-design.md`, разделы 2, 3, 5; макеты 1–4).
 *
 * Здесь только связывание: панель со стороны процесса — `use-panel.ts`, её
 * содержимое — `components/panel.tsx`, клавиши — `use-actions.ts`, оверлеи —
 * `use-overlays.ts`, состояния сессий — `use-activity.ts`, выбор —
 * `use-selection.ts`, синхронизация карт — `use-map-sync.ts`.
 */

import { defaultCodexRoot, defaultRoot, type SessionIndex, type WorkSession } from '@harnas/core';
import { Box, useApp } from 'ink';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { overlayBox, OverlayHost } from './components/overlay.js';
import { cardFor, Panel } from './components/panel.js';
import {
  Sidebar,
  SidebarOverlay,
  sidebarSessions,
  sidebarWidth,
  sidebarWorks,
  WIDE,
} from './components/sidebar.js';
import { StatusBar } from './components/status-bar.js';
import { workRunKey } from './pty/use-agent-pty.js';
import { useActions } from './use-actions.js';
import { activityWork, useActivity } from './use-activity.js';
import { useConfig } from './use-config.js';
import { useLogIndex } from './use-log-index.js';
import { useMapSync } from './use-map-sync.js';
import { useOverlays } from './use-overlays.js';
import { usePanel } from './use-panel.js';
import { ctrlByte } from './use-prefix-input.js';
import { useSelection } from './use-selection.js';
import { useSessionLink } from './use-session-link.js';
import { useStatus } from './use-status.js';
import { useTerminalSize } from './use-terminal-size.js';
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
  const push = status.push;
  const fail = useCallback(
    (reason: unknown) =>
      push([{ text: reason instanceof Error ? reason.message : String(reason) }]),
    [push],
  );
  const config = useConfig(push);
  const prefixName = `ctrl+${config.prefix}`;
  const { works } = useWorks({ projectPath, onEvents: push });

  const { index, log } = useLogIndex(sessions);
  const activity = useActivity({
    works: works.map(activityWork),
    log,
    silenceThresholdMs: config.silenceThresholdMs,
  });

  const [hidden, setHidden] = useState(false);
  // Работы чужих проектов, выбранные пикером, живут в сайдбаре до выхода (2.1).
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const width = hidden ? null : sidebarWidth(columns, config.sidebarWidth);
  const panelLeft = width === null ? 0 : width + 1;
  const panelCols = Math.max(2, columns - panelLeft);
  const panelRows = Math.max(2, rows - 1);
  const panel = usePanel({ projectPath, roots, cols: panelCols, rows: panelRows, onFail: fail });

  const workRows = sidebarWorks(works, {
    projectPath,
    workState: activity.workState,
    index,
    pinned,
  });
  const order = useMemo(() => sessionOrders(works), [works]);

  const markSeen = activity.markSeen;
  const seen = status.seen;
  const attach = panel.attach;
  // Подключение к панели: `unseen` гаснет, событие сессии-источника тоже (4.1, 6).
  const onAttach = useCallback(
    (sessionId: string) => {
      markSeen(sessionId);
      const entry = works.find((item) => item.map.sessions.some((s) => s.id === sessionId));
      if (entry === undefined) return;
      const workId = entry.map.work.id;
      seen({ projectPath: entry.projectPath, workId, sessionId });
      attach(workRunKey(entry.projectPath, workId, sessionId));
    },
    [works, markSeen, seen, attach],
  );
  const selection = useSelection({
    works: workRows.map((work) => ({ key: work.key, sessions: order.get(work.key) ?? [] })),
    onAttach,
  });

  const chosen = works.find(
    (entry) => workKey(entry.projectPath, entry.map.work.id) === selection.work,
  );
  const current = chosen?.map.sessions.find((item) => item.id === selection.session) ?? null;
  const runKey =
    chosen === undefined || current === null
      ? null
      : workRunKey(chosen.projectPath, chosen.map.work.id, current.id);
  // Панель показывает гостя, пока к ней подключён живой агент; карточка выбранной
  // сессии — только когда гостя нет (2.2). В режиме навигации гость остаётся на
  // экране: ходьба по сайдбару панель не трогает (макет 1.5).
  const live = panel.attached !== null;
  const sessionOrder = order.get(selection.work ?? '') ?? [];

  const overlays = useOverlays({
    projectPath,
    prefixName,
    works,
    sessions,
    index,
    activityOf: activity.activityOf,
    stateOf: activity.stateOf,
    workState: activity.workState,
    entry: chosen,
    session: current,
    runKey,
    order: sessionOrder,
    panel,
    selection,
    pin: (key) => setPinned((current) => new Set([...current, key])),
    push,
    fail,
    exit,
  });

  const actions = useActions({
    prefixByte: ctrlByte(config.prefix) ?? 0x11,
    workRows,
    selection,
    order: sessionOrder,
    workId: chosen?.map.work.id ?? null,
    session: current,
    panel,
    overlays,
    // Уже 60 колонок сайдбара нет вовсе: `b` открывает его оверлеем (решение №9).
    toggleSidebar: () => {
      if (sidebarWidth(columns, config.sidebarWidth) === null) return false;
      setHidden((value) => !value);
      return true;
    },
  });

  // Сессии провайдеров без внешнего id привязываются к логу по cwd и времени.
  useSessionLink({ works, sessions, roots });
  useMapSync({
    works,
    roots,
    index,
    activityOf: activity.activityOf,
    attached: panel.attached,
    push,
    fail,
  });

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
    navigating: actions.navigating,
  };
  // Широкий оверлей ложится и на сайдбар: рисовать его stock Ink не умеет,
  // поэтому на этот кадр сайдбар уступает место (§4.0).
  const covers =
    overlays.desired !== null &&
    overlays.kind !== 'sidebar' &&
    overlayBox(overlays.desired, columns, rows, panelLeft, 0).wide;

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        {width !== null && !covers && <Sidebar {...sidebar} />}
        <Box flexDirection="column" flexGrow={1}>
          {overlays.kind === 'sidebar' ? (
            <SidebarOverlay {...sidebar} height={Math.max(3, panelRows - 3)} />
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
            <Panel
              screen={live ? panel.snapshot : undefined}
              card={cardFor(
                chosen,
                current,
                current === null ? 'idle' : activity.stateOf(current),
                prefixName,
                runKey !== null && panel.alive(runKey),
              )}
              width={panelCols}
              height={panelRows}
            />
          )}
        </Box>
      </Box>

      <StatusBar
        count={status.count}
        event={status.last}
        width={columns}
        prefix={prefixName}
        awaiting={actions.awaiting}
      />
    </Box>
  );
}
