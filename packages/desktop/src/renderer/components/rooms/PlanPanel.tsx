import { useEffect, useRef, useState } from "react";
import type { PlanItem, RoomMode, RoomPlan, WorkEntry } from "@parley/core";
import type { PlanActionResult } from "@parley/protocol";
import type { ParleyBridge } from "../../../shared/bridge.js";
import { decodeIpcError } from "../../../shared/ipc-error.js";
import { S } from "../../../shared/strings.js";
import { hostMethods } from "../../lib/capabilities.js";
import { isRoomArchived } from "../../lib/room-archive.js";
import { RoleChip } from "../../lib/role-summary.js";
import { sessionRowLabel } from "../../lib/participant.js";
import { useHostStore } from "../../store/host.js";
import { Button } from "../../ui/button.js";
import { Textarea } from "../../ui/textarea.js";

const P = S.plans;
export function currentRoomPlan(
  entry: WorkEntry,
  roomId: string,
): RoomPlan | null {
  const plans = (entry.map.plans ?? []).filter(
    (plan) => plan.roomId === roomId,
  );
  return (
    plans.find(
      (plan) => plan.status === "active" || plan.status === "completing",
    ) ??
    plans.at(-1) ??
    null
  );
}
export function planProgress(plan: RoomPlan): string {
  const done = plan.items.filter(
    (item) => item.status === (plan.mode === "checklist" ? "done" : "verified"),
  ).length;
  const basis = plan.items.filter(
    (item) =>
      item.status === "done" && item.acceptedChecklistRevision !== undefined,
  ).length;
  return P.progress(plan.mode, done, plan.items.length, basis);
}
/**
 * Replies cannot settle another room/revision, connection, bridge or unmounted view. Human form text survives.
 * An archived room (`archived`) is read-only like a closed work: nothing is written to it until the human reopens it.
 */
