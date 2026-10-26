import { useEffect, useState } from "react";
import type { RoomPlan, WorkEntry } from "@parley/core";
import type { ParleyBridge } from "../../../shared/bridge.js";
import { S } from "../../../shared/strings.js";
import { DecisionCard, type DecisionCardProps } from "./DecisionCard.js";
import { isRoomArchived } from "../../lib/room-archive.js";
import { canReturnPlanItem, usePlanRequest, PlanSummary } from "./PlanPanel.js";
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
  const [item, setItem] = useState("");
  const room = entry.map.rooms.find(row => row.id === plan?.roomId);
  const action = usePlanRequest(
    [entry.projectPath, entry.map.work.id, plan?.roomId, plan?.id, plan?.rev, props.proposal.id, props.proposal.rev].join("\0"),
    bridge, entry.map.work.status, room !== undefined && isRoomArchived(room),
  );
  useEffect(() => setItem(""), [entry.projectPath, entry.map.work.id, plan?.id, plan?.rev, props.proposal.id]);
  const autonomous = plan?.mode === "autonomous";
  const items = plan?.items.filter(row => canReturnPlanItem(plan, row)) ?? [];
  const selected = items.find(row => String(row.id) === item);
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
        {...(autonomous ? {
          canReturn: action.methods.has("plans.verify") && action.canMutate,
          returnReady: selected !== undefined,
          requireReturnNote: true,
          returnFields: <label>{S.plans.itemToReturn}{" "}<select aria-label={S.plans.itemToReturn} value={item} disabled={action.busy || !matches || !props.canResolve || !action.canMutate} onChange={event => setItem(event.target.value)}>
            <option value="">{S.plans.selectItem}</option>
            {items.map(row => <option key={row.id} value={row.id}>{row.id}. {row.title}</option>)}
          </select></label>,
          onResolve: (response: "accept" | "return", note: string) => {
            if (response === "accept") return props.onResolve(response, note);
            if (!matches || !selected || !plan || !note.trim() || !action.methods.has("plans.verify")) return Promise.resolve(false);
            return action.run(() => bridge.call("plans.verify", {
              projectPath: entry.projectPath, workId: entry.map.work.id, planId: plan.id, rev: plan.rev,
              item: selected.id, verdict: "returned", note,
            }));
          },
        } : {})}
      >
        {plan ? (
          <PlanSummary plan={plan} entry={entry} bridge={bridge} />
        ) : null}
        {action.feedback ? <p role="status">{action.feedback}</p> : null}
      </DecisionCard>
    </div>
  );
}
