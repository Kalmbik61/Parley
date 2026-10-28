/**
 * Строка роя в карточке работы (спека роя v1, 7.1): рой отпочковывается от создателя — под сессией, под комнатой или
 * наверху, если его завёл человек (`sort.ts#cardRows`, `CardSwarmRow`). Свёрнутая строка: значок, `Swarm [тег]`, точки
 * (по одной на трутня и проверяющего, залита сдавшая), счётчик `3/5`, знак конца, таймер и стрелка. Раскрытая добавляет
 * участников: королеву, трутней по номеру, проверяющих — и итог, когда рой закончился. Сессии роя обычными строками
 * карточки не выводятся: открыть их можно только отсюда.
 *
 * Раскрытие — память окна по ключу `workKey/swarmId` (как «N more closed»): виртуализатор размонтирует карточку за краем
 * списка. Таймер тикает раз в секунду, только пока рой не закончился и только в этой строке (`LiveTimer`).
 */

import { memo } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Check, ChevronDown, X } from 'lucide-react';
import type { WorkSwarm } from '@parley/core';
import { swarmProgress } from '@parley/core/swarms';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { SwarmIcon } from '../components/SwarmIcon.js';
import { useHostSupports } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { useSwarmIconMotion } from '../lib/use-swarm-icon-motion.js';
import { useNow } from '../lib/use-now.js';
import {
  formatSwarmTimer,
  memberTitle,
  memberWord,
  swarmCounter,
  swarmDots,
  swarmElapsedMs,
  type SwarmMemberView,
} from '../lib/swarm-view.js';
import { NO_GUIDES, type CardSwarmRow, type TreeGuide } from './sort.js';
import { markSwarmSeen, SwarmRowMenu, swarmResultUnseen } from './SwarmRowMenu.js';
import { TREE_STEP, TreeGuides } from './TreeGuides.js';

/** Раскрытые рои — до конца сеанса окна, по ключу `workKey/swarmId`. */
const useExpandedSwarms = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

/** Раскрыть или свернуть рой: клик по строке и → / ← клавиатуры. */
export function showSwarm(key: string, shown: boolean): void {
  useExpandedSwarms.setState((state) => {
    if (shown === (state.keys[key] === true)) return state;
    return { keys: shown ? { ...state.keys, [key]: true } : Object.fromEntries(Object.entries(state.keys).filter(([item]) => item !== key)) };
  });
}

/** Таймер идущего роя: свой тик раз в секунду, больше ничего в строке не перерисовывается по таймеру. */
function LiveTimer({ swarm }: { swarm: WorkSwarm }): JSX.Element {
  const now = useNow(1000);
  return <>{formatSwarmTimer(swarmElapsedMs(swarm, now.getTime()))}</>;
}

/** Знак конца роя: ✓ готов, ⚠ сбой, ✕ отменён; у идущего знака нет. */
function EndMark({ swarm }: { swarm: WorkSwarm }): JSX.Element | null {
  const label = S.workSwarm.status[swarm.status];
  if (swarm.status === 'done') return <Check data-swarm-end="done" aria-label={label} className="size-3 shrink-0 text-(--state-done)" />;
  if (swarm.status === 'failed') return <AlertTriangle data-swarm-end="failed" aria-label={label} className="size-3 shrink-0 text-accent-700" />;
  if (swarm.status === 'cancelled') return <X data-swarm-end="cancelled" aria-label={label} className="size-3 shrink-0 text-work-sidebar-muted-foreground" />;
  return null;
}

function Dots({ views }: { views: readonly SwarmMemberView[] }): JSX.Element | null {
  const dots = swarmDots(views);
  if (dots.length === 0) return null;
  return (
    <span aria-hidden="true" data-swarm-dots="" className="flex shrink-0 items-center gap-[3px]">
      {dots.map((dot, index) => (
        <i
          key={index}
          data-dot={dot}
          className={cn(
            'inline-block size-[5px] rounded-full border',
            dot === 'handed' && 'border-work-sidebar-foreground bg-work-sidebar-foreground',
            dot === 'failed' && 'border-accent-700 bg-accent-700',
            dot === 'open' && 'border-work-sidebar-muted-foreground',
          )}
        />
      ))}
    </span>
  );
}

