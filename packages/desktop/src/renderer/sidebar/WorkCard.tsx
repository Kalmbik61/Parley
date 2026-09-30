/**
 * Карточка работы в сайдбаре (кусок 3.3, спека 6.3): заголовок со значком самого срочного состояния и
 * счётчиками писем и комнат, мета и строки сессий. Внимание карточка не считает — его
 * отдаёт общий расчёт (`use-sidebar-sections.ts`), тот же, что упорядочил список.
 *
 * Облик Organic (спека окна 2026-09-29, 1.2): радиус 16, отступ `8 8 8 10`, зазор между карточками 6.
 * Активная — фон `neutral-100` и `shadow-sm`; неактивная под курсором — `--card-hover` (`text 4%`, а не 6% из
 * handoff: решение 2, на 6% `neutral-700` даёт 4.4:1). Строка заголовка 22px: значок самого срочного
 * состояния (в порядке прототипа — ждёт тебя, работает, не просмотрено, сбой, простаивает, не запущена,
 * спит, готово; если в работе ждёт решение — значок вопроса), название 13px (700 при непрочитанной почте
 * или `unseen`, иначе 500), `✉N`, `#N`, время. Полосы внимания слева нет — её роль играет значок.
 * `done`-карточка приглушена правилом `dimmed.css` (значки .6, текст вторичным цветом).
 *
 * `memo` (раунд исправлений 1 куска 3.3, ревью A): `activity.changed` приходит на каждое
 * изменение метрик любой сессии, а `WorkSidebar` отдаёт карточке только срез её сессий,
 * прежний объект внимания и устойчивые колбэки — карточка чужой работы не перерисовывается.
 *
 * Кусок 3.4 (спека 6.4): меню карточки по правой кнопке (`CardMenu`), переименование на
 * месте по двойному клику по заголовку (`InlineRename`), меню комнат по `#` (`RoomsMenu`).
 *
 * Кусок 5 плана «Organic» (спека окна 2026-09-29, 1.2): состав строк — `sort.ts#cardRows`: участник комнаты
 * отдельной строкой не выводится, на его месте стоит строка комнаты (`RoomRow`), комнаты без живых участников — в
 * конце. Под строками активной карточки со статусом `active` — `+ New session or room`: она открывает диалог 1.5
 * (кусок 7) этой работы, как ⌘T и пункт палитры.
 */

