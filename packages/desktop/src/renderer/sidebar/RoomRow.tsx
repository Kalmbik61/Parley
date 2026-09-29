/**
 * Строка комнаты в карточке работы (кусок 5 плана «Organic», спека окна 2026-09-29, 1.2, 2.6; решения 4, 6, 7).
 * Комната стоит в карточке на месте первого из своих участников (`sort.ts#cardRows`), самих участников отдельными
 * строками карточка не выводит.
 *
 * Облик: radius 14, отступ `4 6 7 {8 + 12·depth}`, зазор 4, 12px. Шапка 18px, зазор 6: значок вопроса 12 (только
 * когда решение ждёт человека, иначе пустое место), Hash 13, название, слово состояния — `decision` (`accent-800`) или
 * `{n} new` (`neutral-800`), шеврон в кнопке 16px (`Show agents` / `Hide agents`), время последнего события. Свёрнутая —
 * значки провайдеров участников (отступ 37, зазор 14): значок 14 и в правом нижнем углу кружок-счётчик, обведённый
 * цветом фона карточки; число — ВСЕ агенты провайдера в комнате, не только запущенные (решение 7), тултип
 * `2 Claude Code agents`. Развёрнутая — строки участников (`SessionRow` с `inRoom`), `★` у ведущего.
 *
 * Фон: решение ждёт — `accent-200`, выбрана — `text 9 %`, развёрнута — `text 4 %` (hover 6 %); подкраска бьёт заливки,
 * как у строки сессии. Вторичный текст на этих заливках держит 4.5:1 не везде: на hover свёрнутой строки в неактивной
 * карточке (заливка карточки и строки складываются) `neutral-700` — 3.86:1 в светлой теме, поэтому там, как у строки
 * сессии, на hover весь текст берёт основной цвет; в развёрнутой комнате внутри неактивной карточки под курсором —
 * 4.25:1, поэтому вторичный текст внутри неё — `neutral-800` (пары — `styles/tokens.test.ts`).
 *
 * Развёрнутость — правило 2.6 (`lib/room-view.ts#roomTabState`: вкладка комнаты или участника показана в активной
 * работе) и ручной шеврон поверх него в `store/ui.ts#roomExpanded`, только в памяти. Клик по строке открывает комнату;
 * клик по уже открытой развёрнутой сворачивает. Строка — узел дерева сайдбара, её берёт курсор клавиатуры
 * (`use-sidebar-keys.ts`): ↑↓, → и ← разворачивают и сворачивают, Enter и пробел открывают.
 */

