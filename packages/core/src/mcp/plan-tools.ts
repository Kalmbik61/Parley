import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import {
  capturePlanNotice,
  flushPlanEffects,
  reservePlanEffects,
} from "../work/plan-effects.js";
import {
  setRoomMode,
  reconcileRoomPlans,
  submitPlanItem,
  updatePlanItem,
  verifyPlanItem,
  PlanConflictError,
} from "../work/plans.js";
import {
  proposeCompletion,
  setProposal,
  ProposalConflictError,
} from "../work/proposals.js";
import { RoomRuleError } from "../work/rooms.js";
import { readMap, updateMap } from "../work/store.js";
import type { PlanDraft, PlanEvidence, WorkMap } from "../work/types.js";
import type { McpContext } from "./context.js";

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const text = { type: "string", minLength: 1, maxLength: 10000 };
const revision = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const identity = {
  planId: { type: "string", pattern: "^pl-[0-9]+$", maxLength: 128 },
  rev: revision,
};
const item = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const evidence = {
  type: "object",
  properties: {
    text,
    artifacts: {
      type: "array",
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 1024 },
    },
  },
  required: ["text", "artifacts"],
  additionalProperties: false,
};
export const PLAN_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    id: identity.planId,
    rev: revision,
    mode: { type: "string", enum: ["checklist", "verified"] },
    goal: text,
    items: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        properties: {
          id: item,
          title: text,
          owner: { type: "string", pattern: "^s-[0-9]+$", maxLength: 128 },
          scope: text,
          after: { type: "array", maxItems: 30, items: item },
          criteria: { type: "array", maxItems: 10, items: text },
          verifier: {
            type: ["string", "null"],
            pattern: "^s-[0-9]+$",
            maxLength: 128,
          },
        },
        required: ["id", "title", "owner", "scope"],
        additionalProperties: false,
      },
    },
    backlog: {
      type: "array",
      maxItems: 30,
      items: { type: "string", pattern: "^b-[0-9]{3,}$", maxLength: 128 },
    },
  },
  required: ["mode", "goal", "items"],
  additionalProperties: false,
};
export const PLAN_TOOLS: Tool[] = [
  {
    name: "set_room_mode",
    annotations: WRITE,
    description:
      "The live lead may raise the room mode with a one-line reason. Only the human can lower it.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", pattern: "^r-[0-9]+$", maxLength: 128 },
        mode: { type: "string", enum: ["free", "checklist", "verified"] },
        reason: text,
      },
      required: ["room", "mode", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_update",
    annotations: WRITE,
    description:
      "Update your accepted plan item using its exact current revision; blocked needs a note.",
    inputSchema: {
      type: "object",
      properties: {
        ...identity,
        item,
        status: { type: "string", enum: ["in_progress", "blocked"] },
        note: text,
      },
      required: ["planId", "rev", "item", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_submit",
    annotations: WRITE,
    description:
      "Submit evidence for your accepted plan item. Verified mode still requires independent verification.",
    inputSchema: {
      type: "object",
      properties: { ...identity, item, evidence },
      required: ["planId", "rev", "item", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_verify",
    annotations: WRITE,
    description:
      "Independently verify or return an item using its exact revision and a reason. The owner cannot verify their own item.",
    inputSchema: {
      type: "object",
      properties: {
        ...identity,
        item,
        verdict: { type: "string", enum: ["verified", "returned"] },
        note: text,
      },
      required: ["planId", "rev", "item", "verdict", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_completion",
    annotations: WRITE,
    description:
      "The live lead brings the current fully verified plan summary for human acceptance. Check backlog suggestions for remaining findings first.",
    inputSchema: {
      type: "object",
      properties: { ...identity, summary: text },
      required: ["planId", "rev", "summary"],
      additionalProperties: false,
    },
  },
];
const names = new Set(PLAN_TOOLS.map((tool) => tool.name));
export const isPlanTool = (name: string): boolean => names.has(name);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RoomRuleError("unexpected plan argument");
}
function validText(value: unknown, limit = 10000): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("\0") &&
    value.length <= limit &&
    Buffer.from(value).toString() === value
  );
}
function safe(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0)
  );
}
function draft(value: unknown): PlanDraft {
  if (!record(value)) throw new RoomRuleError("invalid plan draft");
  keys(value, ["id", "rev", "mode", "goal", "items", "backlog"]);
  if (
    !["checklist", "verified"].includes(String(value.mode)) ||
    !validText(value.goal) ||
    (value.id === undefined) !== (value.rev === undefined) ||
    (value.id !== undefined &&
      (typeof value.id !== "string" ||
        !/^pl-\d+$/.test(value.id) ||
        value.id.length > 128 ||
        !safe(value.rev))) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 30
  )
    throw new RoomRuleError("invalid plan draft");
  for (const entry of value.items) {
    if (!record(entry)) throw new RoomRuleError("invalid plan item");
    keys(entry, [
      "id",
      "title",
      "owner",
      "scope",
      "after",
      "criteria",
      "verifier",
    ]);
    if (
      !safe(entry.id, true) ||
      !validText(entry.title) ||
      !validText(entry.scope) ||
      typeof entry.owner !== "string" ||
      !/^s-\d+$/.test(entry.owner) ||
      entry.owner.length > 128 ||
      (entry.after !== undefined &&
        (!Array.isArray(entry.after) ||
          entry.after.length > 30 ||
          !entry.after.every((value) => safe(value, true)))) ||
      (entry.criteria !== undefined &&
        (!Array.isArray(entry.criteria) ||
          entry.criteria.length > 10 ||
          !entry.criteria.every((value) => validText(value)))) ||
      (entry.verifier !== undefined &&
        entry.verifier !== null &&
        (typeof entry.verifier !== "string" ||
          !/^s-\d+$/.test(entry.verifier) ||
          entry.verifier.length > 128))
    )
      throw new RoomRuleError("invalid plan item");
  }
  if (
    value.backlog !== undefined &&
    (!Array.isArray(value.backlog) ||
      value.backlog.length > 30 ||
      !value.backlog.every(
        (value) =>
          typeof value === "string" &&
          /^b-\d{3,}$/.test(value) &&
          value.length <= 128,
      ))
  )
    throw new RoomRuleError("invalid plan backlog");
  return value as unknown as PlanDraft;
}
function caller(map: WorkMap, context: McpContext): string {
  const session = map.sessions.find((row) => row.id === context.sessionId);
  if (
    map.work.id !== context.workId ||
    map.work.status !== "active" ||
    !session ||
    session.lifecycle === "closed"
  )
    throw new RoomRuleError("a live launched caller is required");
  return session.id;
}
async function finish(context: McpContext): Promise<unknown> {
  try {
    return (await flushPlanEffects(context.projectPath, context.workId))
      .effects;
  } catch {
    return {
      ...(await import("../work/plan-effects.js")).summarizePlanEffects(
        await readMap(context.projectPath, context.workId),
      ),
      unavailable: true,
    };
  }
}
/** Internal context supplies all actor/location fields. The MCP schema is repeated here because calls can bypass ListTools validation. */
export async function planTool(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024)
      throw new RoomRuleError("plan arguments are too large");
    const config = (await loadConfig()).config;
    let proposed: { proposalId: string; rev: number } | undefined;
    let legacyFree = false;
    await updateMap(context.projectPath, context.workId, (map) => {
      const actor = caller(map, context);
      reconcileRoomPlans(map);
      if (name === "set_room_mode") {
        keys(args, ["room", "mode", "reason"]);
        if (
          typeof args.room !== "string" ||
          !/^r-\d+$/.test(args.room) ||
          args.room.length > 128 ||
          !["free", "checklist", "verified"].includes(String(args.mode)) ||
          !validText(args.reason) ||
          /[\r\n]/.test(args.reason)
        )
          throw new RoomRuleError("invalid room mode");
        const before = map.messages.length;
        setRoomMode(
          map,
          args.room,
          actor,
          args.mode as "free" | "checklist" | "verified",
          args.reason,
        );
        const source = map.messages
          .slice(before)
          .find((row) => row.roomId === args.room && row.from === "system");
        if (source) capturePlanNotice(map, args.room, "mode", source.id);
      } else if (name === "propose_decision") {
        keys(args, ["room", "text", "plan", "kind", "planId", "rev"]);
        if (
          typeof args.room !== "string" ||
          !/^r-\d+$/.test(args.room) ||
          args.room.length > 128
        )
          throw new RoomRuleError("argument room: a valid room ID is required");
        if (!validText(args.text))
          throw new RoomRuleError(
            "argument text: nonempty text within 10000 characters is required",
          );
        if (args.kind === "completion") {
          if (
            args.plan !== undefined ||
            typeof args.planId !== "string" ||
            !/^pl-\d+$/.test(args.planId) ||
            args.planId.length > 128 ||
            !safe(args.rev)
          )
            throw new RoomRuleError("invalid completion decision");
          proposed = proposeCompletion(
            map,
            args.room,
            actor,
            args.planId,
            args.rev,
            args.text,
          );
        } else {
          if (
            (args.kind !== undefined && args.kind !== "decision") ||
            args.planId !== undefined ||
            args.rev !== undefined
          )
            throw new RoomRuleError("invalid plan decision");
          proposed = setProposal(
            map,
            args.room,
            actor,
            args.text,
            undefined,
            args.plan === undefined ? {} : { plan: draft(args.plan) },
          );
          legacyFree =
            (map.rooms.find((room) => room.id === args.room)?.mode ?? "free") ===
            "free";
        }
      } else {
        const allowed =
          name === "plan_update"
            ? ["planId", "rev", "item", "status", "note"]
            : name === "plan_submit"
              ? ["planId", "rev", "item", "evidence"]
              : name === "plan_verify"
                ? ["planId", "rev", "item", "verdict", "note"]
                : ["planId", "rev", "summary"];
        keys(args, allowed);
        if (
          !isPlanTool(name) ||
          typeof args.planId !== "string" ||
          !/^pl-\d+$/.test(args.planId) ||
          args.planId.length > 128 ||
          !safe(args.rev)
        )
          throw new RoomRuleError("invalid plan identity");
        if (name === "propose_completion") {
          if (!validText(args.summary))
            throw new RoomRuleError("invalid completion summary");
          const plan = map.plans?.find((row) => row.id === args.planId);
          if (!plan) throw new PlanConflictError();
          proposed = proposeCompletion(
            map,
            plan.roomId,
            actor,
            args.planId,
            args.rev,
            args.summary,
          );
        } else {
          if (!safe(args.item, true))
            throw new RoomRuleError("invalid plan item");
          if (name === "plan_update") {
            if (
              !["in_progress", "blocked"].includes(String(args.status)) ||
              (args.note !== undefined && !validText(args.note))
            )
              throw new RoomRuleError("invalid plan update");
            updatePlanItem(
              map,
              args.planId,
              args.rev,
              args.item,
              actor,
              args.status as "in_progress" | "blocked",
              args.note as string | undefined,
            );
          } else if (name === "plan_submit") {
            if (!record(args.evidence))
              throw new RoomRuleError("invalid plan evidence");
            keys(args.evidence, ["text", "artifacts"]);
            if (
              !validText(args.evidence.text) ||
              !Array.isArray(args.evidence.artifacts) ||
              args.evidence.artifacts.length > 30 ||
              !args.evidence.artifacts.every((value) =>
                validText(value, 1024),
              ) ||
              args.evidence.text.length +
                args.evidence.artifacts.reduce(
                  (sum, value) => sum + (value as string).length,
                  0,
                ) >
                10000
            )
              throw new RoomRuleError("invalid plan evidence");
            submitPlanItem(
              map,
              args.planId,
              args.rev,
              args.item,
              actor,
              args.evidence as unknown as PlanEvidence,
            );
          } else {
            if (
              !["verified", "returned"].includes(String(args.verdict)) ||
              !validText(args.note)
            )
              throw new RoomRuleError("invalid plan verification");
            verifyPlanItem(
              map,
              args.planId,
              args.rev,
              args.item,
              actor,
              args.verdict as "verified" | "returned",
              args.note,
            );
          }
        }
      }
      reservePlanEffects(map, config.messageRate ?? DEFAULT_CONFIG.messageRate);
    });
    if (legacyFree && proposed) return proposed;
    return { ...(proposed ?? {}), effects: await finish(context) };
  } catch (error) {
    if (
      error instanceof PlanConflictError ||
      error instanceof ProposalConflictError
    )
      throw new Error("Plan revision or item changed; refresh get_map.");
    if (error instanceof RoomRuleError) throw new Error(error.message);
    throw new Error("Plan operation could not be completed.");
  }
}
