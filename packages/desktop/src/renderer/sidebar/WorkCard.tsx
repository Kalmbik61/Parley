/**
 * Карточка работы в сайдбаре (кусок 3.3, спека 6.3): полоса внимания, заголовок со
 * счётчиками писем и комнат, мета и строки сессий. Внимание карточка не считает — его
 * отдаёт общий расчёт (`use-sidebar-sections.ts`), тот же, что упорядочил список.
 *
 * `memo` (раунд исправлений 1 куска 3.3, ревью A): `activity.changed` приходит на каждое
 * изменение метрик любой сессии, а `WorkSidebar` отдаёт карточке только срез её сессий,
 * прежний объект внимания и устойчивые колбэки — карточка чужой работы не перерисовывается.
 *
 * Кусок 3.4 (спека 6.4): меню карточки по правой кнопке (`CardMenu`), переименование на
 * месте по двойному клику по заголовку (`InlineRename`), меню комнат по `#` (`RoomsMenu`).
 */

import { memo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import type { Attention, WorkAttention } from '../attention/derive.js';
import { useHostSupports } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { relativeTime } from '../lib/relative-time.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';
import { CardMenu } from './CardMenu.js';
import { InlineRename } from './InlineRename.js';
import { RoomsMenu } from './RoomsMenu.js';
import { SessionRow } from './SessionRow.js';

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

/** Полоса слева — по самому срочному состоянию (спека 6.3); при «простаивает» её нет. */
const STRIP: Partial<Record<Attention, string>> = {
  'needs-you': 'bg-orange-500',
  working: 'bg-yellow-500',
  unseen: 'bg-emerald-500',
};

/**
 * Раскрытые «+N closed» — до конца сеанса окна (спека 6.3). Не состояние карточки:
 * виртуализатор размонтирует карточку за краем списка, и раскрытие пропало бы.
 */
const useExpandedClosed = create<{ keys: Record<string, true>; expand: (key: string) => void }>((set) => ({
  keys: {},
  expand: (key) => set((state) => ({ keys: { ...state.keys, [key]: true } })),
}));

/** → и ← клавиатуры сайдбара (кусок 3.4, спека 6.5): закрытые сессии карточки показать или спрятать. */
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
  const expand = useExpandedClosed((state) => state.expand);
  const [renaming, setRenaming] = useState(false);
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

  const rows = treeOrder(map.sessions);
  const closedCount = rows.filter(({ session }) => session.lifecycle === 'closed').length;
  const shownRows = expanded ? rows : rows.filter(({ session }) => session.lifecycle !== 'closed');
  // «N сессий» — открытые, как в макете спеки 6.3: закрытые считает строка «+N closed».
  const openCount = rows.length - closedCount;

  const strip = STRIP[attention.level];
  const bold = attention.unseen > 0 || attention.humanUnread > 0;
  const roomsWithUnread = Object.keys(attention.roomsUnread).length;
  const time = relativeTime(attention.lastEventAt, now);
  // Вторичный текст — свой токен: на активной карточке `--muted-foreground` ниже 4.5:1.
  const secondary = 'text-work-sidebar-muted-foreground';

  return (
    <CardMenu entry={entry} pinned={pinned} bridge={bridge} onRename={() => setRenaming(true)} onOpenMail={onOpenMail}>
    <div
      data-work-key={key}
      data-active={active}
      // Курсор клавиатуры сайдбара — фокус (`use-sidebar-keys.ts`); в порядок Tab карточка не входит.
      tabIndex={-1}
      onClick={(event) => {
        // События меню и диалогов карточки идут из порталов, но всплывают по дереву React —
        // выбор пункта меню не должен заодно активировать работу (кусок 3.4).
        if (event.currentTarget.contains(event.target as Node)) onActivate();
      }}
      className={cn(
        'relative mb-1.5 cursor-default overflow-hidden rounded-lg border py-1 pl-2.5 pr-1.5 outline-none focus-visible:ring-1 focus-visible:ring-work-sidebar-ring',
        active
          ? 'border-work-sidebar-border bg-[color-mix(in_srgb,var(--work-sidebar-foreground)_8%,transparent)] shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-[color-mix(in_srgb,var(--work-sidebar-foreground)_10%,transparent)]'
          : 'border-transparent hover:bg-work-sidebar-accent/40',
        map.work.status === 'done' && 'opacity-60',
      )}
    >
      {strip !== undefined ? (
        <span data-attention-strip aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', strip)} />
      ) : null}
      <div className="flex h-5 min-w-0 items-center gap-1.5">
        {renaming ? (
          <InlineRename entry={entry} bridge={bridge} onDone={() => setRenaming(false)} />
        ) : (
          // Обрезает CSS, а не строка: браузер режет по графемам, в DOM название целиком.
          <span
            data-work-title
            onDoubleClick={canRename ? () => setRenaming(true) : undefined}
            className={cn('min-w-0 flex-1 truncate text-[13px] leading-5 text-work-sidebar-foreground', bold && 'font-semibold')}
          >
            {map.work.title}
          </span>
        )}
        {attention.humanUnread > 0 ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenMail();
            }}
            className="shrink-0 rounded px-0.5 text-[11px] text-work-sidebar-foreground hover:bg-work-sidebar-accent"
          >
            {`✉${attention.humanUnread}`}
          </button>
        ) : null}
        {map.rooms.length > 0 ? (
          <RoomsMenu map={map} onOpenRoom={onOpenRoom}>
            <button
              type="button"
              data-rooms
              aria-label={S.sidebar.roomsMenu}
              // Клик по `#` — не клик по карточке: меню открывается, работа не переключается.
              onClick={(event) => event.stopPropagation()}
              className="shrink-0 rounded px-0.5 text-[11px] text-work-sidebar-foreground hover:bg-work-sidebar-accent"
            >
              {roomsWithUnread > 0 ? `#${roomsWithUnread}` : '#'}
            </button>
          </RoomsMenu>
        ) : null}
        {pinned ? <span className="shrink-0 text-[10px]">📌</span> : null}
        {time !== '' ? <span className={cn('shrink-0 text-[10px] tabular-nums', secondary)}>{time}</span> : null}
      </div>
      <div data-work-meta className={cn('flex h-4 min-w-0 items-center gap-1 text-[11px] leading-4', secondary)}>
        <span className="min-w-0 truncate">{folderName(projectPath)}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">{S.sidebar.sessionCount(openCount)}</span>
        {branch !== null ? (
          <>
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate font-mono">{branch}</span>
          </>
        ) : null}
      </div>
      {shownRows.length > 0 ? (
        <div className="mt-0.5">
          {shownRows.map(({ session, depth }) => (
            <SessionRow
              key={session.id}
              workKey={key}
              projectPath={projectPath}
              workId={map.work.id}
              bridge={bridge}
              session={session}
              depth={depth}
              activity={activity[refKey({ projectPath, workId: map.work.id, sessionId: session.id })] ?? null}
              now={now}
              draggable={active}
              selected={session.id === selectedSessionId}
              onOpen={openerFor(session.id)}
            />
          ))}
        </div>
      ) : null}
      {!expanded && closedCount > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            expand(key);
          }}
          className={cn('flex h-6 w-full items-center rounded-md px-1.5 text-left text-[11px] hover:bg-work-sidebar-accent/60', secondary)}
        >
          {S.sidebar.moreClosed(closedCount)}
        </button>
      ) : null}
    </div>
    </CardMenu>
  );
});
