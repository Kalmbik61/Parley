import { useState } from 'react';
import type { RoomPlan, WorkEntry } from '@parley/core';
import type { PlanRemaining } from '@parley/core/plan-state';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { RoleChip } from '../../lib/role-summary.js';
import { Badge } from '../../ui/badge.js';
import { ownerLabel, PlanSummary } from './PlanPanel.js';

const P = S.plans;

/** Значок пункта поправки: новый, изменённый, сбрасываемый (уже сделанный, но поправка его отменяет). */
const MARK_VARIANT = { new: 'accent', changed: 'accent-2', redo: 'neutral' } as const;

/**
 * Карточка поправки плана (план 2026-10-19, D6): только то, что после принятия останется несделанным, — новые, старые
 * незавершённые (в том числе `done` в ожидании проверки) и сбрасываемые поправкой, каждый со статусом, который у него будет.
 * Сделанные, что остались сделанными, — одна строка со счётом; убранные незавершённые — одна строка `Removed`; весь черновик —
 * под раскрытием. Расчёт — `planRemaining` ядра: тот же, что у `acceptRoomPlan`, поэтому карточка показывает ровно то, что сделает принятие.
 */
export function PlanRemainingView({
  remaining,
  plan,
  entry,
  bridge,
}: {
  remaining: PlanRemaining;
  /** Предложенный план (черновик поправки). */
  plan: RoomPlan;
  entry?: WorkEntry;
  bridge?: ParleyBridge;
}): JSX.Element {
  const [full, setFull] = useState(false);
  return (
    <div data-plan-remaining="" className="min-w-0 space-y-3 text-sm">
      <div data-plan-remaining-header="" className="flex flex-wrap gap-x-2 gap-y-1">
        <strong className="min-w-0 break-words [overflow-wrap:anywhere]">{plan.goal}</strong>
        <span>{P.modes[plan.mode]}</span>
        <span>{P.revision(plan.rev)}</span>
      </div>
      <ol className="space-y-2">
        {remaining.items.map(({ item, status, mark }) => {
          const session = entry?.map.sessions.find((candidate) => candidate.id === item.owner);
          return (
            <li key={item.id} data-remaining-item={item.id} className="min-w-0 rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong data-plan-item-title="" className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {item.id}. {item.title}
                </strong>
                <span>{P.itemStatus[status]}</span>
                {mark ? (
                  <Badge variant={MARK_VARIANT[mark]} data-plan-mark={mark}>
                    {P.marks[mark]}
                  </Badge>
                ) : null}
                <span>
                  {P.owner}: {ownerLabel(entry, item.owner)}
                </span>
                {session && entry ? (
                  <RoleChip
                    role={session.role}
                    {...(bridge ? { bridge } : {})}
                    sessionRef={{ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }}
                    cwd={session.worktree?.path ?? entry.projectPath}
                    revision={`${session.pid}:${session.startedAtProcess}:${session.lifecycle}:${session.worktree?.path}`}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {remaining.doneHidden > 0 ? (
        <p data-plan-done-hidden="" className="text-muted-foreground">
          {P.doneHidden(remaining.doneHidden)}
        </p>
      ) : null}
      {remaining.removed.length > 0 ? (
        <p data-plan-removed="" className="min-w-0 break-words [overflow-wrap:anywhere]">
          {P.removed(remaining.removed.map(({ id, title }) => `#${id} ${title}`))}
        </p>
      ) : null}
      <details data-plan-full="" onToggle={(event) => setFull(event.currentTarget.open)}>
        <summary className="cursor-pointer">{P.showFullPlan}</summary>
        {/* Закрытый черновик не монтируем: цель и пункты не двоятся на карточке, роли не грузятся впустую. Длинное название без пробелов (путь) `PlanSummary` переносит сам. */}
        {full ? (
          <div className="min-w-0 pt-2">
            <PlanSummary plan={plan} {...(entry ? { entry } : {})} {...(bridge ? { bridge } : {})} />
          </div>
        ) : null}
      </details>
    </div>
  );
}
