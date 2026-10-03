import { createHash } from "node:crypto";
import type { BacklogDocument, BacklogWriteResult } from "./backlog.js";
import type { SharedWriteOptions, UpdateMapOptions } from "./store.js";
import { addMessage } from "./map.js";
import { isMember, isRoomClosed, liveLead, RoomRuleError } from "./rooms.js";
import { planItemSatisfied, reconcileRoomPlans } from "./plans.js";
import { PARLEY, HUMAN, SYSTEM } from "./types.js";
import type {
  Message,
  PlanBacklogIntent,
  PlanEffect,
  PlanItem,
  Room,
  RoomPlan,
  WorkMap,
} from "./types.js";

const WINDOW_MS = 60 * 60 * 1000;
const EFFECT_LIMIT = 30_000;
const EFFECT_BYTES = 4 * 1024 * 1024;
const KINDS = [
  "ready",
  "verify",
  "returned",
  "blocked",
  "completing",
  "mode",
  "completion-returned",
] as const;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  !value.includes("\0") &&
  Buffer.from(value, "utf8").toString("utf8") === value;
const id = (value: unknown, prefix: string): value is string =>
  bounded(value, 128) && new RegExp(`^${prefix}-\\d+$`).test(value);
const date = (value: unknown): value is string =>
  bounded(value, 128) && Number.isFinite(Date.parse(value));
const safe = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const current = (plan: RoomPlan): boolean =>
  ["active", "completing"].includes(plan.status);
const effectKey = (effect: Omit<PlanEffect, "key">): string =>
  `${effect.roomId}/${effect.planId ?? "mode"}/${effect.rev}/${effect.item ?? 0}/${effect.kind}/${effect.occurrence}/${effect.target}`;
