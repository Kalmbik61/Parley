import type { RoomPlan, WorkEntry } from "@parley/core";
import type { ParleyBridge } from "../../../shared/bridge.js";
import { S } from "../../../shared/strings.js";
import { DecisionCard, type DecisionCardProps } from "./DecisionCard.js";
import { PlanSummary } from "./PlanPanel.js";
/** Completion is a proposal tied to a current accepted plan/revision, never an inferred all-done decision. */
export function CompletionCard({
  plan,
  entry,
  bridge,
  ...props
}: DecisionCardProps & {
  plan: RoomPlan | null;
  entry: WorkEntry;
  bridge: ParleyBridge;
}): JSX.Element {
  const matches =
    plan?.id === props.proposal.planId &&
    plan?.rev === props.proposal.planRev &&
    plan?.status === "completing";
  return (
    <div data-completion-card="">
      <DecisionCard
        {...props}
        {...(!matches && props.canResolve
          ? { unavailableReason: S.plans.changed }
          : {})}
        canResolve={props.canResolve && matches}
      >
        {plan ? (
          <PlanSummary plan={plan} entry={entry} bridge={bridge} />
        ) : null}
      </DecisionCard>
    </div>
  );
}