import { ChevronDown, Hash } from 'lucide-react';
import type { WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { providerName, S } from '../../shared/strings.js';
import { roomAwaitsDecision } from '../attention/derive.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { useLayoutStore } from '../layout/store.js';
import { cn } from '../lib/cn.js';
import { sessionTag } from '../lib/participant.js';
import { relativeTime } from '../lib/relative-time.js';
import { roomKey, roomTabState } from '../lib/room-view.js';
import type { ActivityEntry } from '../store/activity.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { SessionRow } from './SessionRow.js';
import type { CardRoomRow } from './sort.js';
import { useCursorStop } from './use-sidebar-keys.js';

export interface RoomRowProps {
  workKey: string;
  /** Работа строки — для строк участников (меню, перетаскивание); строками, а не ref, как у `SessionRow`. */
  projectPath: string;
  workId: string;
  bridge: HarnasBridge;
  row: CardRoomRow;
  /** Сообщения комнаты, не прочитанные человеком (`WorkAttention.roomsUnread`). */
  unread: number;
  /** Срез активности работы (`WorkCard`): по `refKey` сессии. */
  activity: Record<string, ActivityEntry>;
  now: Date;
  /** Карточка — активная работа: участников можно тащить, обводка счётчиков — цвет активной карточки. */
  active: boolean;
  selectedSessionId: string | null;
  /** Открыть вкладку комнаты. */
  onOpen(): void;
  /** Колбэк строки участника — один на сессию на всё время жизни карточки (`SessionRow` — `memo`). */
  openerFor(sessionId: string): () => void;
}

interface ProviderBadge {
  id: string;
  count: number;
  tip: string;
}

/**
 * Значки свёрнутой комнаты: по провайдеру, число всех его агентов в комнате. Порядок — по id провайдера, а не по
 * порядку участников: набор значков не должен переставляться от того, кто в комнате записан первым.
 */
function providerBadges(sessions: readonly WorkSession[], known: ReadonlyArray<{ id: string; label: string }>): ProviderBadge[] {
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en-US'))
    .map(([id, count]) => ({
      id,
      count,
      tip: S.sidebar.roomAgents(count, providerName(id, known.find((provider) => provider.id === id)?.label ?? '')),
    }));
}

export function RoomRow({
  workKey,
  projectPath,
  workId,
  bridge,
  row,
  unread,
  activity,
  now,
  active,
  selectedSessionId,
  onOpen,
  openerFor,
}: RoomRowProps): JSX.Element {
  const { room } = row;
  const stateKey = roomKey(workKey, room.id);
  const providers = useProvidersStore((state) => state.providers);
  const override = useUiStore((state) => state.roomExpanded[stateKey]);
  const setRoomExpanded = useUiStore((state) => state.setRoomExpanded);
  // Строка примитивом (`'selected' | 'open' | null`): селектор не перерисовывает строку на каждое изменение раскладки.
  const sessionIds = row.sessions.map((session) => session.id);
  const tab = useLayoutStore((state) => (state.activeWorkKey === workKey ? roomTabState(state.layouts[workKey], room.id, sessionIds) : null));
  const stop = useCursorStop(workKey, null, false, room.id);

  const selected = tab === 'selected';
  const expanded = override ?? tab !== null;
  const pending = roomAwaitsDecision(room);
  const bold = selected || unread > 0 || pending;
  const word = pending ? S.sidebar.roomDecision : unread > 0 ? S.sidebar.roomNew(unread) : '';
  const title = room.title === '' ? S.rooms.fallbackTitle : room.title;
  const tooltip = S.sidebar.roomTooltip(
    row.lead === null ? null : sessionTag(row.lead),
    row.sessions.map((session) => sessionTag(session.id)),
  );
  const badges = providerBadges(row.sessions, providers);
  // Обводка счётчика — цвет фона карточки, чтобы кружок читался поверх значка (активная карточка — `neutral-100`).
  const ring = active ? 'shadow-[0_0_0_1.5px_var(--color-neutral-100)]' : 'shadow-[0_0_0_1.5px_var(--color-surface)]';

  // Клик по строке: развернуть и открыть; по уже открытой развёрнутой — свернуть (спека 2.6). Шеврон — только развернуть.
  const activate = (): void => {
    setRoomExpanded(stateKey, !(selected && expanded));
    onOpen();
  };

  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={stop}
      tabIndex={stop ? 0 : -1}
      data-room-row={room.id}
      data-selected={selected}
      onClick={(event) => {
        // Клик по строке — не клик по карточке: карточка сделала бы только работу активной. Клики из порталов меню
        // участников всплывают сюда по дереву React — это не клик по строке комнаты.
        event.stopPropagation();
        if (event.currentTarget.contains(event.target as Node)) activate();
      }}
      onKeyDown={(event) => {
        // Клавиши участников и меню — их собственные обработчики; здесь только сама строка.
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      style={{ paddingLeft: `${8 + row.depth * 12}px` }}
      className={cn(
        // Кольцо внутрь: карточка режет выступающее (`overflow-hidden`).
        'flex min-w-0 cursor-default flex-col gap-1 rounded-[14px] pb-[7px] pr-1.5 pt-1 text-xs text-work-sidebar-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-work-sidebar-focus-ring',
        // Подкраска бьёт выбор и развёрнутость и не бледнеет под курсором — как у строки сессии.
        pending
          ? 'bg-accent-200 hover:bg-accent-200'
          : selected
            ? 'bg-work-sidebar-accent hover:bg-work-sidebar-accent'
            : expanded
              ? 'bg-foreground/4 hover:bg-foreground/6'
              : 'hover:bg-work-sidebar-accent',
        expanded
          ? '[--work-sidebar-muted-foreground:var(--color-neutral-800)]'
          : !pending &&
              !selected &&
              'hover:[--work-sidebar-foreground:var(--color-text)] hover:[--work-sidebar-muted-foreground:var(--color-text)]',
      )}
    >
      <div title={tooltip} className="flex h-[18px] items-center gap-1.5">
        {pending ? <AgentStateDot state="blocked" lifecycle="active" /> : <span className="inline-block size-3 shrink-0" />}
        <Hash className="size-[13px] shrink-0 text-work-sidebar-muted-foreground" aria-hidden="true" />
        <span className={cn('min-w-0 flex-1 truncate', bold ? 'font-bold' : 'font-normal')}>{title}</span>
        {word === '' ? null : <span className={cn('shrink-0 text-[11px]', pending ? 'text-accent-800' : 'text-neutral-800')}>{word}</span>}
        <button
          type="button"
          // Шеврон открывается стрелками на самой строке (→ и ←); в порядок Tab он не входит, как остальные строки списка.
          tabIndex={-1}
          title={expanded ? S.sidebar.hideAgents : S.sidebar.showAgents}
          aria-label={expanded ? S.sidebar.hideAgents : S.sidebar.showAgents}
          onClick={(event) => {
            event.stopPropagation();
            setRoomExpanded(stateKey, !expanded);
          }}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-work-sidebar-muted-foreground hover:bg-foreground/10"
        >
          <ChevronDown className={cn('size-[13px]', !expanded && '-rotate-90')} aria-hidden="true" />
        </button>
        <span className="w-[22px] shrink-0 text-right text-[10px] tabular-nums text-work-sidebar-muted-foreground">
          {relativeTime(row.lastAt, now)}
        </span>
      </div>
      {!expanded && badges.length > 0 ? (
        <div className="flex items-center gap-3.5 pl-[37px]">
          {badges.map((badge) => (
            <span key={badge.id} data-provider-badge={badge.id} title={badge.tip} className="relative inline-flex size-[14px] shrink-0">
              <AgentIcon provider={badge.id} size={14} label={badge.tip} />
              <span
                data-provider-count
                className={cn(
                  'absolute left-[9px] top-[8px] box-border h-3 min-w-3 rounded-full bg-neutral-300 px-[3px] text-center text-[9px] font-bold leading-3 text-(--color-text)',
                  ring,
                )}
              >
                {badge.count}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {expanded && row.members.length > 0 ? (
        <div role="group" className="mt-0.5 flex flex-col gap-px">
          {row.members.map((session) => (
            <SessionRow
              key={session.id}
              workKey={workKey}
              projectPath={projectPath}
              workId={workId}
              bridge={bridge}
              session={session}
              depth={0}
              activity={activity[refKey({ projectPath, workId, sessionId: session.id })] ?? null}
              now={now}
              draggable={active}
              selected={session.id === selectedSessionId}
              onOpen={openerFor(session.id)}
              inRoom
              lead={session.id === row.lead}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
