import type { LetterTx } from "./letter-store.js";
import { maxNumber } from "./map.js";
import {
  addSystemMessage,
  isMember,
  isRoomClosed,
  liveLead,
  requireOpenRoom,
  RoomRuleError,
} from "./rooms.js";
import { capturePlanSnapshot } from "./plan-snapshots.js";
import { hasDigestOnly } from "./stored-texts.js";
import { ENGINE, HUMAN } from "./types.js";
import type {
  AutonomousDraft,
  PlanDraft,
  PlanEvidence,
  PlanItem,
  PlanItemStatus,
  Room,
  RoomMode,
  RoomPlan,
  WorkMap,
} from "./types.js";

export class PlanConflictError extends Error {
  constructor(message = "plan revision or status changed") {
    super(message);
    this.name = "PlanConflictError";
  }
}
export const PLAN_ITEM_MAX = 30;
export const PLAN_TEXT_MAX = 10_000;
const text = (value: string, required = true): boolean =>
  typeof value === "string" &&
  (!required || !!value.trim()) &&
  value.length <= PLAN_TEXT_MAX &&
  !value.includes("\0") &&
  Buffer.from(value, "utf8").toString("utf8") === value;
export function planRoom(map: WorkMap, roomId: string): Room {
  const room = map.rooms.find((room) => room.id === roomId);
  if (!room) throw new RoomRuleError("room is not in the map");
  return room;
}
function participant(
  map: WorkMap,
  room: Room,
  actor: string,
  mode = room.mode,
): boolean {
  if (actor === ENGINE) return mode === "autonomous";
  return (
    actor === HUMAN ||
    (isMember(room, actor) &&
      map.sessions.some(
        (session) => session.id === actor && session.lifecycle !== "closed",
      ))
  );
}
export function requirePlanLead(map: WorkMap, room: Room, actor: string): void {
  if (
    isRoomClosed(map, room) ||
    !participant(map, room, actor) ||
    liveLead(map, room) !== actor
  )
    throw new RoomRuleError("only the live room lead can propose a plan");
}
function liveOwner(
  map: WorkMap,
  room: Room,
  actor: string,
  mode = room.mode,
): boolean {
  return actor !== HUMAN && participant(map, room, actor, mode);
}
const current = (plan: RoomPlan): boolean =>
  plan.status === "active" || plan.status === "completing";
export function activeRoomPlan(
  map: WorkMap,
  roomId: string,
): RoomPlan | undefined {
  return map.plans?.find((plan) => plan.roomId === roomId && current(plan));
}

/**
 * Clone only mutated domain state: failures leave the caller's map unchanged. Letters are not part of the draft: a body
 * that writes them is run in `letters.savepoint`, so a failure takes them back too (storage spec 6.2).
 */
