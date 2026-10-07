/**
 * Строка сессии в карточке работы (кусок 3.3, спека 4.2, 6.3): значок состояния, значок
 * агента, `S02 исполнитель`, слово состояния, значок ветки своего worktree и время последнего
 * события. Тултип — задача, сводка агента, итог, модель и метрики.
 *
 * Облик Organic (спека окна 2026-09-29, 1.2): пилюля 26px, отступ слева `8 + 12·depth`, зазор 6, 12px;
 * значок состояния 12, значок агента 13, слово 11px строчными, GitBranch 11 (тултип `Own worktree ·
 * {branch}`), время 10px шириной 22. Фон: `blocked` — `accent-200` (слово `accent-800`), `unseen` —
 * `accent-2-200` (слово `accent-2-800`), иначе выбранная и hover — `text 9%`; подкраска бьёт выбор. Выбранная —
 * вес 700. Закрытая — `data-dimmed="row"`: значки .5 при правиле `dimmed.css`. На hover весь текст строки —
 * основной цвет (наследство куска 1: `neutral-700` на заливке hover ниже 4.5:1). Оба цвета задаются явно
 * (`--color-text`): в приглушённом поддереве (done-карточка, закрытая строка) основной цвет сайдбара уже
 * равен вторичному, и подмена «вторичный := основной» на hover ничего не меняла (правки ревью куска 2).
 *
 * Перетаскивание — контракт 2.6, как у строки прежнего дерева сессий: `DndContext`
 * один на окно (`AppShell`), тащатся только строки активной работы (спека 6.4) — у
 * остальных активатор выключен и курсор `not-allowed`. Атрибуты @dnd-kit (`role`,
 * `tabIndex`, `aria-*`) не ставятся: строка уже кнопка со своей ролью. HTML5-атрибута
 * `draggable` нет — тащит @dnd-kit по указателю.
 *
 * Меню по правой кнопке — `SessionRowMenu` (кусок 3.4): его триггер и триггер тултипа
 * сливаются на одном узле строки.
 *
 * Строка вне комнаты — ещё и цель броска другой сессии (кусок 7, 2.5): сессия на сессию — диалог «New room» из двух
 * сессий. Цель подсвечивается, только если бросок возможен (`use-drop-target.ts`); участника комнаты принимает строка
 * комнаты целиком.
 *
 * Участник развёрнутой комнаты (кусок 5, спека окна 2026-09-29, 1.2) — та же строка, но с отступом слева 18 и без
 * правого поля (его даёт строка комнаты, `RoomRow.tsx`); у ведущего после названия `★` 11px `accent-700`,
 * тултип `Lead`.
 *
 * Живые субагенты (`metrics.tasks`, кусок 4b плана 2026-10-01) — бейдж «2 agents» с поповером перед словом состояния
 * (`AgentsBadge`): строка поповера открывает сессию на карточке агента. Хост прежней версии списка не присылает —
 * тогда у строки бейджа нет, а счётчик `▤N` остаётся в тултипе, как был.
 */

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { GitBranch } from 'lucide-react';
import { useDndContext, useDraggable } from '@dnd-kit/core';
import type { WorkSession } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { sessionAttention } from '../attention/derive.js';
import { openAgentCard } from '../chat/open-agent.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentsBadge } from '../components/AgentsBadge.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { dndId, type DragSourceData } from '../layout/dnd.js';
import { RoleChip } from '../lib/role-summary.js';
import { cn } from '../lib/cn.js';
import { displayStatus, dotState, stateWord } from '../lib/dot-state.js';
import { formatMetricsLine } from '../lib/metrics-line.js';
import { sessionRowLabel } from '../lib/participant.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { relativeTime } from '../lib/relative-time.js';
import type { ActivityEntry } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card.js';
import { SessionRowMenu } from './SessionRowMenu.js';
import { DROP_TARGET_FILL, DROP_TARGET_INK, useSidebarDropTarget } from './use-drop-target.js';
import { useCursorStop } from './use-sidebar-keys.js';

/** Сколько символов задачи показывает тултип (план 3.3). */
const TASK_PREVIEW = 300;

/** Событие `eventAt` строго позже момента `at`; нет времени или оно не разбирается — нет. */
function eventAfter(eventAt: string | null, at: string | undefined): boolean {
  if (eventAt === null || at === undefined) return false;
  const event = Date.parse(eventAt);
  const notice = Date.parse(at);
  return !Number.isNaN(event) && !Number.isNaN(notice) && event > notice;
}