function effect(
  room: Room,
  plan: RoomPlan | null,
  item: PlanItem | null,
  kind: PlanEffect["kind"],
  occurrence: string,
  target: string,
  text: string,
  at: string,
): PlanEffect {
  const value: Omit<PlanEffect, "key"> = {
    roomId: room.id,
    planId: plan?.id ?? null,
    rev: plan?.rev ?? 0,
    item: item?.id ?? null,
    kind,
    occurrence,
    target,
    text,
    createdAt: at,
    status: "queued",
    messageId: null,
  };
  return { ...value, key: effectKey(value) };
}
function actionable(map: WorkMap, room: Room, target: string): boolean {
  return (
    !isRoomClosed(map, room) &&
    isMember(room, target) &&
    map.sessions.some((row) => row.id === target && row.lifecycle !== "closed")
  );
}
function itemEffect(
  map: WorkMap,
  plan: RoomPlan,
  item: PlanItem,
  at: string,
): PlanEffect | null {
  const room = map.rooms.find((row) => row.id === plan.roomId);
  if (!room || !current(plan) || isRoomClosed(map, room)) return null;
  const header = `Accepted plan ${plan.id}, revision ${plan.rev}, item ${item.id}: ${item.title}`;
  const assignment = `${header}\nScope:\n${item.scope}${plan.mode === "verified" ? `\nCriteria:\n${item.criteria.join("\n")}` : ""}`;
  let kind: PlanEffect["kind"];
  let target: string;
  let text: string;
  if (item.status === "ready") {
    kind = "ready";
    target = item.owner;
    text = `${assignment}\nPerform this accepted assignment; use plan_update and plan_submit with this exact planId/rev/item. A skill named in scope is guidance, not automatic loading.`;
  } else if (
    item.status === "done" &&
    plan.mode === "verified" &&
    !planItemSatisfied(plan, item)
  ) {
    kind = "verify";
    target = item.verifier ?? liveLead(map, room) ?? "";
    text = `${assignment}\nEvidence:\n${item.evidence?.text ?? ""}\n${item.evidence?.artifacts.join("\n") ?? ""}\nIndependently inspect the result and call plan_verify with this exact planId/rev/item.`;
  } else if (item.status === "returned") {
    kind = "returned";
    target = item.owner;
    text = `${assignment}\nReturned for rework: ${item.note ?? ""}\nAddress this note, then call plan_submit with this exact planId/rev/item.`;
  } else if (item.status === "blocked") {
    kind = "blocked";
    target = liveLead(map, room) ?? "";
    text = `${header}\nBlocked: ${item.note ?? "Owner is unavailable."}\nBring an amended decision if this assignment must change.`;
  } else return null;
  return actionable(map, room, target)
    ? effect(room, plan, item, kind, String(item.log.length), target, text, at)
    : null;
}
function completionEffect(
  map: WorkMap,
  plan: RoomPlan,
  at: string,
): PlanEffect | null {
  const room = map.rooms.find((row) => row.id === plan.roomId);
  if (!room || plan.status !== "completing") return null;
  const target = liveLead(map, room) ?? "";
  if (!actionable(map, room, target)) return null;
  return effect(
    room,
    plan,
    null,
    "completing",
    plan.items.map((row) => `${row.id}:${row.log.length}`).join(","),
    target,
    `Plan ${plan.id}, revision ${plan.rev} is ready for human completion. Collect remaining work through backlog_list/backlog_suggest, then call propose_completion with this exact planId/rev and a summary.`,
    at,
  );
}
/** Ownership is exact; a record cannot suppress or revive an unrelated letter. */
export function planEffectOwnsLetter(
  effect: PlanEffect,
  message: Message,
): boolean {
  return (
    effect.messageId !== null &&
    message.id === effect.messageId &&
    message.from === PARLEY &&
    message.kind === "note" &&
    message.roomId === effect.roomId &&
    message.to.length === 1 &&
    message.to[0] === effect.target &&
    message.text === effect.text
  );
}
export function currentPlanEffect(map: WorkMap, value: PlanEffect): boolean {
  const room = map.rooms.find((row) => row.id === value.roomId);
  if (!room || !actionable(map, room, value.target)) return false;
  const plan = map.plans?.find(
    (row) =>
      row.id === value.planId &&
      row.roomId === room.id &&
      row.rev === value.rev,
  );
  if (value.kind === "mode" || value.kind === "completion-returned") {
    const source = map.messages.find(
      (row) => row.id === value.occurrence && row.roomId === room.id,
    );
    if (!source || liveLead(map, room) !== value.target) return false;
    if (value.kind === "mode")
      return (
        source.from === SYSTEM &&
        source.to.includes(HUMAN) &&
        source.text.includes(
          ` switched the room to ${room.mode ?? "free"}: `,
        ) &&
        value.text ===
          `Room mode changed. ${source.text}\nBring a plan matching the current mode before proceeding.`
      );
    return (
      plan !== undefined &&
      current(plan) &&
      source.from === HUMAN &&
      source.to.length === 1 &&
      source.to[0] === HUMAN &&
      value.text ===
        `Plan ${plan.id}, revision ${plan.rev}: ${source.text}\nRevise the completion summary or propose an amended decision.`
    );
  }
  if (!plan || !current(plan)) return false;
  const item =
    value.item === null
      ? null
      : plan.items.find((row) => row.id === value.item);
  if (value.item !== null && !item) return false;
  const expected =
    item === null
      ? completionEffect(map, plan, value.createdAt)
      : itemEffect(map, plan, item!, value.createdAt);
  return (
    expected !== null &&
    expected.key === value.key &&
    expected.text === value.text
  );
}
/** Capture an actual trusted mode/return occurrence; this is not an API accepting caller identities. */
export function capturePlanNotice(
  map: WorkMap,
  roomId: string,
  kind: "mode" | "completion-returned",
  sourceId: string,
  planId?: string,
): void {
  const room = map.rooms.find((row) => row.id === roomId);
  const source = map.messages.find(
    (row) => row.id === sourceId && row.roomId === roomId,
  );
  if (!room || !source)
    throw new RoomRuleError("plan notice source is unavailable");
  const plan =
    planId === undefined
      ? null
      : (map.plans?.find((row) => row.id === planId && row.roomId === roomId) ??
        null);
  const target = liveLead(map, room) ?? "";
  const text =
    kind === "mode"
      ? `Room mode changed. ${source.text}\nBring a plan matching the current mode before proceeding.`
      : `Plan ${plan?.id}, revision ${plan?.rev}: ${source.text}\nRevise the completion summary or propose an amended decision.`;
  const value = effect(
    room,
    plan,
    null,
    kind,
    sourceId,
    target,
    text,
    source.at,
  );
  if (!currentPlanEffect(map, value))
    throw new RoomRuleError("plan notice proof is unavailable");
  map.planEffects ??= [];
  if (!map.planEffects.some((row) => row.key === value.key))
    map.planEffects.push(value);
}
export interface PlanReservation {
  changed: boolean;
  queued: number;
  nextDueAt: number | null;
}
/** Called under map.lock: reserve occurrence and letter together before existing wake sees either. */
export function reservePlanEffects(
  map: WorkMap,
  messageRate: number,
  at = new Date().toISOString(),
): PlanReservation {
  const draft: WorkMap = {
    ...map,
    work: { ...map.work },
    rooms: structuredClone(map.rooms),
    messages: [...map.messages],
    plans: structuredClone(map.plans ?? []),
    planExports: structuredClone(map.planExports ?? []),
    planEffects: structuredClone(map.planEffects ?? []),
    planBacklogIntents: structuredClone(map.planBacklogIntents ?? []),
  };
  const result = reserve(draft, messageRate, at);
  if (result.changed)
    Object.assign(map, {
      work: draft.work,
      rooms: draft.rooms,
      messages: draft.messages,
      plans: draft.plans,
      planExports: draft.planExports,
      planEffects: draft.planEffects,
      planBacklogIntents: draft.planBacklogIntents,
    });
  return result;
}
function reserve(
  map: WorkMap,
  messageRate: number,
  at: string,
): PlanReservation {
  if (!date(at) || !Number.isSafeInteger(messageRate) || messageRate < 1)
    throw new RoomRuleError("invalid plan delivery budget");
  const before = JSON.stringify([
    map.plans,
    map.planExports,
    map.planEffects,
    map.planBacklogIntents,
  ]);
  reconcileRoomPlans(map, at);
  map.planEffects ??= [];
  map.planBacklogIntents ??= [];
  const append = (value: PlanEffect | null): void => {
    if (value && !map.planEffects!.some((row) => row.key === value.key))
      map.planEffects!.push(value);
  };
  for (const plan of map.plans ?? []) {
    for (const item of plan.items) append(itemEffect(map, plan, item, at));
    append(completionEffect(map, plan, at));
    if (plan.status === "completed" && plan.completedAt !== null)
      for (const backlogId of plan.backlog) {
        const key = `${plan.id}/${plan.rev}/${backlogId}/${plan.completedAt}`;
        if (!map.planBacklogIntents.some((row) => row.key === key))
          map.planBacklogIntents.push({
            key,
            planId: plan.id,
            rev: plan.rev,
            backlogId,
            completedAt: plan.completedAt,
            status: "pending",
          });
      }
  }
  if (
    map.planEffects.length > EFFECT_LIMIT ||
    map.planBacklogIntents.length > EFFECT_LIMIT ||
    Buffer.byteLength(
      JSON.stringify([map.planEffects, map.planBacklogIntents]),
    ) > EFFECT_BYTES
  )
    throw new RoomRuleError("plan effect storage limit reached");
  const now = Date.parse(at);
  const recent = map.messages.filter(
    (row) => row.from === PARLEY && now - Date.parse(row.at) < WINDOW_MS,
  );
  let available = Math.max(0, messageRate - recent.length);
  for (const value of map.planEffects) {
    if (value.status === "cancelled") continue;
    if (!currentPlanEffect(map, value)) {
      value.status = "cancelled";
      continue;
    }
    if (value.status !== "queued" || available === 0) continue;
    const message = addMessage(
      map,
      {
        from: PARLEY,
        roomId: value.roomId,
        to: [value.target],
        text: value.text,
        kind: "note",
      },
      at,
    );
    value.status = "sent";
    value.messageId = message.id;
    available--;
  }
  const queued = map.planEffects.filter(
    (row) => row.status === "queued",
  ).length;
  const nextDueAt = queued
    ? Math.max(
        now + 1,
        Math.min(
          ...recent.map((row) => Date.parse(row.at) + WINDOW_MS),
          now + WINDOW_MS,
        ),
      )
    : null;
  return {
    changed:
      before !==
      JSON.stringify([
        map.plans,
        map.planExports,
        map.planEffects,
        map.planBacklogIntents,
      ]),
    queued,
    nextDueAt,
  };
}
/** Only validated current owned messages escape restart's ordinary stale-unread suppression. */
export function resumablePlanLetter(
  map: WorkMap,
  message: Message,
  recipient: string,
): boolean {
  return (map.planEffects ?? []).some(
    (value) =>
      value.status === "sent" &&
      value.target === recipient &&
      planEffectOwnsLetter(value, message) &&
      currentPlanEffect(map, value),
  );
}
export function cancelledPlanLetter(map: WorkMap, message: Message): boolean {
  return (map.planEffects ?? []).some(
    (value) =>
      value.status === "cancelled" && planEffectOwnsLetter(value, message),
  );
}
export function validatePlanEffects(map: WorkMap): void {
  const effects = map.planEffects ?? [];
  const closures = map.planBacklogIntents ?? [];
  if (
    !Array.isArray(effects) ||
    !Array.isArray(closures) ||
    effects.length > EFFECT_LIMIT ||
    closures.length > EFFECT_LIMIT ||
    Buffer.byteLength(JSON.stringify([effects, closures])) > EFFECT_BYTES
  )
    throw new Error("invalid plan effects");
  const keys = new Set<string>();
  for (const value of effects) {
    if (
      !value ||
      !bounded(value.key, 4096) ||
      keys.has(value.key) ||
      !id(value.roomId, "r") ||
      (value.planId !== null && !id(value.planId, "pl")) ||
      !safe(value.rev) ||
      (value.item !== null && (!safe(value.item) || value.item === 0)) ||
      !KINDS.includes(value.kind) ||
      ["ready", "verify", "returned", "blocked"].includes(value.kind) !==
        (value.item !== null) ||
      (value.kind === "mode"
        ? value.planId !== null || value.rev !== 0
        : value.planId === null) ||
      !bounded(value.occurrence, 2048) ||
      !id(value.target, "s") ||
      !bounded(value.text, 32768) ||
      !date(value.createdAt) ||
      !["queued", "sent", "cancelled"].includes(value.status) ||
      (value.messageId !== null && !id(value.messageId, "m")) ||
      (value.status === "queued" && value.messageId !== null) ||
      (value.status === "sent" && value.messageId === null) ||
      value.key !== effectKey(value)
    )
      throw new Error("invalid plan effect");
    keys.add(value.key);
  }
  keys.clear();
  for (const value of closures) {
    if (
      !value ||
      !id(value.planId, "pl") ||
      !safe(value.rev) ||
      !bounded(value.backlogId, 128) ||
      !/^b-\d{3,}$/.test(value.backlogId) ||
      !date(value.completedAt) ||
      value.key !==
        `${value.planId}/${value.rev}/${value.backlogId}/${value.completedAt}` ||
      keys.has(value.key) ||
      !completionProof(map, value) ||
      !["pending", "written", "conflict"].includes(value.status) ||
      (value.expectedVersion === undefined) !==
        (value.itemFingerprint === undefined) ||
      (value.expectedVersion !== undefined &&
        (!value.expectedVersion ||
          !bounded(value.expectedVersion, 512) ||
          !bounded(value.itemFingerprint, 64) ||
          !/^[a-f0-9]{64}$/.test(value.itemFingerprint))) ||
      (value.code !== undefined &&
        !["backlog-conflict", "backlog-unavailable"].includes(value.code))
    )
      throw new Error("invalid plan backlog intent");
    keys.add(value.key);
  }
}
/** Semantic source proof excludes only completion markers, which this exact captured intent writes. */
export function backlogItemFingerprint(item: {
  title: string;
  details: string;
  section: string | null;
  taken?: string;
  by?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        item.title,
        item.details,
        item.section,
        item.taken ?? null,
        item.by ?? null,
      ]),
    )
    .digest("hex");
}