function usePlanRequest(
  identity: string,
  bridge: ParleyBridge,
  workStatus: WorkEntry["map"]["work"]["status"],
  archived = false,
) {
  const status = useHostStore((state) => state.status);
  const connections = useHostStore((state) => state.connections);
  const methods = hostMethods(status);
  const key = [
    identity,
    workStatus,
    archived,
    connections,
    status.state,
    [...methods].sort().join(","),
  ].join("\0");
  const current = useRef(key);
  current.current = key;
  const currentBridge = useRef(bridge);
  currentBridge.current = bridge;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    ++generation.current;
    inFlight.current = false;
    setBusy(false);
    setFeedback(null);
    return () => {
      ++generation.current;
    };
  }, [key, bridge]);
  const run = async (
    request: () => Promise<PlanActionResult>,
    allowClosed = false,
  ): Promise<boolean> => {
    if (
      inFlight.current ||
      status.state !== "connected" ||
      (!allowClosed && (workStatus !== "active" || archived))
    )
      return false;
    const captured = key,
      token = generation.current;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    const active = () =>
      current.current === captured &&
      currentBridge.current === bridge &&
      generation.current === token;
    try {
      const result = await request();
      if (!active()) return false;
      const effects = result.effects;
      setFeedback(
        P.saved +
          (effects.queued +
            effects.pendingSnapshots +
            effects.pendingBacklog +
            effects.conflictCount >
          0
            ? " " +
              P.workspaceEffects +
              ": " +
              P.pending(
                effects.queued,
                effects.pendingSnapshots,
                effects.pendingBacklog,
                effects.conflictCount,
              )
            : ""),
      );
      return true;
    } catch (error) {
      if (active())
        setFeedback(
          decodeIpcError(error).code === "conflict" ? P.changed : P.failed,
        );
      return false;
    } finally {
      if (active()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return { methods, busy, feedback, run, canMutate: workStatus === "active" && !archived };
}
export function RoomModeControl({
  entry,
  roomId,
  bridge,
}: {
  entry: WorkEntry;
  roomId: string;
  bridge: ParleyBridge;
}): JSX.Element {
  const room = entry.map.rooms.find((room) => room.id === roomId);
  const archived = room !== undefined && isRoomArchived(room);
  const mode = room?.mode ?? "free";
  const plan = currentRoomPlan(entry, roomId);
  const activePlan = plan?.status === "active" || plan?.status === "completing";
  const [selected, setSelected] = useState<RoomMode | null>(null);
  const [reason, setReason] = useState("");
  const modeDraft = useRef("");
  modeDraft.current = JSON.stringify([selected, reason]);
  const action = usePlanRequest(
    [
      entry.projectPath,
      entry.map.work.id,
      roomId,
      mode,
      plan?.id ?? "",
      plan?.rev ?? "",
    ].join("\0"),
    bridge,
    entry.map.work.status,
    archived,
  );
  const canChange = action.methods.has("rooms.setMode");
  const lower =
    selected !== null &&
    ["free", "checklist", "verified"].indexOf(selected) <
      ["free", "checklist", "verified"].indexOf(mode);
  return (
    <div
      data-room-mode=""
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      <label>
        {P.mode}{" "}
        <select
          aria-label={P.mode}
          value={selected ?? mode}
          disabled={!canChange || action.busy || !action.canMutate}
          onChange={(event) => {
            setSelected(
              event.target.value === mode
                ? null
                : (event.target.value as RoomMode),
            );
            setReason("");
          }}
          className="rounded border bg-background px-2 py-1"
        >
          {(["free", "checklist", "verified"] as const).map((value) => (
            <option key={value} value={value}>
              {P.modes[value]}
            </option>
          ))}
        </select>
      </label>
      <span className="text-muted-foreground">{P.modeHelp[mode]}</span>
      {!canChange ? <span>{P.oldHost}</span> : null}
      {!action.canMutate ? <span>{archived ? P.roomArchived : P.workClosed}</span> : null}
      {selected === null ? null : (
        <div className="basis-full space-y-2">
          {selected === "free" && activePlan ? (
            <p>{P.freeCancels}</p>
          ) : lower ? (
            <p>{P.lower}</p>
          ) : null}
          <input
            aria-label={P.reason}
            placeholder={P.reason}
            value={reason}
            maxLength={10000}
            onChange={(event) => setReason(event.target.value)}
            className="rounded border bg-background px-2 py-1"
          />
          <Button
            type="button"
            disabled={
              action.busy ||
              !action.canMutate ||
              !canChange ||
              !reason.trim() ||
              /[\r\n]/.test(reason)
            }
            onClick={() => {
              if (selected === null) return;
              const submittedDraft = modeDraft.current;
              void action
                .run(() =>
                  bridge.call("rooms.setMode", {
                    projectPath: entry.projectPath,
                    workId: entry.map.work.id,
                    roomId,
                    mode: selected,
                    reason: reason.trim(),
                    ...(selected === "free" && activePlan
                      ? { confirmCancel: true }
                      : {}),
                  }),
                )
                .then((ok) => {
                  if (ok && modeDraft.current === submittedDraft) {
                    setSelected(null);
                    setReason("");
                  }
                });
            }}
          >
            {P.confirmMode}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={action.busy}
            onClick={() => setSelected(null)}
          >
            {S.common.cancel}
          </Button>
        </div>
      )}
      {action.feedback ? <p role="status">{action.feedback}</p> : null}
    </div>
  );
}
function ownerLabel(entry: WorkEntry | undefined, id: string): string {
  if (id === "human") return S.participants.human;
  const session = entry?.map.sessions.find((session) => session.id === id);
  return session ? sessionRowLabel(session.id, session.label) : id;
}
/** Read-only content shared by accepted plans, proposed revisions and completion cards. */
export function PlanSummary({
  plan,
  entry,
  bridge,
  renderActions,
}: {
  plan: RoomPlan;
  entry?: WorkEntry;
  bridge?: ParleyBridge;
  renderActions?: (item: PlanItem) => JSX.Element | null;
}): JSX.Element {
  return (
    <div data-plan-summary="" className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <strong>{plan.goal}</strong>
        <span>{P.modes[plan.mode]}</span>
        <span>{P.status[plan.status]}</span>
        <span>{P.revision(plan.rev)}</span>
        <span>{planProgress(plan)}</span>
      </div>
      <ol className="space-y-2">
        {plan.items.map((item) => {
          const session = entry?.map.sessions.find(
            (session) => session.id === item.owner,
          );
          return (
            <li
              key={item.id}
              data-plan-item={item.id}
              className="rounded border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong>
                  {item.id}. {item.title}
                </strong>
                <span>{P.itemStatus[item.status]}</span>
                <span>
                  {P.owner}: {ownerLabel(entry, item.owner)}
                </span>
                {session && entry ? (
                  <RoleChip
                    role={session.role}
                    {...(bridge ? { bridge } : {})}
                    sessionRef={{
                      projectPath: entry.projectPath,
                      workId: entry.map.work.id,
                      sessionId: session.id,
                    }}
                    revision={String(plan.rev)}
                  />
                ) : null}
              </div>
              {item.acceptedChecklistRevision === undefined ? null : (
                <p>{P.basis(item.acceptedChecklistRevision)}</p>
              )}
              <details>
                <summary>
                  {P.scope}, {P.criteria}, {P.evidence}, {P.note}
                </summary>
                <p className="whitespace-pre-wrap">
                  {P.scope}: {item.scope}
                </p>
                {item.after.length ? (
                  <p>
                    {P.dependencies}: {item.after.join(", ")}
                  </p>
                ) : null}
                {item.criteria.length ? (
                  <div>
                    {P.criteria}
                    <ul>
                      {item.criteria.map((text, index) => (
                        <li key={index} className="whitespace-pre-wrap">
                          {text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {item.verifier ? (
                  <p>
                    {P.verifier}: {ownerLabel(entry, item.verifier)}
                  </p>
                ) : null}
                {item.evidence ? (
                  <div>
                    <p className="whitespace-pre-wrap">{item.evidence.text}</p>
                    <ul>
                      {item.evidence.artifacts.map((text, index) => (
                        <li key={index} className="whitespace-pre-wrap">
                          {text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {item.note ? (
                  <p className="whitespace-pre-wrap">{item.note}</p>
                ) : null}
              </details>
              {renderActions?.(item)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
type ItemForm = { item: number; action: "submit" | "verified" | "returned" };
export function PlanPanel({
  entry,
  roomId,
  bridge,
}: {
  entry: WorkEntry;
  roomId: string;
  bridge: ParleyBridge;
}): JSX.Element | null {
  const plan = currentRoomPlan(entry, roomId);
  const room = entry.map.rooms.find((candidate) => candidate.id === roomId);
  const archived = room !== undefined && isRoomArchived(room);
  const [form, setForm] = useState<ItemForm | null>(null);
  const [text, setText] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const itemDraft = useRef("");
  itemDraft.current = JSON.stringify([form, text, artifacts]);
  const action = usePlanRequest(
    [
      entry.projectPath,
      entry.map.work.id,
      roomId,
      plan?.id ?? "",
      plan?.rev ?? "",
    ].join("\0"),
    bridge,
    entry.map.work.status,
    archived,
  );
  const roomPlans = new Set(
    (entry.map.plans ?? [])
      .filter((plan) => plan.roomId === roomId)
      .map((plan) => plan.id),
  );
  const exports = (entry.map.planExports ?? []).filter((intent) =>
    roomPlans.has(intent.planId),
  );
  const queued = (entry.map.planEffects ?? []).filter(
    (effect) => effect.roomId === roomId && effect.status === "queued",
  ).length;
  const backlog = (entry.map.planBacklogIntents ?? []).filter((intent) =>
    roomPlans.has(intent.planId),
  );
  const snapshots = exports.filter(
    (intent) => intent.status === "pending",
  ).length;
  const pendingBacklog = backlog.filter(
    (intent) => intent.status === "pending",
  ).length;
  const conflicts = backlog.filter(
    (intent) => intent.status === "conflict",
  ).length;
  useEffect(() => {
    setForm(null);
    setText("");
    setArtifacts("");
    setCancelling(false);
  }, [entry.projectPath, entry.map.work.id, roomId, plan?.id]);
  if (
    !plan &&
    queued === 0 &&
    snapshots === 0 &&
    pendingBacklog === 0 &&
    conflicts === 0
  )
    return null;
  const identity = plan
    ? {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        planId: plan.id,
        rev: plan.rev,
      }
    : null;
  const artifactList =
    artifacts === ""
      ? []
      : artifacts.split("\n").filter((value) => value !== "");
  const submitValid =
    !!text.trim() &&
    artifactList.length <= 30 &&
    artifactList.every(
      (value) => value.length <= 1024 && !value.includes("\0"),
    ) &&
    text.trim().length +
      artifactList.reduce((sum, value) => sum + value.length, 0) <=
      10000;
  const formMethod =
    form?.action === "submit" ? "plans.submit" : "plans.verify";
  const currentItem = plan?.items.find((item) => item.id === form?.item);
  const formAllowed =
    currentItem !== undefined &&
    (form?.action === "submit"
      ? plan?.status === "active" &&
        ["ready", "in_progress", "returned"].includes(currentItem.status)
      : plan?.mode === "verified" &&
        (form?.action === "verified"
          ? plan.status === "active" && currentItem.status === "done"
          : ["active", "completing"].includes(plan.status) &&
            ["done", "verified"].includes(currentItem.status)));
  const open = (item: PlanItem, kind: ItemForm["action"]) => {
    setForm({ item: item.id, action: kind });
    setText("");
    setArtifacts("");
  };
  const submit = () => {
    if (
      !form ||
      !identity ||
      !formAllowed ||
      !action.methods.has(formMethod) ||
      !submitValid
    )
      return;
    const submittedDraft = itemDraft.current;
    void action
      .run(() =>
        form.action === "submit"
          ? bridge.call("plans.submit", {
              ...identity,
              item: form.item,
              evidence: { text, artifacts: artifactList },
            })
          : bridge.call("plans.verify", {
              ...identity,
              item: form.item,
              verdict: form.action,
              note: text,
            }),
      )
      .then((ok) => {
        if (ok && itemDraft.current === submittedDraft) {
          setForm(null);
          setText("");
          setArtifacts("");
        }
      });
  };
  return (
    <section
      data-plan-panel=""
      className="max-w-[680px] space-y-3 rounded border p-3"
    >
      <h4>{P.title}</h4>
      {plan ? (
        <PlanSummary
          plan={plan}
          entry={entry}
          bridge={bridge}
          renderActions={(item) => {
            const submitAllowed =
              plan.status === "active" &&
              ["ready", "in_progress", "returned"].includes(item.status);
            const verifyAllowed =
              plan.mode === "verified" &&
              plan.status === "active" &&
              item.status === "done";
            const returnAllowed =
              plan.mode === "verified" &&
              ["active", "completing"].includes(plan.status) &&
              ["done", "verified"].includes(item.status);
            return (
              <div className="flex flex-wrap gap-2">
                {submitAllowed ? (
                  <Button
                    type="button"
                    disabled={
                      action.busy ||
                      !action.canMutate ||
                      !action.methods.has("plans.submit")
                    }
                    onClick={() => open(item, "submit")}
                  >
                    {plan.mode === "checklist" ? P.markDone : P.submit}
                  </Button>
                ) : null}
                {verifyAllowed ? (
                  <Button
                    type="button"
                    disabled={
                      action.busy ||
                      !action.canMutate ||
                      !action.methods.has("plans.verify")
                    }
                    onClick={() => open(item, "verified")}
                  >
                    {P.verify}
                  </Button>
                ) : null}
                {returnAllowed ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      action.busy ||
                      !action.canMutate ||
                      !action.methods.has("plans.verify")
                    }
                    onClick={() => open(item, "returned")}
                  >
                    {P.returnItem}
                  </Button>
                ) : null}
              </div>
            );
          }}
        />
      ) : null}
      {form === null ? null : (
        <div className="space-y-2" data-plan-form="">
          <Textarea
            aria-label={
              form.action === "submit" ? P.evidence : P.verificationNote
            }
            value={text}
            maxLength={10000}
            onChange={(event) => setText(event.target.value)}
          />
          {form.action === "submit" ? (
            <>
              <Textarea
                aria-label={P.artifacts}
                value={artifacts}
                onChange={(event) => setArtifacts(event.target.value)}
                maxLength={10000}
              />
              <p>{P.artifactHelp}</p>
            </>
          ) : null}
          <Button
            type="button"
            disabled={
              action.busy ||
              !action.canMutate ||
              !action.methods.has(formMethod) ||
              !submitValid ||
              !formAllowed
            }
            onClick={submit}
          >
            {form.action === "submit"
              ? P.confirmSubmit
              : form.action === "verified"
                ? P.confirmVerify
                : P.confirmReturn}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={action.busy}
            onClick={() => setForm(null)}
          >
            {S.common.cancel}
          </Button>
        </div>
      )}
      {plan && ["active", "completing"].includes(plan.status) ? (
        <div>
          {cancelling ? (
            <>
              <p>{P.cancelWarning}</p>
              <Button
                type="button"
                disabled={
                  action.busy ||
                  !action.canMutate ||
                  !action.methods.has("plans.cancel")
                }
                onClick={() => {
                  if (identity)
                    void action
                      .run(() => bridge.call("plans.cancel", identity))
                      .then((ok) => {
                        if (ok) setCancelling(false);
                      });
                }}
              >
                {P.confirmCancel}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={action.busy}
                onClick={() => setCancelling(false)}
              >
                {S.common.cancel}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={
                action.busy ||
                !action.canMutate ||
                !action.methods.has("plans.cancel")
              }
              onClick={() => setCancelling(true)}
            >
              {P.cancelPlan}
            </Button>
          )}
        </div>
      ) : null}
      {!action.canMutate ? <p>{archived ? P.roomArchived : P.workClosed}</p> : null}
      {!action.methods.has("plans.submit") ||
      !action.methods.has("plans.verify") ? (
        <p>{P.oldHost}</p>
      ) : null}
      {queued + snapshots + pendingBacklog + conflicts > 0 ? (
        <div>
          <p>{P.pending(queued, snapshots, pendingBacklog, conflicts)}</p>
          <Button
            type="button"
            disabled={action.busy || !action.methods.has("plans.retryEffects")}
            onClick={() =>
              void action.run(
                () =>
                  bridge.call("plans.retryEffects", {
                    projectPath: entry.projectPath,
                    workId: entry.map.work.id,
                  }),
                true,
              )
            }
          >
            {P.retry}
          </Button>
        </div>
      ) : null}
      {exports
        .filter((intent) => intent.status === "pending")
        .map((intent) => (
          <p key={intent.file}>
            {P.snapshot(intent.event, intent.rev, intent.status)}
          </p>
        ))}
      {action.feedback ? <p role="status">{action.feedback}</p> : null}
    </section>
  );
}