export interface SwarmRowProps {
  workKey: string;
  /** Работа строки — для меню и «Mark as seen»; строками, а не ref, как у `SessionRow`. */
  projectPath: string;
  workId: string;
  bridge: ParleyBridge;
  row: CardSwarmRow;
  /** Линии дерева к этой строке и сквозь неё (`sort.ts#treeGuides`). */
  guides?: readonly TreeGuide[];
  selectedSessionId: string | null;
  /** Колбэк строки участника — один на сессию на всё время жизни карточки (`WorkCard#openerFor`). */
  openerFor(sessionId: string): () => void;
}

export const SwarmRow = memo(function SwarmRow({ workKey, projectPath, workId, bridge, row, guides = NO_GUIDES, selectedSessionId, openerFor }: SwarmRowProps): JSX.Element {
  const { swarm, members } = row;
  const key = `${workKey}/${swarm.id}`;
  const expanded = useExpandedSwarms((state) => state.keys[key] === true);
  const reducedMotion = useSwarmIconMotion();
  const terminal = swarm.status === 'done' || swarm.status === 'failed' || swarm.status === 'cancelled';
  const statusWord = S.workSwarm.status[swarm.status];
  const title = S.workSwarm.rowTitle(swarm.tag, statusWord);
  const { handed, total } = swarmProgress(swarm);
  const toggle = (): void => showSwarm(key, !expanded);

  return (
    <SwarmRowMenu workKey={workKey} projectPath={projectPath} workId={workId} swarm={swarm} bridge={bridge} onOpenQueen={members.some((view) => view.member.sessionId === swarm.queen && view.session !== null) ? openerFor(swarm.queen) : null}>
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-label={title}
      tabIndex={0}
      data-swarm-row={swarm.id}
      data-swarm-status={swarm.status}
      onClick={(event) => {
        // Клик по строке — не клик по карточке: карточка сделала бы только работу активной.
        event.stopPropagation();
        if (event.currentTarget.contains(event.target as Node)) toggle();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
      style={{ marginLeft: `${row.depth * TREE_STEP}px`, paddingLeft: '8px' }}
      className={cn(
        'relative flex min-w-0 cursor-default flex-col rounded-[14px] pr-1.5 text-xs text-work-sidebar-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-work-sidebar-focus-ring',
        expanded ? 'bg-foreground/4 hover:bg-foreground/6' : 'hover:bg-work-sidebar-accent hover:[--work-sidebar-muted-foreground:var(--color-text)]',
        terminal && swarm.status !== 'done' && 'text-work-sidebar-muted-foreground',
      )}
    >
      <TreeGuides guides={guides} depth={row.depth} />
      <div title={title} className="flex h-[26px] items-center gap-1.5">
        <SwarmIcon status={swarm.status} size={16} handed={handed} reducedMotion={reducedMotion} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{S.workSwarm.swarm}</span> <span data-swarm-tag="">[{swarm.tag}]</span>
        </span>
        <Dots views={members} />
        <span data-swarm-counter="" title={S.workSwarm.counterLabel(handed, total)} className="shrink-0 text-[11px] font-semibold tabular-nums">
          {swarmCounter(swarm)}
        </span>
        <EndMark swarm={swarm} />
        <span data-swarm-timer="" className="shrink-0 text-[11px] tabular-nums text-work-sidebar-muted-foreground">
          {terminal ? formatSwarmTimer(swarmElapsedMs(swarm, 0)) : <LiveTimer swarm={swarm} />}
        </span>
        <ChevronDown className={cn('size-[13px] shrink-0 text-work-sidebar-muted-foreground', !expanded && '-rotate-90')} aria-hidden="true" />
      </div>
      {expanded ? (
        <div role="group" className="mb-1.5 ml-[13px] flex flex-col gap-px border-l border-work-sidebar-tree-line pl-1.5">
          {members.map((view) => (
            <MemberLine key={view.member.sessionId} swarm={swarm} view={view} selected={view.session?.id === selectedSessionId} openerFor={openerFor} />
          ))}
          {terminal ? <Outcome swarm={swarm} projectPath={projectPath} workId={workId} bridge={bridge} /> : null}
        </div>
      ) : null}
    </div>
    </SwarmRowMenu>
  );
});

function MemberLine({ swarm, view, selected, openerFor }: { swarm: WorkSwarm; view: SwarmMemberView; selected: boolean; openerFor(sessionId: string): () => void }): JSX.Element {
  const { member, session, state } = view;
  const word = memberWord(swarm, view);
  const open = session === null ? undefined : openerFor(session.id);
  return (
    <div
      role="button"
      tabIndex={open === undefined ? -1 : 0}
      data-swarm-member={member.sessionId}
      data-member-state={state}
      aria-label={`${memberTitle(member)}: ${word}`}
      onClick={(event) => {
        event.stopPropagation();
        open?.();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        open?.();
      }}
      className={cn(
        'flex h-[22px] min-w-0 items-center gap-1.5 rounded-full pl-1.5 pr-1.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-work-sidebar-focus-ring',
        open !== undefined && 'cursor-default hover:bg-foreground/6',
        selected && 'bg-work-sidebar-accent font-bold',
        (state === 'handed' || state === 'closed') && 'text-work-sidebar-muted-foreground',
      )}
    >
      <span aria-hidden="true" className="inline-flex size-3 shrink-0 items-center justify-center text-[11px] leading-none">
        {member.role === 'queen' ? '👑' : <i className={cn('inline-block size-[6px] rounded-full border', state === 'working' ? 'animate-pulse border-work-sidebar-foreground bg-work-sidebar-foreground motion-reduce:animate-none' : state === 'handed' ? 'border-work-sidebar-muted-foreground bg-work-sidebar-muted-foreground' : state === 'failed' ? 'border-accent-700 bg-accent-700' : 'border-work-sidebar-muted-foreground')} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{memberTitle(member)}</span>
      <span className={cn('shrink-0 text-[11px]', state === 'failed' ? 'font-semibold text-accent-800' : 'text-work-sidebar-muted-foreground')}>{word}</span>
    </div>
  );
}

/** Итог законченного роя: сводка королевы или причина остановки (спека роя, 3.3). */
function Outcome({ swarm, projectPath, workId, bridge }: { swarm: WorkSwarm; projectPath: string; workId: string; bridge: ParleyBridge }): JSX.Element {
  const text = swarm.result?.summary ?? '';
  const canMarkSeen = useHostSupports('swarms.seen') && swarmResultUnseen(swarm);
  return (
    <div data-swarm-outcome="" className="mt-0.5 rounded-lg bg-foreground/4 px-2 py-1.5 text-[11px] leading-4">
      {swarm.failure !== null ? <div className="font-semibold text-accent-800">{S.workSwarm.failure(swarm.failure)}</div> : null}
      <div className="mb-0.5 font-semibold">{S.workSwarm.result}</div>
      <div className="line-clamp-6 whitespace-pre-wrap break-words text-work-sidebar-muted-foreground">{text === '' ? S.workSwarm.noResult : text}</div>
      {canMarkSeen ? (
        <button
          type="button"
          data-swarm-action="seen"
          onClick={(event) => {
            event.stopPropagation();
            markSwarmSeen(bridge, projectPath, workId, swarm.id);
          }}
          className="mt-1 cursor-pointer rounded-full px-1.5 py-0.5 text-[11px] font-medium hover:bg-foreground/6"
        >
          {S.workSwarm.menu.markSeen}
        </button>
      ) : null}
    </div>
  );
}