export interface PlanEffectsIO {
  readMap(projectPath: string, workId: string): Promise<WorkMap>;
  updateMap(
    projectPath: string,
    workId: string,
    mutate: (map: WorkMap) => void,
    options?: UpdateMapOptions,
  ): Promise<WorkMap>;
  readBacklog(projectPath: string): Promise<BacklogDocument>;
  completeBacklogItem(
    projectPath: string,
    id: string,
    done: string,
    options?: SharedWriteOptions,
  ): Promise<BacklogWriteResult>;
}
export interface PlanBacklogFlushResult {
  written: string[];
  failed: {
    planId: string;
    rev: number;
    backlogId: string;
    code: "backlog-conflict" | "backlog-unavailable";
  }[];
}
function completionProof(map: WorkMap, value: PlanBacklogIntent): boolean {
  return (
    map.plans?.some(
      (plan) =>
        plan.id === value.planId &&
        plan.rev === value.rev &&
        plan.status === "completed" &&
        plan.completedAt === value.completedAt &&
        plan.backlog.includes(value.backlogId),
    ) ?? false
  );
}
class NoPlanChange extends Error {}
async function updateIntent(
  io: PlanEffectsIO,
  projectPath: string,
  workId: string,
  captured: PlanBacklogIntent,
  mutate: (value: PlanBacklogIntent) => void,
): Promise<void> {
  try {
    await io.updateMap(
      projectPath,
      workId,
      (map) => {
        const value = map.planBacklogIntents?.find(
          (row) => row.key === captured.key,
        );
        if (
          !value ||
          value.status === "written" ||
          !completionProof(map, value)
        )
          throw new NoPlanChange();
        const before = JSON.stringify(value);
        mutate(value);
        if (before === JSON.stringify(value)) throw new NoPlanChange();
      },
      { touch: false },
    );
  } catch (error) {
    if (!(error instanceof NoPlanChange)) throw error;
  }
}
/** Map preparation/ack and shared Markdown write are separate sequential transactions.
 * A persisted pre-write version proves safe retry; changed unchecked data is never blindly rebased.
 */