function edit<T>(map: WorkMap, body: (draft: WorkMap) => T, letters?: LetterTx): T {
  const draft: WorkMap = {
    ...map,
    work: { ...map.work },
    rooms: structuredClone(map.rooms),
    plans: structuredClone(map.plans ?? []),
    planExports: structuredClone(map.planExports ?? []),
  };
  const result = letters === undefined ? body(draft) : letters.savepoint(() => body(draft));
  map.work = draft.work;
  map.rooms = draft.rooms;
  map.plans = draft.plans!;
  map.planExports = draft.planExports!;
  return result;
}
function validateDraft(
  map: WorkMap,
  room: Room,
  input: PlanDraft,
  decisionTextLength = 0,
): PlanItem[] {
  if (
    !input ||
    !["checklist", "verified", "autonomous"].includes(input.mode) ||
    !text(input.goal) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > PLAN_ITEM_MAX
  )
    throw new RoomRuleError("invalid plan");
  const items: PlanItem[] = [];
  const ids = new Set<number>();
  let size = input.goal.length + decisionTextLength;
  for (const item of input.items) {
    if (
      !item ||
      !Number.isSafeInteger(item.id) ||
      item.id < 1 ||
      ids.has(item.id) ||
      !text(item.title) ||
      !text(item.scope) ||
      !liveOwner(map, room, item.owner, input.mode) ||
      (input.mode !== "autonomous" && item.verifier === ENGINE) ||
      (input.mode === "autonomous" &&
        (item.owner !== ENGINE || item.verifier !== ENGINE))
    )
      throw new RoomRuleError("invalid plan item or owner");
    ids.add(item.id);
    const after = item.after ?? [];
    const criteria = input.mode !== "checklist" ? (item.criteria ?? []) : [];
    if (
      !Array.isArray(after) ||
      after.length > PLAN_ITEM_MAX ||
      after.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(after).size !== after.length ||
      !Array.isArray(criteria) ||
      criteria.length > 10 ||
      criteria.some((value) => !text(value))
    )
      throw new RoomRuleError("invalid dependencies or criteria");
    let verifier: string | null = null;
    if (input.mode !== "checklist") {
      if (!criteria.length)
        throw new RoomRuleError("verified items need criteria");
      verifier = item.verifier ?? liveLead(map, room);
      if (
        input.mode !== "autonomous" &&
        verifier === item.owner &&
        [...new Set([...room.members, room.creator])].filter((id) =>
          liveOwner(map, room, id),
        ).length === 1
      )
        verifier = HUMAN;
      if (
        verifier === null ||
        (verifier === item.owner && input.mode !== "autonomous") ||
        !participant(map, room, verifier, input.mode)
      )
        throw new RoomRuleError(
          "verifier must be an independent live participant or human",
        );
    }
    size +=
      item.title.length +
      item.scope.length +
      criteria.reduce((sum, value) => sum + value.length, 0);
    items.push({
      id: item.id,
      title: item.title,
      owner: item.owner,
      scope: item.scope,
      after: [...after].sort((a, b) => a - b),
      criteria: [...criteria],
      verifier,
      status: "waiting",
      evidence: null,
      note: null,
      log: [],
    });
  }
  if (
    size > PLAN_TEXT_MAX ||
    (input.backlog !== undefined &&
      (!Array.isArray(input.backlog) ||
        input.backlog.length > 30 ||
        input.backlog.some((id) => !/^b-\d{3,}$/.test(id)) ||
        new Set(input.backlog).size !== input.backlog.length))
  )
    throw new RoomRuleError("plan text or backlog limit");
  const visited = new Set<number>();
  const pending = new Set<number>();
  const visit = (id: number): void => {
    if (pending.has(id)) throw new RoomRuleError("plan dependency cycle");
    if (visited.has(id)) return;
    const item = items.find((item) => item.id === id);
    if (!item) throw new RoomRuleError("missing dependency");
    pending.add(id);
    for (const after of item.after) visit(after);
    pending.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
  return items;
}
/** Проверка входа канала без записи карты и резервирования идентификатора плана. */
export function validateAutonomousDraft(
  map: WorkMap,
  roomId: string,
  from: string,
  input: PlanDraft & { autonomous: AutonomousDraft },
  decisionTextLength = 0,
): void {
  if (input?.mode !== "autonomous")
    throw new RoomRuleError("invalid autonomous draft");
  proposedRoomPlan(
    structuredClone(map),
    roomId,
    from,
    input,
    decisionTextLength,
  );
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const positive = (value: unknown): boolean =>
    Number.isSafeInteger(value) && Number(value) > 0;
  const auto = input.autonomous;
  const limits = [
    "attemptsPerItem",
    "repairWaves",
    "minutesPerAttempt",
    "sessions",
    "concurrent",
  ];
  if (
    !object(auto) ||
    Object.keys(auto).some(
      (key) => !["budget", "checks", "coverage"].includes(key),
    ) ||
    !object(auto.budget) ||
    Object.keys(auto.budget).length !== limits.length ||
    !limits.every((key) =>
      positive((auto.budget as unknown as Record<string, unknown>)[key]),
    ) ||
    !Array.isArray(auto.checks) ||
    auto.checks.length > 10_000 ||
    !object(auto.coverage)
  )
    throw new RoomRuleError("invalid autonomous budget, checks or coverage");
  const checks = new Map<string, number>();
  for (const check of auto.checks) {
    if (
      !object(check) ||
      Object.keys(check).some(
        (key) =>
          !["id", "item", "argv", "cwd", "env", "inputs", "timeoutMs"].includes(
            key,
          ),
      ) ||
      !text(check.id) ||
      check.id === "verifier" ||
      checks.has(check.id) ||
      !input.items.some((item) => item.id === check.item) ||
      !Array.isArray(check.argv) ||
      !check.argv.length ||
      !check.argv.every((arg) => text(arg, false)) ||
      !text(check.argv[0]!) ||
      !text(check.cwd) ||
      !object(check.env) ||
      Object.entries(check.env).some(
        ([key, value]) =>
          !text(key) || typeof value !== "string" || !text(value, false),
      ) ||
      !Array.isArray(check.inputs) ||
      !check.inputs.every((file) => text(file)) ||
      !positive(check.timeoutMs)
    )
      throw new RoomRuleError("invalid autonomous check");
    checks.set(check.id, check.item);
  }
  for (const [id, criteria] of Object.entries(auto.coverage)) {
    const item = input.items.find((item) => String(item.id) === id);
    if (!item || !object(criteria))
      throw new RoomRuleError("invalid autonomous coverage item");
    for (const [index, required] of Object.entries(criteria)) {
      const criterion = Number(index);
      if (
        String(criterion) !== index ||
        !Number.isSafeInteger(criterion) ||
        criterion < 0 ||
        criterion >= item.criteria!.length ||
        !Array.isArray(required) ||
        required.length === 0 ||
        required.some(
          (id) =>
            id !== "verifier" &&
            (typeof id !== "string" || checks.get(id) !== item.id),
        )
      )
        throw new RoomRuleError("invalid autonomous criterion coverage");
    }
  }
  for (const item of input.items)
    for (let criterion = 0; criterion < item.criteria!.length; criterion++)
      if (!auto.coverage[item.id]?.[criterion]?.length)
        throw new RoomRuleError("every autonomous criterion needs coverage");
}
export function proposedRoomPlan(
  map: WorkMap,
  roomId: string,
  from: string,
  input: PlanDraft,
  decisionTextLength = 0,
): RoomPlan {
  const room = requireOpenRoom(map, roomId);
  requirePlanLead(map, room, from);
  if (room.mode === "free" || (room.mode ?? "free") !== input.mode)
    throw new RoomRuleError("plan must match the room mode");
  const items = validateDraft(map, room, input, decisionTextLength);
  const active = activeRoomPlan(map, roomId);
  let id: string;
  let rev: number;
  if (active) {
    if (input.id !== active.id || input.rev !== active.rev)
      throw new PlanConflictError();
    id = active.id;
    rev = active.rev + 1;
  } else {
    if (input.id !== undefined || input.rev !== undefined)
      throw new PlanConflictError();
    // Replacing an unaccepted proposal preserves its reserved plan identity.
    const previous = room.proposal?.plan;
    if (previous?.status === "proposed") {
      id = previous.id;
      rev = previous.rev + 1;
    } else {
      const sequence =
        Math.max(
          map.work.planSeq ?? 0,
          maxNumber(
            (map.plans ?? []).map((plan) => plan.id),
            "pl-",
          ),
        ) + 1;
      if (!Number.isSafeInteger(sequence))
        throw new RoomRuleError("plan identity limit");
      map.work.planSeq = sequence;
      id = `pl-${String(sequence).padStart(2, "0")}`;
      rev = 0;
    }
  }
  return {
    id,
    roomId,
    rev,
    mode: input.mode,
    status: "proposed",
    goal: input.goal,
    items,
    backlog: [...(input.backlog ?? [])],
    acceptedAt: null,
    completedAt: null,
    cancelledAt: null,
    completionSummary: null,
  };
}
const semantics = (item: PlanItem): string =>
  JSON.stringify([
    item.title,
    item.owner,
    item.scope,
    item.after,
    item.criteria,
    item.verifier,
  ]);
export function planItemSatisfied(plan: RoomPlan, item: PlanItem): boolean {
  return plan.mode === "checklist"
    ? item.status === "done"
    : item.status === "verified" ||
        (item.status === "done" &&
          Number.isSafeInteger(item.acceptedChecklistRevision) &&
          item.acceptedChecklistRevision! >= 0 &&
          item.acceptedChecklistRevision! < plan.rev);
}
export function planItemsComplete(plan: RoomPlan): boolean {
  if (plan.mode === "autonomous") {
    const a = plan.autonomous;
    if (
      !a ||
      plan.items.some((item) => item.status !== "verified") ||
      a.halted ||
      a.integration.suspended ||
      a.integration.candidateHead ||
      a.integration.queue.length ||
      a.ops.some((op) => op.state === "intended") ||
      a.budget.reservations.length ||
      a.attempts.some((attempt) =>
        ["starting", "running", "submitted", "checking", "accepted", "queued"].includes(
          attempt.status,
        ),
      )
    )
      return false;
  }
  return plan.items.every((item) => planItemSatisfied(plan, item));
}
function ready(plan: RoomPlan, item: PlanItem): boolean {
  return item.after.every((id) => {
    const dependency = plan.items.find((other) => other.id === id);
    return dependency !== undefined && planItemSatisfied(plan, dependency);
  });
}
function log(
  item: PlanItem,
  by: string,
  status: PlanItemStatus,
  note: string | null,
  at: string,
): void {
  item.status = status;
  item.note = note;
  if (status !== "done") delete item.acceptedChecklistRevision;
  item.log.push({ by, status, note, at });
}
/** Returns the ids of the letters it wrote (the plan's status line, or none). */
function recalculate(map: WorkMap, letters: LetterTx, plan: RoomPlan, at: string): string[] {
  for (const item of plan.items)
    if (item.status === "waiting" || item.status === "ready")
      item.status = ready(plan, item) ? "ready" : "waiting";
  if (plan.status !== "active" || plan.mode === "autonomous") return [];
  if (planItemsComplete(plan)) {
    if (plan.mode === "verified") {
      plan.status = "completing";
      return [
        addSystemMessage(
          map,
          letters,
          plan.roomId,
          `Plan ${plan.id} is ready for completion`,
          at,
        ).id,
      ];
    }
    plan.status = "completed";
    plan.completedAt = at;
    capturePlanSnapshot(map, plan, "completed");
    return [addSystemMessage(map, letters, plan.roomId, `Plan ${plan.id} completed`, at).id];
  }
  return [];
}
export function acceptRoomPlan(
  map: WorkMap,
  letters: LetterTx,
  proposed: RoomPlan,
  at: string,
): void {
  edit(map, (draft) => {
    const room = planRoom(draft, proposed.roomId);
    if (isRoomClosed(draft, room) || (room.mode ?? "free") !== proposed.mode)
      throw new PlanConflictError("room mode or membership changed");
    const validated = validateDraft(draft, room, proposed);
    const existing = activeRoomPlan(draft, room.id);
    if (
      existing
        ? existing.id !== proposed.id || proposed.rev !== existing.rev + 1
        : draft.plans!.some((plan) => plan.id === proposed.id)
    )
      throw new PlanConflictError();
    const plan = { ...structuredClone(proposed), items: validated };
    plan.status = "active";
    plan.acceptedAt = at;
    const changed = new Set<number>();
    const promotionExempt = new Set<number>();
    if (existing) {
      for (const item of plan.items) {
        const previous = existing.items.find((old) => old.id === item.id);
        const sameCore =
          previous &&
          JSON.stringify([
            previous.title,
            previous.owner,
            previous.scope,
            previous.after,
          ]) ===
            JSON.stringify([item.title, item.owner, item.scope, item.after]);
        if (
          existing.mode === "checklist" &&
          plan.mode === "verified" &&
          existing.acceptedAt !== null &&
          previous?.status === "done" &&
          sameCore
        )
          promotionExempt.add(item.id);
        else if (!previous || semantics(previous) !== semantics(item))
          changed.add(item.id);
      }
      let grew = true;
      while (grew) {
        grew = false;
        for (const item of plan.items)
          if (
            !changed.has(item.id) &&
            item.after.some((id) => changed.has(id))
          ) {
            changed.add(item.id);
            grew = true;
          }
      }
      for (const item of plan.items) {
        const previous = existing.items.find((old) => old.id === item.id);
        if (previous && !changed.has(item.id)) {
          item.status = previous.status;
          item.evidence = structuredClone(previous.evidence);
          item.note = previous.note;
          item.log = structuredClone(previous.log);
          if (promotionExempt.has(item.id))
            item.acceptedChecklistRevision = existing.rev;
          else if (previous.acceptedChecklistRevision !== undefined)
            item.acceptedChecklistRevision = previous.acceptedChecklistRevision;
        } else if (previous)
          item.log = [
            ...structuredClone(previous.log),
            {
              by: HUMAN,
              at,
              status: "waiting",
              note: "Assignment changed; previous evidence invalidated.",
            },
          ];
      }
      draft.plans![draft.plans!.indexOf(existing)] = plan;
    } else draft.plans!.push(plan);
    for (const item of plan.items)
      if (item.status === "waiting" || item.status === "ready")
        item.status = ready(plan, item) ? "ready" : "waiting";
    capturePlanSnapshot(
      draft,
      plan,
      "accepted",
      existing?.items.filter(
        (old) => !plan.items.some((item) => item.id === old.id),
      ) ?? [],
    );
    recalculate(draft, letters, plan, at);
  }, letters);
}
function mutablePlan(
  map: WorkMap,
  id: string,
  rev: number,
  actor: string,
): RoomPlan {
  const plan = map.plans?.find((plan) => plan.id === id);
  // Архивная комната отказывает раньше конфликта ревизии: её план отменён при архивации, и «план изменился»
  // агенту ничего бы не объяснил.
  if (plan) requireOpenRoom(map, plan.roomId);
  if (!plan || plan.rev !== rev || !current(plan))
    throw new PlanConflictError();
  const room = planRoom(map, plan.roomId);
  if (isRoomClosed(map, room) || !participant(map, room, actor, plan.mode))
    throw new RoomRuleError("actor must be a live room participant");
  return plan;
}
function itemOf(plan: RoomPlan, id: number): PlanItem {
  const item = plan.items.find((item) => item.id === id);
  if (!item) throw new PlanConflictError("plan item not found");
  return item;
}
export function updatePlanItem(
  map: WorkMap,
  id: string,
  rev: number,
  itemId: number,
  actor: string,
  status: "in_progress" | "blocked",
  note?: string,
  at = new Date().toISOString(),
): void {
  edit(map, (draft) => {
    const plan = mutablePlan(draft, id, rev, actor);
    if (plan.mode === "autonomous")
      throw new RoomRuleError("autonomous plan is driven by the engine");
    const item = itemOf(plan, itemId);
    if (
      plan.status !== "active" ||
      !["ready", "in_progress", "returned", "blocked"].includes(item.status) ||
      (status === "in_progress" && !ready(plan, item))
    )
      throw new PlanConflictError();
    if (actor !== HUMAN && actor !== item.owner)
      throw new RoomRuleError("only the owner can update an item");
    if (
      !["in_progress", "blocked"].includes(status) ||
      (note !== undefined && !text(note)) ||
      (status === "blocked" && note === undefined)
    )
      throw new RoomRuleError("blocked items need a note");
    log(item, actor, status, note ?? null, at);
  });
}
export function submitPlanItem(
  map: WorkMap,
  letters: LetterTx,
  id: string,
  rev: number,
  itemId: number,
  actor: string,
  evidence: PlanEvidence,
  at = new Date().toISOString(),
): void {
  edit(map, (draft) => {
    const plan = mutablePlan(draft, id, rev, actor);
    if (plan.mode === "autonomous")
      throw new RoomRuleError("autonomous plan is driven by the engine");
    const item = itemOf(plan, itemId);
    if (
      plan.status !== "active" ||
      !["ready", "in_progress", "returned"].includes(item.status)
    )
      throw new PlanConflictError();
    if (actor !== HUMAN && actor !== item.owner)
      throw new RoomRuleError("only the owner can submit an item");
    if (
      !evidence ||
      !text(evidence.text) ||
      !Array.isArray(evidence.artifacts) ||
      evidence.artifacts.length > 30 ||
      evidence.artifacts.some(
        (file) =>
          typeof file !== "string" ||
          file.length > 1024 ||
          !file ||
          file.includes("\0") ||
          Buffer.from(file, "utf8").toString("utf8") !== file,
      ) ||
      evidence.text.length +
        evidence.artifacts.reduce((sum, file) => sum + file.length, 0) >
        PLAN_TEXT_MAX
    )
      throw new RoomRuleError("invalid evidence");
    item.evidence = structuredClone(evidence);
    log(item, actor, "done", null, at);
    recalculate(draft, letters, plan, at);
  }, letters);
}
export function verifyPlanItem(
  map: WorkMap,
  letters: LetterTx,
  id: string,
  rev: number,
  itemId: number,
  actor: string,
  verdict: "verified" | "returned",
  note: string,
  at = new Date().toISOString(),
): void {
  edit(map, (draft) => {
    const plan = mutablePlan(draft, id, rev, actor);
    if (plan.mode === "autonomous")
      throw new RoomRuleError("autonomous plan is driven by the engine");
    const item = itemOf(plan, itemId);
    const humanReturn =
      actor === HUMAN &&
      verdict === "returned" &&
      ["done", "verified"].includes(item.status);
    if (
      plan.mode !== "verified" ||
      (!humanReturn && (plan.status !== "active" || item.status !== "done"))
    )
      throw new PlanConflictError();
    if (actor !== HUMAN && (actor !== item.verifier || actor === item.owner))
      throw new RoomRuleError("only the independent verifier can verify");
    if (!["verified", "returned"].includes(verdict) || !text(note))
      throw new RoomRuleError("verification needs a note");
    log(item, actor, verdict, note, at);
    if (humanReturn) {
      plan.status = "active";
      plan.completionSummary = null;
      const room = planRoom(draft, plan.roomId);
      if (room.proposal?.kind === "completion") room.proposal = null;
      const invalid = new Set([item.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const dependent of plan.items)
          if (
            !invalid.has(dependent.id) &&
            dependent.after.some((id) => invalid.has(id))
          ) {
            invalid.add(dependent.id);
            grew = true;
            dependent.evidence = null;
            log(
              dependent,
              HUMAN,
              "waiting",
              "Dependency returned; previous evidence invalidated.",
              at,
            );
          }
      }
    }
    recalculate(draft, letters, plan, at);
  }, letters);
}
export function cancelRoomPlan(
  map: WorkMap,
  letters: LetterTx,
  id: string,
  rev: number,
  actor: string,
  at = new Date().toISOString(),
): void {
  edit(map, (draft) => {
    const plan = mutablePlan(draft, id, rev, actor);
    if (actor !== HUMAN)
      throw new RoomRuleError("only the human can cancel a plan");
    cancelPlan(draft, letters, plan, at);
  }, letters);
}
/** Отмена живого плана: статус, слот решения, снимок и строка ленты — общий шаг `cancelRoomPlan` и архивации комнаты. */
function cancelPlan(draft: WorkMap, letters: LetterTx, plan: RoomPlan, at: string): void {
  if (
    plan.mode === "autonomous" &&
    (plan.autonomous?.halted?.reason !== "human" || !autonomousCleanupComplete(draft, plan))
  )
    throw new RoomRuleError(
      "autonomous-plan-needs-engine-cancel: cancel the autonomous plan first",
    );
  plan.status = "cancelled";
  plan.cancelledAt = at;
  planRoom(draft, plan.roomId).proposal = null;
  capturePlanSnapshot(draft, plan, "cancelled");
  addSystemMessage(draft, letters, plan.roomId, `Plan ${plan.id} cancelled`, at);
}
function autonomousCleanupComplete(map: WorkMap, plan: RoomPlan): boolean {
  const a = plan.autonomous;
  if (!a || a.ops.some((op) => op.state === "intended") || a.budget.reservations.length)
    return false;
  const sessions = new Set([
    ...a.attempts.flatMap((attempt) => [attempt.worker, attempt.verifier]),
    ...a.ops
      .filter((op) => op.kind === "create-session" && op.state === "done")
      .map((op) => op.result?.sessionId),
  ]);
  if (map.sessions.some((session) => sessions.has(session.id) && session.lifecycle !== "closed"))
    return false;
  if (
    !a.ops.some(
      (op) =>
        op.kind === "cleanup" &&
        op.attemptId === null &&
        ["completion", "cancellation"].includes(String(op.payload.purpose)) &&
        op.state === "done",
    )
  )
    return false;
  return a.ops.every(
    (op, index) =>
      op.kind !== "clone" ||
      ["engine", "review", "mirror"].includes(String(op.payload.purpose)) ||
      a.ops
        .slice(index + 1)
        .some(
          (cleanup) =>
            cleanup.kind === "cleanup" &&
            cleanup.state === "done" &&
            (typeof op.payload.dir === "string"
              ? cleanup.payload.dir === op.payload.dir
              : cleanup.attemptId === op.attemptId),
        ),
  );
}
/**
 * Архивация комнаты (`archiveRoom`) отменяет её живой план так же, как человек (`cancelRoomPlan`), но без ревизии и
 * без проверок участника и «комната жива»: комнату архивирует человек целиком, а у закрытой комнаты живых участников
 * нет вовсе. Плана нет — карта не трогается (`edit` подменил бы `map.rooms` копией).
 */
export function cancelActiveRoomPlan(
  map: WorkMap,
  letters: LetterTx,
  roomId: string,
  at: string,
): void {
  if (activeRoomPlan(map, roomId) === undefined) return;
  edit(map, (draft) => {
    cancelPlan(draft, letters, activeRoomPlan(draft, roomId)!, at);
  }, letters);
}
/**
 * Switches the room mode. Returns the ids of the letters it wrote, in order (none when the mode is already set): a
 * recalculated plan may add its own lines before the "switched the room" line, which is always the last one.
 */
export function setRoomMode(
  map: WorkMap,
  letters: LetterTx,
  roomId: string,
  actor: string,
  mode: RoomMode,
  reason: string,
  options: { confirmCancel?: boolean } = {},
  at = new Date().toISOString(),
): string[] {
  return edit(map, (draft) => {
    const written: string[] = [];
    const room = requireOpenRoom(draft, roomId);
    const previous = room.mode ?? "free";
    const order = ["free", "checklist", "verified", "autonomous"];
    if (!order.includes(mode) || !text(reason) || /[\r\n]/.test(reason))
      throw new RoomRuleError("mode change needs a one-line reason");
    if (actor !== HUMAN) {
      requirePlanLead(draft, room, actor);
      if (order.indexOf(mode) < order.indexOf(previous))
        throw new RoomRuleError("only the human can lower room mode");
    } else if (isRoomClosed(draft, room))
      throw new RoomRuleError("room is closed");
    if (previous === mode) return written;
    const plan = activeRoomPlan(draft, roomId);
    if (mode === "free" && plan) {
      if (!options.confirmCancel)
        throw new RoomRuleError("confirm active plan cancellation");
      if (plan.mode === "autonomous") cancelPlan(draft, letters, plan, at);
      plan.status = "cancelled";
      plan.cancelledAt = at;
      capturePlanSnapshot(draft, plan, "cancelled");
    }
    room.mode = mode;
    room.proposal = null;
    if (previous === "verified" && mode === "checklist" && plan) {
      plan.mode = "checklist";
      plan.status = "active";
      for (const item of plan.items) {
        if (item.status === "verified") item.status = "done";
        else if (item.status === "returned") item.status = "in_progress";
        item.criteria = [];
        item.verifier = null;
        delete item.acceptedChecklistRevision;
      }
      written.push(...recalculate(draft, letters, plan, at));
    }
    written.push(
      addSystemMessage(
        draft,
        letters,
        roomId,
        `${actor === HUMAN ? "You" : actor} switched the room to ${mode}: ${reason}`,
        at,
      ).id,
    );
    return written;
  }, letters);
}
/** P23 consumes transitions for delivery; closed owners never retain an actionable assignment. */
export function reconcileRoomPlans(
  map: WorkMap,
  at = new Date().toISOString(),
): void {
  edit(map, (draft) => {
    for (const plan of draft.plans!.filter(current)) {
      // Автономный план завершает и убирает только движок, даже когда комната без живых участников.
      if (plan.mode === "autonomous") continue;
      const room = planRoom(draft, plan.roomId);
      if (isRoomClosed(draft, room)) {
        plan.status = "cancelled";
        plan.cancelledAt = at;
        room.proposal = null;
        capturePlanSnapshot(draft, plan, "cancelled");
        continue;
      }
      for (const item of plan.items)
        if (
          !liveOwner(draft, room, item.owner, plan.mode) &&
          item.status !== "blocked" &&
          !planItemSatisfied(plan, item)
        )
          log(item, "system", "blocked", "Owner is closed or deleted.", at);
    }
  });
}

export function completeRoomPlan(
  map: WorkMap,
  id: string,
  rev: number,
  action: "accept" | "return",
  summary: string,
  at: string,
): void {
  edit(map, (draft) => {
    const plan = mutablePlan(draft, id, rev, HUMAN);
    if (
      (plan.mode !== "verified" && plan.mode !== "autonomous") ||
      plan.status !== "completing" ||
      !planItemsComplete(plan)
    )
      throw new PlanConflictError();
    if (action === "return") {
      plan.status = "active";
      plan.completionSummary = null;
      return;
    }
    if (plan.mode === "autonomous" && !autonomousCleanupComplete(draft, plan))
      throw new PlanConflictError();
    plan.status = "completed";
    plan.completedAt = at;
    plan.completionSummary = summary;
    capturePlanSnapshot(draft, plan, "completed");
  });
}

/** Stored historical plans may reference departed participants; validate data, not present-day permissions. */
export function validatePlanStorage(map: WorkMap): void {
  if (
    map.work.planSeq !== undefined &&
    (!Number.isSafeInteger(map.work.planSeq) || map.work.planSeq < 0)
  )
    throw new Error("invalid stored plan sequence");
  if (
    !Array.isArray(map.plans) ||
    map.plans.length > 10_000 ||
    (map.planExports !== undefined &&
      (!Array.isArray(map.planExports) || map.planExports.length > 30_000))
  )
    throw new Error("invalid stored plans");
  const ids = new Set<string>();
  for (const plan of map.plans) {
    if (
      !plan ||
      !/^pl-\d+$/.test(plan.id) ||
      ids.has(plan.id) ||
      !map.rooms.some((room) => room.id === plan.roomId) ||
      !["checklist", "verified", "autonomous"].includes(plan.mode) ||
      !["proposed", "active", "completing", "completed", "cancelled"].includes(
        plan.status,
      ) ||
      !Number.isSafeInteger(plan.rev) ||
      plan.rev < 0 ||
      !text(plan.goal) ||
      !Array.isArray(plan.items) ||
      plan.items.length < 1 ||
      plan.items.length > PLAN_ITEM_MAX ||
      !Array.isArray(plan.backlog) ||
      plan.backlog.some((id) => !/^b-\d{3,}$/.test(id))
    )
      throw new Error("invalid stored plan");
    ids.add(plan.id);
    const itemIds = new Set(plan.items.map((item) => item.id));
    if (itemIds.size !== plan.items.length)
      throw new Error("invalid stored plan item");
    for (const item of plan.items)
      if (
        !Number.isSafeInteger(item.id) ||
        item.id < 1 ||
        !text(item.title) ||
        !text(item.scope) ||
        typeof item.owner !== "string" ||
        !Array.isArray(item.after) ||
        item.after.some((id) => !itemIds.has(id)) ||
        !Array.isArray(item.criteria) ||
        item.criteria.some((value) => !text(value)) ||
        (item.verifier !== null && typeof item.verifier !== "string") ||
        ![
          "waiting",
          "ready",
          "in_progress",
          "done",
          "blocked",
          "verified",
          "returned",
        ].includes(item.status) ||
        !Array.isArray(item.log) ||
        (item.acceptedChecklistRevision !== undefined &&
          (plan.mode !== "verified" ||
            item.status !== "done" ||
            item.evidence === null ||
            plan.acceptedAt === null ||
            !Number.isSafeInteger(item.acceptedChecklistRevision) ||
            item.acceptedChecklistRevision < 0 ||
            item.acceptedChecklistRevision >= plan.rev))
      )
        throw new Error("invalid stored plan item");
    const seen = new Set<number>();
    const visiting = new Set<number>();
    const visit = (id: number): void => {
      if (visiting.has(id)) throw new Error("stored plan dependency cycle");
      if (seen.has(id)) return;
      visiting.add(id);
      for (const dependency of plan.items.find((item) => item.id === id)!.after)
        visit(dependency);
      visiting.delete(id);
      seen.add(id);
    };
    for (const item of plan.items) visit(item.id);
  }
  for (const room of map.rooms)
    if (
      map.plans.filter((plan) => plan.roomId === room.id && current(plan))
        .length > 1
    )
      throw new Error("multiple active plans in room");
  for (const intent of map.planExports ?? [])
    if (
      !intent ||
      typeof intent.file !== "string" ||
      !/^w-\d+-r-\d+-pl-\d+-rev-\d+-(accepted|completed|cancelled)\.md$/.test(
        intent.file,
      ) ||
      !["pending", "written"].includes(intent.status) ||
      (!hasDigestOnly(intent) &&
        (typeof intent.content !== "string" ||
          Buffer.byteLength(intent.content) > 1024 * 1024))
    )
      throw new Error("invalid snapshot intent");
}
