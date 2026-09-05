/**
 * Композиция TUI v2: сайдбар слева, одна панель справа, строка статуса внизу
 * (дизайн `2026-09-05-tui-v2-design.md`, разделы 2, 3, 5; макеты 1–3).
 *
 * Здесь только связывание: панель со стороны процесса — `use-panel.ts`, её
 * содержимое — `components/panel.tsx`, клавиши — `use-actions.ts`, состояния
 * сессий — `use-activity.ts`, выбор — `use-selection.ts`.
 */

import {
  DEFAULT_CONFIG,
  defaultCodexRoot,
  defaultRoot,
  reconcileMap,
  type ActivityLog,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { Box, useApp } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cardFor, Panel } from './components/panel.js';
import { Sidebar, sidebarSessions, sidebarWidth, sidebarWorks } from './components/sidebar.js';
import { StatusBar } from './components/status-bar.js';
import { workRunKey } from './pty/use-agent-pty.js';
import { useActions } from './use-actions.js';
import { activityWork, useActivity } from './use-activity.js';
import { usePanel } from './use-panel.js';
import { ctrlByte } from './use-prefix-input.js';
import { useSelection } from './use-selection.js';
import { useSessionLink } from './use-session-link.js';
import { useStatus, type StatusEventInit } from './use-status.js';
import { useTerminalSize } from './use-terminal-size.js';
import { useWorks } from './use-works.js';
import { applyAutoTitle, NEW_LABEL } from './work-launch.js';
import { treeOrder, workKey } from './work-rows.js';

/** Префикс харнесса (3.1). Чтение `config.json` придёт вместе с оверлеем справки. */
const PREFIX_BYTE = ctrlByte(DEFAULT_CONFIG.prefix) ?? 0x11;
const PREFIX_NAME = `ctrl+${DEFAULT_CONFIG.prefix}`;

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
  const { works } = useWorks({ projectPath, onEvents: push });

  const byProviderId = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions]);
  const index = useCallback(
    (session: WorkSession): SessionIndex | undefined =>
      session.providerSessionId === null ? undefined : byProviderId.get(session.providerSessionId),
    [byProviderId],
  );
  // Страховка activity: что известно про лог провайдера (4.3).
  const log = useCallback(
    (session: WorkSession): ActivityLog | null => {
      const found = index(session);
      return found === undefined
        ? null
        : { lastRecordAt: found.endedAt, lastUserRecordAt: found.lastUserRecordAt };
    },
    [index],
  );
  const activity = useActivity({ works: works.map(activityWork), log });

  const [hidden, setHidden] = useState(false);
  const width = hidden ? null : sidebarWidth(columns);
  const panelCols = Math.max(2, columns - (width === null ? 0 : width + 1));
  const panelRows = Math.max(2, rows - 1);
  const panel = usePanel({ projectPath, roots, cols: panelCols, rows: panelRows, onFail: fail });

  const workRows = sidebarWorks(works, { projectPath, workState: activity.workState, index });
  const order = useMemo(
    () =>
      new Map(
        works.map((entry) => [
          workKey(entry.projectPath, entry.map.work.id),
          treeOrder(entry.map.sessions).map((item) => item.session.id),
        ]),
      ),
    [works],
  );

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

  const actions = useActions({
    prefixByte: PREFIX_BYTE,
    prefixName: PREFIX_NAME,
    works,
    workRows,
    selection,
    order: order.get(selection.work ?? '') ?? [],
    workId: chosen?.map.work.id ?? null,
    session: current,
    runKey,
    panel,
    // Уже 60 колонок `b` открывает сайдбар оверлеем (2.1, решение №9), а его нет.
    toggleSidebar: () =>
      sidebarWidth(columns) === null
        ? push([{ text: `${PREFIX_NAME} b — оверлей сайдбара ещё не подключён` }])
        : setHidden((value) => !value),
    push,
    exit,
  });

  // Сессии провайдеров без внешнего id привязываются к логу по cwd и времени.
  useSessionLink({ works, sessions, roots });

  // Живость: при старте и на каждое событие watcher карт, без таймера (5.4).
  useEffect(() => {
    for (const entry of works) {
      void reconcileMap(entry.projectPath, entry.map.work.id, roots).catch(() => {});
    }
  }, [works, roots]);

  // Заголовок Claude Code доехал до индекса логов — переименование один раз (5.1).
  useEffect(() => {
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        const title = session.label === NEW_LABEL ? index(session)?.title : null;
        if (title === undefined || title === null) continue;
        void applyAutoTitle(entry.projectPath, entry.map.work.id, session.id, title).catch(fail);
      }
    }
  }, [works, index, fail]);

  // `⚑` при переходе в `blocked` у неподключённой сессии; гаснет при подключении (6).
  const activityOf = activity.activityOf;
  // Подключена та сессия, чей гость на экране, а не та, что выбрана в сайдбаре:
  // ходьба по сайдбару не делает показанную сессию «неподключённой» (макет 1.5).
  const attachedKey = panel.attached;
  const flagged = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>();
    const events: StatusEventInit[] = [];
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        if (activityOf(session.id)?.activity !== 'blocked') continue;
        now.add(session.id);
        const workId = entry.map.work.id;
        if (flagged.current.has(session.id)) continue;
        if (workRunKey(entry.projectPath, workId, session.id) === attachedKey) continue;
        const source = { projectPath: entry.projectPath, workId, sessionId: session.id };
        events.push({ text: `${session.label} ждёт ответа — не подключена`, source });
      }
    }
    flagged.current = now;
    push(events);
  }, [works, activityOf, attachedKey, push]);

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        {width !== null && (
          <Sidebar
            works={workRows}
            sessions={sidebarSessions(chosen, {
              state: activity.stateOf,
              index,
              subagents: (session) => activityOf(session.id)?.subagents ?? 0,
            })}
            selectedWork={selection.work}
            selectedSession={selection.session}
            width={width}
            height={panelRows}
            navigating={actions.navigating}
          />
        )}
        <Box flexDirection="column" flexGrow={1}>
          <Panel
            dialog={actions.dialog}
            onSubmit={() => actions.dialog?.submit()}
            onCancel={actions.cancel}
            screen={live ? panel.snapshot : undefined}
            card={cardFor(
              chosen,
              current,
              current === null ? 'idle' : activity.stateOf(current),
              PREFIX_NAME,
              runKey !== null && panel.alive(runKey),
            )}
            width={panelCols}
            height={panelRows}
          />
        </Box>
      </Box>

      <StatusBar
        count={status.count}
        event={status.last}
        width={columns}
        prefix={PREFIX_NAME}
        awaiting={actions.awaiting}
      />
    </Box>
  );
}