export async function flushPlanBacklog(
  projectPath: string,
  workId: string,
  options: { io?: PlanEffectsIO; excludedKeys?: ReadonlySet<string> } = {},
): Promise<PlanBacklogFlushResult> {
  const io: PlanEffectsIO = options.io ?? {
    ...(await import("./store.js")),
    ...(await import("./backlog.js")),
  };
  const initial = await io.readMap(projectPath, workId);
  const result: PlanBacklogFlushResult = { written: [], failed: [] };
  for (const captured of initial.planBacklogIntents?.filter(
    (row) => row.status !== "written" && !options.excludedKeys?.has(row.key),
  ) ?? []) {
    let conflict = false;
    let value = captured;
    try {
      if (!completionProof(initial, captured))
        throw new RoomRuleError("completion proof changed");
      let document = await io.readBacklog(projectPath);
      let item = document.items.find((row) => row.id === value.backlogId);
      if (!item) {
        conflict = true;
        throw new RoomRuleError("backlog item changed");
      }
      if (value.expectedVersion === undefined && item.checked) {
        // Another flusher must persist its preparation before its Markdown write; reread that proof.
        const latest = await io.readMap(projectPath, workId);
        const prepared = latest.planBacklogIntents?.find(
          (row) => row.key === captured.key,
        );
        if (prepared && completionProof(latest, prepared)) {
          if (prepared.status === "written") {
            result.written.push(prepared.key);
            continue;
          }
          value = prepared;
        }
        if (value.expectedVersion === undefined) {
          conflict = true;
          throw new RoomRuleError("backlog item was already closed");
        }
      }
      if (value.expectedVersion === undefined) {
        const expectedVersion = document.version;
        const itemFingerprint = backlogItemFingerprint(item);
        await updateIntent(io, projectPath, workId, captured, (current) => {
          if (current.expectedVersion !== undefined) return;
          current.expectedVersion = expectedVersion;
          current.itemFingerprint = itemFingerprint;
          current.status = "pending";
          delete current.code;
        });
        const current = await io.readMap(projectPath, workId);
        const prepared = current.planBacklogIntents?.find(
          (row) => row.key === captured.key,
        );
        if (!prepared || !completionProof(current, prepared))
          throw new RoomRuleError("completion proof changed");
        if (prepared.status === "written") {
          result.written.push(prepared.key);
          continue;
        }
        value = prepared;
        document = await io.readBacklog(projectPath);
        item = document.items.find((row) => row.id === value.backlogId);
      }
      const done = value.completedAt.slice(0, 10);
      if (
        !item ||
        backlogItemFingerprint(item) !== value.itemFingerprint ||
        (item.checked
          ? item.done !== done
          : document.version !== value.expectedVersion)
      ) {
        conflict = true;
        throw new RoomRuleError("backlog item changed");
      }
      if (!item.checked)
        await io.completeBacklogItem(projectPath, value.backlogId, done, {
          expectedVersion: value.expectedVersion!,
        });
      await updateIntent(io, projectPath, workId, value, (current) => {
        if (
          current.expectedVersion !== value.expectedVersion ||
          current.itemFingerprint !== value.itemFingerprint
        )
          throw new RoomRuleError("completion proof changed");
        current.status = "written";
        delete current.code;
      });
      result.written.push(value.key);
    } catch (error) {
      // A concurrent writer or a lost write reply may have committed this exact prepared intent.
      // Confirm its original semantic payload and completion date; never rebase unchecked data.
      const nativeConflict =
        error instanceof (await import("./store.js")).SharedStateError &&
        error.code === "backlog-conflict";
      if (nativeConflict) {
        conflict = true;
        try {
          const latest = await io.readMap(projectPath, workId);
          const prepared = latest.planBacklogIntents?.find(
            (row) => row.key === captured.key,
          );
          if (prepared && completionProof(latest, prepared)) {
            if (prepared.status === "written") {
              result.written.push(prepared.key);
              continue;
            }
            if (prepared.expectedVersion !== undefined) {
              const document = await io.readBacklog(projectPath);
              const item = document.items.find(
                (row) => row.id === prepared.backlogId,
              );
              if (
                item?.checked &&
                item.done === prepared.completedAt.slice(0, 10) &&
                backlogItemFingerprint(item) === prepared.itemFingerprint
              ) {
                await updateIntent(
                  io,
                  projectPath,
                  workId,
                  prepared,
                  (current) => {
                    current.status = "written";
                    delete current.code;
                  },
                );
                result.written.push(prepared.key);
                continue;
              }
            }
          }
        } catch {
          /* Keep the original intent available when acknowledgement cannot be recorded. */
        }
      }
      const code = conflict
        ? ("backlog-conflict" as const)
        : ("backlog-unavailable" as const);
      try {
        await updateIntent(io, projectPath, workId, captured, (value) => {
          value.status = conflict ? "conflict" : "pending";
          value.code = code;
        });
      } catch {
        /* The original durable intent survives an acknowledgement/storage failure. */
      }
      result.failed.push({
        planId: captured.planId,
        rev: captured.rev,
        backlogId: captured.backlogId,
        code,
      });
    }
  }
  return result;
}
export interface PlanEffectsSummary {
  queued: number;
  pendingSnapshots: number;
  pendingBacklog: number;
  conflictCount: number;
  conflicts: (
    | {
        planId: string;
        rev: number;
        backlogId: string;
        code: "backlog-conflict" | "backlog-unavailable";
      }
    | {
        planId: string;
        rev: number;
        code: "snapshot-conflict" | "snapshot-unavailable";
      }
  )[];
}
export function summarizePlanEffects(map: WorkMap): PlanEffectsSummary {
  const conflicts = (map.planBacklogIntents ?? []).filter(
    (row) => row.code !== undefined,
  );
  return {
    queued: (map.planEffects ?? []).filter((row) => row.status === "queued")
      .length,
    pendingSnapshots: (map.planExports ?? []).filter(
      (row) => row.status === "pending",
    ).length,
    pendingBacklog: (map.planBacklogIntents ?? []).filter(
      (row) => row.status !== "written",
    ).length,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 100).map((row) => ({
      planId: row.planId,
      rev: row.rev,
      backlogId: row.backlogId,
      code: row.code!,
    })),
  };
}
/** Always invoked after updateMap returns; snapshot bytes remain the accepted captured revision. */
export async function flushPlanEffects(
  projectPath: string,
  workId: string,
  options: {
    excludedSnapshotFiles?: ReadonlySet<string>;
    excludedBacklogKeys?: ReadonlySet<string>;
  } = {},
): Promise<{
  effects: PlanEffectsSummary;
  backlogFailures?: PlanBacklogFlushResult["failed"];
  snapshotFailures: {
    file: string;
    code: "snapshot-conflict" | "snapshot-invalid" | "snapshot-write-failed";
  }[];
}> {
  const snapshots = await (
    await import("./plan-snapshots.js")
  ).flushPlanSnapshots(projectPath, workId, {
    ...(options.excludedSnapshotFiles
      ? { excludedFiles: options.excludedSnapshotFiles }
      : {}),
  });
  const backlog = await flushPlanBacklog(projectPath, workId, {
    ...(options.excludedBacklogKeys
      ? { excludedKeys: options.excludedBacklogKeys }
      : {}),
  });
  const map = await (await import("./store.js")).readMap(projectPath, workId);
  return {
    effects: summarizePlanEffects(map),
    snapshotFailures: snapshots.failed,
    backlogFailures: backlog.failed,
  };
}
