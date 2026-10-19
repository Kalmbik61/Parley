import type { ReactElement } from 'react';
import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import { planSummary, type AgentPlan } from '@parley/core/agent-plan';
import { S } from '../../../shared/strings.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../ui/hover-card.js';

interface PlanHoverProps {
  plan: AgentPlan;
  onOpen: () => void;
  children: ReactElement;
}

/** Один просмотр для счётчика и строки текущего пункта. */
export function PlanHover({ plan, onOpen, children }: PlanHoverProps): JSX.Element {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        data-testid="plan-hover"
        className="flex max-h-[min(400px,var(--radix-hover-card-content-available-height,calc(100vh-32px)))] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden p-3 text-xs"
      >
        <div data-testid="plan-hover-body" className="min-h-0 overflow-y-auto break-words">
          {plan.explanation ? (
            <p className="mb-2 whitespace-pre-wrap text-muted-foreground">{plan.explanation}</p>
          ) : null}
          {plan.partial ? (
            <p className="mb-2 text-muted-foreground">{S.rooms.planIncomplete}</p>
          ) : null}
          <ul data-testid="plan-hover-list" className="m-0 list-none space-y-2 p-0">
            {plan.items.map((item, index) => {
              const Icon =
                item.status === 'completed'
                  ? CheckCircle2
                  : item.status === 'in_progress'
                    ? LoaderCircle
                    : Circle;
              return (
                <li key={`${item.id ?? 'item'}:${index}`} className="flex items-start gap-2">
                  <Icon
                    size={13}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="break-words">{item.subject}</span>
                    {item.status === 'in_progress' && item.description ? (
                      <p
                        data-testid="plan-current-description"
                        className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"
                      >
                        {item.description.split('\n').slice(0, 6).join('\n')}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {plan.omitted > 0 ? (
            <p className="mt-2 text-muted-foreground">{S.rooms.planMore(plan.omitted)}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-3 shrink-0 self-start text-foreground hover:underline"
        >
          {S.rooms.planOpenInAgents}
        </button>
      </HoverCardContent>
    </HoverCard>
  );
}

export function PlanChip({ plan, onOpen }: Omit<PlanHoverProps, 'children'>): JSX.Element {
  const { done, total } = planSummary(plan);
  return (
    <PlanHover plan={plan} onOpen={onOpen}>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 rounded-full border border-current/15 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:text-foreground"
      >
        {plan.partial ? S.rooms.planLabel : `${done}/${total}`}
      </button>
    </PlanHover>
  );
}
