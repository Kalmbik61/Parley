import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import { planSummary, type AgentPlan, type AgentPlanItem } from '@parley/core/agent-plan';
import { S } from '../../shared/strings.js';
import { RoomMarkdown } from '../components/rooms/RoomMarkdown.js';
import { getHostClient } from '../host-client.js';
import type { roomPlanLinks } from './plan-links.js';

export function PlanSection({
  plan,
  links,
  onOpenRoom,
}: {
  plan: AgentPlan | null;
  links: ReturnType<typeof roomPlanLinks>;
  onOpenRoom: (roomId: string) => void;
}): JSX.Element {
  const summary = plan === null ? null : planSummary(plan);
  return (
    <section
      className="flex min-w-0 flex-col gap-2 border-b border-border pb-3"
      aria-label={S.agentsPanel.plan}
    >
      <h3 className="text-sm font-medium">
        {plan === null || plan.items.length === 0 || plan.partial || summary === null
          ? S.agentsPanel.plan
          : `${S.agentsPanel.plan} · ${summary.done}/${summary.total}`}
      </h3>
      {plan?.partial ? (
        <p className="text-xs text-muted-foreground">{S.agentsPanel.planIncomplete}</p>
      ) : null}
      {links.map((link) => (
        <button
          key={`${link.planId}:${link.itemId}`}
          type="button"
          title={link.scope}
          onClick={() => onOpenRoom(link.roomId)}
          className="text-left text-xs text-primary hover:underline"
        >{`${link.planId} · item ${link.itemId}: ${link.title}`}</button>
      ))}
      {plan === null || plan.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{S.agentsPanel.noPlan}</p>
      ) : null}
      {plan?.explanation ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{plan.explanation}</p>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-2">
        {plan?.items.map((item, index) => (
          <PlanItemRow key={item.id ?? index} item={item} />
        ))}
      </ul>
      {plan != null && plan.omitted > 0 ? (
        <p className="text-xs text-muted-foreground">{S.agentsPanel.planMore(plan.omitted)}</p>
      ) : null}
    </section>
  );
}

function PlanItemRow({ item }: { item: AgentPlanItem }): JSX.Element {
  const [open, setOpen] = useState(item.status === 'in_progress');
  useEffect(() => {
    if (item.status === 'in_progress') setOpen(true);
  }, [item.status]);
  const Icon =
    item.status === 'completed'
      ? CheckCircle2
      : item.status === 'in_progress'
        ? LoaderCircle
        : Circle;
  const label = (
    <>
      <Icon
        className={`mt-0.5 size-3.5 shrink-0${item.status === 'in_progress' ? ' animate-spin' : ''}`}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{item.subject}</span>
    </>
  );
  return (
    <li className="min-w-0 text-sm">
      {item.description ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-start gap-2 text-left"
        >
          {label}
        </button>
      ) : (
        <div className="flex items-start gap-2">{label}</div>
      )}
      {item.description && open ? (
        <div className="ml-5 mt-1 min-w-0 break-words text-muted-foreground">
          <RoomMarkdown
            text={item.description}
            labelOf={() => null}
            onOpenExternal={(url) => void getHostClient().app.openExternal(url)}
          />
        </div>
      ) : null}
    </li>
  );
}