export interface SessionRowProps {
  workKey: string;
  /** Работа строки — для меню (кусок 3.4); строки, а не ref, чтобы `memo` не сбивался. */
  projectPath: string;
  workId: string;
  bridge: ParleyBridge;
  session: WorkSession;
  depth: number;
  activity: ActivityEntry | null;
  now: Date;
  /** Работа строки активна: только тогда строку можно тащить (спека 6.4). */
  draggable: boolean;
  selected: boolean;
  onOpen(): void;
  /** Строка участника комнаты: отступ слева 18 вместо `8 + 12·depth`, без правого поля. */
  inRoom?: boolean;
  /** Комната участника — для «Make lead» в меню строки; только у участника комнаты. */
  roomId?: string;
  /** Ведущий комнаты — `★` после названия; только у участника комнаты. */
  lead?: boolean;
}

// `memo`: строка перерисовывается, только когда сменились её сессия, её запись активности
// (стор активности заменяет лишь изменённую запись) или её флаги (раунд исправлений 1 куска 3.3).
export const SessionRow = memo(function SessionRow({
  workKey,
  projectPath,
  workId,
  bridge,
  session,
  depth,
  activity,
  now,
  draggable,
  selected,
  onOpen,
  inRoom = false,
  roomId,
  lead = false,
}: SessionRowProps): JSX.Element {
  const data: DragSourceData = { item: { kind: 'session', sessionId: session.id } };
  const dragId = dndId.session(workKey, session.id);
  const { setNodeRef, listeners } = useDraggable({ id: dragId, data, disabled: !draggable });
  // Цель броска другой сессии (2.5, диалог 1.6): только строка вне комнаты — участника принимает строка комнаты целиком.
  const { setNodeRef: setDropRef, over } = useSidebarDropTarget(workKey, { kind: 'session-row', sessionId: session.id }, !inRoom);
  const stop = useCursorStop(workKey, session.id, false);

  // Тултип под своим управлением (раунд исправлений 1 куска 3.3, ревью B, находка 1): после
  // перетаскивания соседней строки наведение показывало тултип перетащенной. Строка —
  // фокусируемая (`tabIndex`), pointerdown в браузере её фокусирует, а Radix открывает карточку и по
  // фокусу; фокус остаётся на перетащенной строке и после броска, а открытая карточка
  // держится после отпускания, если в документе есть выделение (`hasSelectionRef`).
  // Поэтому во время любого перетаскивания тултипы строк закрыты, после броска тоже закрыты,
  // а перетаскиваемая строка теряет фокус.
  const { active } = useDndContext();
  const dragging = active !== null;
  const draggingThis = active?.id === dragId;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Поповер агентов открыт — тултип строки не нужен: оба встают справа от строки и закрыли бы друг друга.
  const [agentsOpen, setAgentsOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      setNodeRef(node);
      setDropRef(node);
    },
    [setNodeRef, setDropRef],
  );
  // Раунд исправлений 2: таймер открытия Radix (openDelay) стартует на pointerenter ещё до
  // порога перетаскивания, а pointerleave, который его отменил бы, глотает захват указателя
  // @dnd-kit — таймер срабатывает уже после броска, когда указатель над соседней строкой.
  // Поэтому запрос Radix открыть принимается, только если сейчас нет перетаскивания, после
  // последнего перетаскивания указатель заново входил в строку (или её заново фокусировали),
  // и строка действительно под указателем или в фокусе.
  const staleRef = useRef(false);
  useEffect(() => {
    setTooltipOpen(false);
    if (dragging) staleRef.current = true;
    if (draggingThis && rowRef.current !== null && document.activeElement === rowRef.current) rowRef.current.blur();
  }, [dragging, draggingThis]);
  const onTooltipOpenChange = (open: boolean): void => {
    if (!open) {
      setTooltipOpen(false);
      return;
    }
    const node = rowRef.current;
    if (dragging || staleRef.current || node === null) return;
    if (node.matches(':hover') || document.activeElement === node) setTooltipOpen(true);
  };
  const freshIntent = (): void => {
    if (!dragging) staleRef.current = false;
  };

  // trust-wait (спека 8.3, план worktree 4.3) — то же правило, что было у прежнего дерева сессий:
  // пометка держится, пока в последних уведомлениях есть trust-wait по этой сессии.
  const waitNotice = useNoticesStore((state) => {
    // Codex, не показавший статус за срок после запуска (`startup-wait`), помечается так же, но с
    // другим тултипом: ждёт входа или доверия к папке, а не «молчит» (спека комнат, 3.6).
    const found = state.notices.find(
      (notice) =>
        (notice.kind === 'trust-wait' || notice.kind === 'startup-wait') &&
        notice.ref !== null &&
        notice.ref.sessionId === session.id &&
        workKeyOf(notice.ref.projectPath, notice.ref.workId) === workKey,
    );
    return found ?? null;
  });

  const live = activity?.activity ?? null;
  // У `startup-wait` хост состояние знает: сессия ушла с экрана старта, когда пришёл известный сигнал Codex
  // (`Ready`, `Working`, вопрос) — событие новее уведомления (у самого уведомления время синтетического «нужен
  // ты»). Пометка «may need sign-in» рядом с работающей сессией — ложная, хотя уведомление ещё в буфере из 20.
  // `trust-wait` состояния не знает: он снимается только уходом уведомления из буфера.
  const startupResolved =
    waitNotice?.kind === 'startup-wait' && eventAfter(live?.lastEventAt ?? null, waitNotice.at);
  const waitKind = startupResolved ? null : (waitNotice?.kind ?? null);
  const trustWait = waitKind !== null;
  const state = dotState(displayStatus(session), live?.activity ?? null);
  const word = stateWord(state, session.lifecycle);
  const attention = sessionAttention(session, live);
  const closed = session.lifecycle === 'closed';
  const label = sessionRowLabel(session.id, session.label);
  const lastEventAt = live?.lastEventAt ?? session.resultAt ?? session.startedAt;
  const time = lastEventAt === null ? '' : relativeTime(lastEventAt, now);
  // Вторичный текст на подсвеченной и выбранной строке — свой токен: `--muted-foreground`
  // там ниже 4.5:1 (tokens.test.ts, тест 14).
  const secondary = 'text-work-sidebar-muted-foreground';
  const blocked = attention === 'needs-you';
  const unseen = attention === 'unseen';
  // Живые субагенты — бейдж с поповером (кусок 4b); хост прежней версии списка не присылает, и счётчик `▤N` остаётся в
  // тултипе. Метрики спящей и закрытой сессии — след прошлого процесса: у них агентов нет, как и на карточке участника комнаты.
  const agents = session.lifecycle === 'active' ? (activity?.metrics?.tasks ?? []) : [];
  // Последний агент закончил при открытом поповере — бейдж ушёл вместе с ним и «закрыто» не сообщил: без сброса тултип
  // строки остался бы спрятан насовсем.
  useEffect(() => {
    if (agents.length === 0) setAgentsOpen(false);
  }, [agents.length]);

  return (
    <HoverCard open={tooltipOpen && !dragging && !agentsOpen} onOpenChange={onTooltipOpenChange} openDelay={600} closeDelay={100}>
      <SessionRowMenu
        workKey={workKey}
        projectPath={projectPath}
        workId={workId}
        session={session}
        bridge={bridge}
        onOpen={onOpen}
        {...(roomId === undefined ? {} : { room: { id: roomId, lead } })}
      >
      <HoverCardTrigger asChild>
        <div
          ref={setRowRef}
          // Строка — узел дерева сайдбара; в порядке Tab — только под курсором (roving
          // tabindex, раунд исправлений 1): иначе Tab шёл по всем строкам всех карточек.
          role="treeitem"
          aria-selected={stop}
          tabIndex={stop ? 0 : -1}
          data-session-id={session.id}
          data-selected={selected}
          {...(draggable ? { 'data-draggable': '' } : {})}
          {...(over ? { 'data-drop-over': '' } : {})}
          onPointerDown={listeners?.onPointerDown as ((event: PointerEvent<HTMLDivElement>) => void) | undefined}
          onPointerEnter={freshIntent}
          onFocus={freshIntent}
          onClick={(event) => {
            // Клик по строке — не клик по карточке: карточка сделала бы только работу активной.
            event.stopPropagation();
            // Клик и клавиши из порталов меню и диалогов строки всплывают по дереву React
            // сюда же — это не клик по строке (кусок 3.4).
            if (event.currentTarget.contains(event.target as Node)) onOpen();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (!event.currentTarget.contains(event.target as Node)) return;
            event.preventDefault();
            event.stopPropagation();
            onOpen();
          }}
          style={{ paddingLeft: inRoom ? '18px' : `${8 + depth * 12}px` }}
          className={cn(
            // Кольцо внутрь: карточка режет выступающее (`overflow-hidden`).
            'flex h-[26px] min-w-0 items-center gap-1.5 rounded-full text-xs text-work-sidebar-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-work-sidebar-focus-ring',
            inRoom ? 'pr-0' : 'pr-1.5',
            // Текст строки на hover — основной цвет: `neutral-700` на заливке hover ниже 4.5:1. Явный `--color-text`, а не
            // подмена одной переменной другой: внутри `[data-dimmed]` они равны, а на самой закрытой строке
            // неслойное правило `dimmed.css` бьёт утилиту по `--work-sidebar-foreground` и сводит его к
            // вторичному, который на hover — основной текст (цепочка без петли).
            'hover:[--work-sidebar-foreground:var(--color-text)] hover:[--work-sidebar-muted-foreground:var(--color-text)]',
            draggable ? 'cursor-default' : 'cursor-not-allowed',
            // Цель броска (2.5) бьёт всё: человек видит, куда сессия ляжет. Подкраска бьёт выбор и hover: строка,
            // где нужен человек, не бледнеет под курсором.
            over
              ? DROP_TARGET_FILL
              : blocked
                ? 'bg-accent-200 hover:bg-accent-200'
                : unseen
                  ? 'bg-accent-2-200 hover:bg-accent-2-200'
                  : selected
                    ? 'bg-work-sidebar-accent'
                    : 'hover:bg-work-sidebar-accent',
            over && DROP_TARGET_INK,
          )}
          // Закрытая строка приглушена цветом текста (styles/dimmed.css), не opacity (ревью M12).
          {...(closed ? { 'data-dimmed': 'row' } : {})}
        >
          <AgentStateDot state={state} lifecycle={session.lifecycle} />
          <AgentIcon provider={session.provider} size={13} />
          <span className={cn('min-w-0 flex-1 truncate', selected && 'font-bold')}>{label}</span>
          <RoleChip revision={`${session.pid}:${session.startedAtProcess}:${session.lifecycle}:${session.worktree?.path}`} role={session.role} sessionRef={{ projectPath, workId, sessionId: session.id }} bridge={bridge} />
          {lead ? (
            <span data-lead title={S.sidebar.lead} className="shrink-0 text-[11px] text-accent-700">
              ★
            </span>
          ) : null}
          {trustWait ? (
            <span
              title={waitKind === 'startup-wait' ? S.sidebar.startupWaitTooltip : S.sidebar.trustWaitTooltip}
              className="shrink-0 text-status-warning-text"
            >
              ⚠
            </span>
          ) : null}
          {agents.length > 0 ? (
            <AgentsBadge
              tasks={agents}
              side="right"
              anchor={rowRef}
              // Tab в списке ведёт курсор строки (roving tabindex): бейдж встаёт в порядок Tab только у строки под курсором.
              tabIndex={stop ? 0 : -1}
              onOpenChange={setAgentsOpen}
              onOpen={(task) => openAgentCard({ projectPath, workId, sessionId: session.id }, task.id)}
              className={cn(
                'h-[18px] shrink-0 rounded-full bg-[color-mix(in_srgb,currentColor_10%,transparent)] px-1.5 text-[10px] leading-[18px] hover:bg-[color-mix(in_srgb,currentColor_20%,transparent)]',
                secondary,
              )}
            />
          ) : null}
          <span
            className={cn(
              'shrink-0 truncate text-[11px]',
              blocked ? 'text-accent-800' : unseen ? 'text-accent-2-800' : secondary,
            )}
          >
            {word}
          </span>
          {session.worktree !== null ? (
            <span data-worktree title={S.sidebar.ownWorktree(session.worktree.branch)} className={cn('inline-flex shrink-0', secondary)}>
              <GitBranch className="size-[11px]" aria-hidden="true" />
            </span>
          ) : null}
          <span className={cn('w-[22px] shrink-0 text-right text-[10px] tabular-nums', secondary)}>{time}</span>
        </div>
      </HoverCardTrigger>
      </SessionRowMenu>
      <HoverCardContent side="right" align="start" className="w-72 space-y-1.5 p-3 text-xs">
        <SessionTooltip session={session} activity={activity} word={word} />
      </HoverCardContent>
    </HoverCard>
  );
});

function SessionTooltip({ session, activity, word }: { session: WorkSession; activity: ActivityEntry | null; word: string }): JSX.Element {
  const task = session.task.length > TASK_PREVIEW ? `${session.task.slice(0, TASK_PREVIEW)}…` : session.task;
  // Слово итога: у сессии с итогом — он сам (`result` — только 'done' | 'failed'), иначе
  // текущее состояние строки.
  const outcome = session.result === null ? word : stateWord(session.result, session.lifecycle);
  const metrics = activity?.metrics ?? null;
  return (
    <div data-session-tooltip className="space-y-1.5">
      <div className="font-medium">{sessionRowLabel(session.id, session.label)}</div>
      {task !== '' ? <p className="whitespace-pre-wrap break-words">{task}</p> : null}
      {session.summary !== null && session.summary !== '' ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{session.summary}</p>
      ) : null}
      <div>{outcome}</div>
      {metrics?.model !== null && metrics?.model !== undefined ? <div className="font-mono">{metrics.model}</div> : null}
      {metrics !== null ? <div className="text-muted-foreground">{formatMetricsLine(metrics)}</div> : null}
      {session.worktree !== null ? <div className="font-mono">⎇ {session.worktree.branch}</div> : null}
    </div>
  );
}