import { memo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Hash, Mail, Plus } from 'lucide-react';
import type { SessionLifecycle, WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { roomAwaitsDecision, type WorkAttention } from '../attention/derive.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { useHostSupports } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { displayStatus, dotState, type DotState } from '../lib/dot-state.js';
import { relativeTime } from '../lib/relative-time.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { CardMenu } from './CardMenu.js';
import { InlineRename } from './InlineRename.js';
import { RoomRow } from './RoomRow.js';
import { RoomsMenu } from './RoomsMenu.js';
import { SessionRow } from './SessionRow.js';
import { cardRows } from './sort.js';
import { useCursorStop } from './use-sidebar-keys.js';

export interface WorkCardProps {
  entry: WorkEntry;
  attention: WorkAttention;
  activity: Record<string, ActivityEntry>;
  active: boolean;
  pinned: boolean;
  branch: string | null;
  now: Date;
  /** Выбранная сессия (selectedSessionOf, 2.7), если она в этой работе. */
  selectedSessionId: string | null;
  onActivate(): void;
  onOpenSession(sessionId: string): void;
  /** Клик по ✉N и пункт «Open mail» меню карточки. */
  onOpenMail(): void;
  /** Выбор в RoomsMenu — вкладка room (кусок 3.4). */
  onOpenRoom(roomId: string): void;
  /** Мост для меню карточки, строк и переименования; один на всё окно. */
  bridge: HarnasBridge;
}

/**
 * Порядок срочности значка карточки — как в прототипе handoff: ждёт тебя, работает, не просмотрено, сбой,
 * простаивает, не запущена, спит, готово. Не порядок сайдбара (`attention/derive.ts`): там `unseen`
 * выше `working`.
 */
const URGENCY: readonly DotState[] = ['blocked', 'working', 'unseen', 'failed', 'idle', 'pending', 'exited', 'done'];

/** Значок самого срочного состояния среди живых (не закрытых) сессий; `null` — живых нет. */
function urgentGlyph(
  entry: WorkEntry,
  activity: Record<string, ActivityEntry>,
): { state: DotState; lifecycle: SessionLifecycle } | null {
  let best: { state: DotState; lifecycle: SessionLifecycle; rank: number } | null = null;
  for (const session of entry.map.sessions) {
    if (session.lifecycle === 'closed') continue;
    const ref = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
    const state = dotState(displayStatus(session), activity[ref]?.activity.activity ?? null);
    const rank = URGENCY.indexOf(state);
    if (best === null || rank < best.rank) best = { state, lifecycle: session.lifecycle, rank };
  }
  return best;
}

/**
 * Раскрытые «N more closed» — до конца сеанса окна (спека 6.3). Не состояние карточки:
 * виртуализатор размонтирует карточку за краем списка, и раскрытие пропало бы. Пишет `showClosedSessions`.
 */
const useExpandedClosed = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

/** «N more closed» и «Hide closed» карточки, → и ← клавиатуры сайдбара (кусок 3.4, спека 6.5): закрытые сессии показать или спрятать. */
export function showClosedSessions(key: string, shown: boolean): void {
  useExpandedClosed.setState((state) => {
    if (shown === (state.keys[key] === true)) return state;
    return { keys: shown ? { ...state.keys, [key]: true } : Object.fromEntries(Object.entries(state.keys).filter(([item]) => item !== key)) };
  });
}

/** Имя папки — последний сегмент пути (как заголовок группы, `sort.ts`). */
function folderName(projectPath: string): string {
  return projectPath.split('/').filter((part) => part !== '').at(-1) ?? projectPath;
}

export const WorkCard = memo(function WorkCard({
  entry,
  attention,
  activity,
  active,
  pinned,
  branch,
  now,
  selectedSessionId,
  onActivate,
  onOpenSession,
  onOpenMail,
  onOpenRoom,
  bridge,
}: WorkCardProps): JSX.Element {
  const { projectPath, map } = entry;
  const key = workKey(projectPath, map.work.id);
  const expanded = useExpandedClosed((state) => state.keys[key] === true);
  const [renaming, setRenaming] = useState(false);
  const stop = useCursorStop(key, null, active);
  // Без `works.rename` у хоста нет ни пункта меню, ни двойного клика (спека 3.2).
  const canRename = useHostSupports('works.rename');

  // Колбэк строки — один на сессию на всё время жизни карточки (строка — `memo`), а зовёт
  // он всегда свежий `onOpenSession`.
  const openSession = useRef(onOpenSession);
  openSession.current = onOpenSession;
  const rowOpeners = useRef(new Map<string, () => void>());
  // Колбэки ушедших из карты сессий не копятся (решение контролёра 3 куска 3.4).
  const sessionIds = new Set(map.sessions.map((session) => session.id));
  for (const id of rowOpeners.current.keys()) {
    if (!sessionIds.has(id)) rowOpeners.current.delete(id);
  }
  const openerFor = (sessionId: string): (() => void) => {
    let opener = rowOpeners.current.get(sessionId);
    if (opener === undefined) {
      opener = () => openSession.current(sessionId);
      rowOpeners.current.set(sessionId, opener);
    }
    return opener;
  };

  const tree = treeOrder(map.sessions);
  const closedCount = tree.filter(({ session }) => session.lifecycle === 'closed').length;
  // Строки карточки: сессии и комнаты на месте своих участников; закрытые — только при раскрытом «N more closed».
  const rows = cardRows(map, expanded);
  // «N сессий» — открытые, как в макете спеки 6.3: закрытые считает строка «+N closed».
  const openCount = tree.length - closedCount;

  const bold = attention.unseen > 0 || attention.humanUnread > 0;
  const roomsWithUnread = Object.keys(attention.roomsUnread).length;
  const time = relativeTime(attention.lastEventAt, now);
  // Вторичный текст — свой токен: на активной карточке `--muted-foreground` ниже 4.5:1.
  const secondary = 'text-work-sidebar-muted-foreground';
  // Решение ждёт человека — значок вопроса, как у blocked; правило то же, что у строки комнаты и ранга работы.
  const awaitingDecision = map.rooms.some(roomAwaitsDecision);
  const glyph = awaitingDecision ? { state: 'blocked' as const, lifecycle: 'active' as const } : urgentGlyph(entry, activity);

  return (
    <CardMenu entry={entry} pinned={pinned} bridge={bridge} onRename={() => setRenaming(true)} onOpenMail={onOpenMail}>
    <div
      data-work-key={key}
      data-active={active}
      // Курсор клавиатуры сайдбара — фокус (`use-sidebar-keys.ts`); в порядке Tab — только
      // элемент под курсором (roving tabindex, раунд исправлений 1).
      role="treeitem"
      aria-selected={stop}
      tabIndex={stop ? 0 : -1}
      onClick={(event) => {
        // События меню и диалогов карточки идут из порталов, но всплывают по дереву React —
        // выбор пункта меню не должен заодно активировать работу (кусок 3.4).
        if (event.currentTarget.contains(event.target as Node)) onActivate();
      }}
      className={cn(
        'relative mt-1.5 flex cursor-default flex-col overflow-hidden rounded-md py-2 pl-2.5 pr-2 outline-none focus-visible:ring-1 focus-visible:ring-work-sidebar-focus-ring',
        active ? 'bg-neutral-100 shadow-sm' : 'hover:bg-card-hover',
      )}
      // Показанная архивная (кусок 6.3, спека 6.7) приглушена, как done. Приглушение — styles/dimmed.css:
      // цветом текста, а не opacity всей карточки (ревью M12, WCAG AA).
      {...(map.work.status === 'done' || map.work.status === 'archived' ? { 'data-dimmed': '' } : {})}
    >
      <div className="flex h-[22px] min-w-0 items-center gap-2 pr-1">
        <span data-work-glyph className="inline-flex h-3 w-3 shrink-0 items-center justify-center">
          {glyph === null ? null : <AgentStateDot state={glyph.state} lifecycle={glyph.lifecycle} />}
        </span>
        {renaming ? (
          <InlineRename entry={entry} bridge={bridge} onDone={() => setRenaming(false)} />
        ) : (
          // Обрезает CSS, а не строка: браузер режет по графемам, в DOM название целиком.
          <span
            data-work-title
            onDoubleClick={canRename ? () => setRenaming(true) : undefined}
            className={cn('min-w-0 flex-1 truncate text-[13px] leading-5 text-work-sidebar-foreground', bold ? 'font-bold' : 'font-medium')}
          >
            {map.work.title}
          </span>
        )}
        {attention.humanUnread > 0 ? (
          <button
            type="button"
            title={S.sidebar.unreadMail(attention.humanUnread)}
            aria-label={S.sidebar.unreadMail(attention.humanUnread)}
            onClick={(event) => {
              event.stopPropagation();
              onOpenMail();
            }}
            className="inline-flex shrink-0 items-center gap-[3px] text-[11px] font-semibold text-accent-700 hover:text-accent-800"
          >
            <Mail className="size-3" aria-hidden="true" />
            <span className="tabular-nums">{attention.humanUnread}</span>
          </button>
        ) : null}
        {map.rooms.length > 0 ? (
          <RoomsMenu map={map} onOpenRoom={onOpenRoom}>
            <button
              type="button"
              data-rooms
              aria-label={S.sidebar.roomsMenu}
              title={roomsWithUnread > 0 ? S.sidebar.roomsWithUnread(roomsWithUnread) : S.sidebar.roomsMenu}
              // Клик по `#` — не клик по карточке: меню открывается, работа не переключается.
              onClick={(event) => event.stopPropagation()}
              className={cn('inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold hover:text-work-sidebar-foreground', secondary)}
            >
              <Hash className="size-3" aria-hidden="true" />
              {roomsWithUnread > 0 ? <span className="tabular-nums">{roomsWithUnread}</span> : null}
            </button>
          </RoomsMenu>
        ) : null}
        {pinned ? <span className="shrink-0 text-[10px]">📌</span> : null}
        <span className={cn('min-w-[22px] shrink-0 text-right text-[10px] tabular-nums', secondary)}>{time}</span>
      </div>
      <div
        data-work-meta
        className={cn('flex h-4 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-5 pr-1 text-[11px] leading-4', secondary)}
      >
        <span className="min-w-0 truncate">{folderName(projectPath)}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">{S.sidebar.sessionCount(openCount)}</span>
        {branch !== null ? (
          <>
            <span className="shrink-0">·</span>
            {/* Ветка держит своё место (потолок — половина строки): имя папки то же, что заголовок группы над
                карточкой, и при длинном имени сжимается оно, а не ветка (`main` не должна становиться `m…`). */}
            <span className="max-w-[50%] shrink-0 truncate font-mono">{branch}</span>
          </>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div role="group" className="mt-1.5 flex flex-col gap-px">
          {rows.map((row) =>
            row.kind === 'session' ? (
              <SessionRow
                key={row.session.id}
                workKey={key}
                projectPath={projectPath}
                workId={map.work.id}
                bridge={bridge}
                session={row.session}
                depth={row.depth}
                activity={activity[refKey({ projectPath, workId: map.work.id, sessionId: row.session.id })] ?? null}
                now={now}
                draggable={active}
                selected={row.session.id === selectedSessionId}
                onOpen={openerFor(row.session.id)}
              />
            ) : (
              <RoomRow
                key={`room ${row.room.id}`}
                workKey={key}
                projectPath={projectPath}
                workId={map.work.id}
                bridge={bridge}
                row={row}
                unread={attention.roomsUnread[row.room.id] ?? 0}
                activity={activity}
                now={now}
                active={active}
                selectedSessionId={selectedSessionId}
                onOpen={() => onOpenRoom(row.room.id)}
                openerFor={openerFor}
              />
            ),
          )}
        </div>
      ) : null}
      {closedCount > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            showClosedSessions(key, !expanded);
          }}
          className={cn(
            // Основной цвет на hover — явно: в done-карточке `--work-sidebar-foreground` равен вторичному (dimmed.css).
            'flex h-6 w-full items-center rounded-full pl-7 text-left text-[11px] hover:bg-foreground/6 hover:text-(--color-text)',
            rows.length > 0 ? 'mt-px' : 'mt-1.5',
            secondary,
          )}
        >
          {expanded ? S.sidebar.hideClosed : S.sidebar.moreClosed(closedCount)}
        </button>
      ) : null}
      {active && map.work.status === 'active' ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            // Как ⌘T (`AppShell`, `session.new`): диалог 1.5; работа — эта, она же активная.
            useUiStore.getState().openNewSessionDialog({ projectPath, workId: map.work.id });
          }}
          className={cn(
            // Основной цвет на hover — явно, как у «N more closed» выше: в приглушённом поддереве он равен вторичному.
            'flex h-6 w-full items-center gap-1.5 rounded-full pl-[26px] text-left text-[11px] hover:bg-foreground/6 hover:text-(--color-text)',
            rows.length > 0 || closedCount > 0 ? 'mt-px' : 'mt-1.5',
            secondary,
          )}
        >
          <span className="inline-flex w-[13px] shrink-0 justify-center">
            <Plus className="size-[11px]" aria-hidden="true" />
          </span>
          {S.sidebar.newSessionOrRoom}
        </button>
      ) : null}
    </div>
    </CardMenu>
  );
});
