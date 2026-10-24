import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  clampPageBytes,
  pageBySeq,
  parseCursor,
  seqOf,
  textPage,
} from "../work/context-pages.js";
import { activeRoomPlan } from "../work/plans.js";
import { isMember, requireOpenRoom, RoomRuleError } from "../work/rooms.js";
import { readMap } from "../work/store.js";
import type { AttemptChannelRequest, HandoffManifest } from "../work/types.js";
import type { McpContext } from "./context.js";

const text = { type: "string", minLength: 1, maxLength: 10000 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const attemptId = { type: "string", pattern: "^at-[0-9]+$", maxLength: 128 };
const strings = { type: "array", maxItems: 100, items: text };
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    version: { const: 1 },
    criteriaVersion: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    dependsOn: { type: "array", maxItems: 100, items: attemptId },
    coverage: {
      type: "string",
      enum: ["covered", "partial", "failed", "unstarted"],
    },
    scope: text,
    facts: strings,
    hypotheses: strings,
    notFound: strings,
    gaps: strings,
    text: { type: "string", maxLength: 4096 },
    hash,
    submittedAt: text,
    artifacts: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          path: text,
          sha256: hash,
          storedAs: { type: "string", maxLength: 10000 },
        },
        required: ["path", "sha256", "storedAs"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "version",
    "criteriaVersion",
    "dependsOn",
    "coverage",
    "scope",
    "facts",
    "hypotheses",
    "notFound",
    "gaps",
    "text",
    "artifacts",
    "hash",
    "submittedAt",
  ],
  additionalProperties: false,
};
export const ATTEMPT_TOOLS: Tool[] = [
  {
    name: "attempt_submit",
    description:
      "Autonomous worker: submit your handoff manifest without sha through the host. Keep submissionKey unchanged when retrying; only the engine captures the commit. Read attempt_status before retrying a lost response.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { attemptId, submissionKey: hash, manifest: MANIFEST_SCHEMA },
      required: ["attemptId", "submissionKey", "manifest"],
      additionalProperties: false,
    },
  },
  {
    name: "attempt_verify",
    description:
      "Autonomous verifier: report a criterion verdict for the exact SHA assigned by the engine, through the host. Criterion indices start at zero.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        attemptId,
        sha: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
        criterion: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        verdict: {
          type: "string",
          enum: ["pass", "fail", "error", "not_verified"],
        },
        note: text,
      },
      required: ["attemptId", "sha", "criterion", "verdict", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "attempt_status",
    description:
      "Autonomous room members: read attempt cards, newest page first. With attemptId, read the full attempt as paged JSON text, including its manifest; pass next as cursor. This only reads the map.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        attemptId,
        cursor: { type: "string" },
        maxBytes: { type: "integer", minimum: 2048, maximum: 262144 },
      },
      additionalProperties: false,
    },
  },
];
const names = new Set(ATTEMPT_TOOLS.map((tool) => tool.name));
export const isAttemptTool = (name: string): boolean => names.has(name);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validText = (
  value: unknown,
  max = 10000,
  empty = false,
): value is string =>
  typeof value === "string" &&
  (empty || !!value.trim()) &&
  value.length <= max &&
  !value.includes("\0") &&
  Buffer.from(value).toString() === value;
const safe = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RoomRuleError("unexpected attempt argument");
}
function manifest(value: unknown): Omit<HandoffManifest, "sha"> {
  if (!record(value)) throw new RoomRuleError("invalid handoff manifest");
  keys(value, MANIFEST_SCHEMA.required);
  if (
    value.version !== 1 ||
    !safe(value.criteriaVersion, 1) ||
    !Array.isArray(value.dependsOn) ||
    value.dependsOn.length > 100 ||
    !value.dependsOn.every((id) => validText(id, 128) && /^at-\d+$/.test(id)) ||
    !["covered", "partial", "failed", "unstarted"].includes(
      String(value.coverage),
    ) ||
    !validText(value.scope) ||
    !validText(value.text, 4096, true) ||
    !validText(value.submittedAt) ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !["facts", "hypotheses", "notFound", "gaps"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].length <= 100 &&
        value[key].every((entry) => validText(entry)),
    ) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 100
  )
    throw new RoomRuleError("invalid handoff manifest");
  for (const artifact of value.artifacts) {
    if (!record(artifact)) throw new RoomRuleError("invalid handoff artifact");
    keys(artifact, ["path", "sha256", "storedAs"]);
    if (
      !validText(artifact.path) ||
      !validText(artifact.storedAs, 10000, true) ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw new RoomRuleError("invalid handoff artifact");
  }
  return value as unknown as Omit<HandoffManifest, "sha">;
}

/** The host derives actor and workspace from the same channel token as create_session. */
export async function sendAttemptRequest(
  context: McpContext,
  request: AttemptChannelRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!context.agent || !context.sessionId)
    throw new RoomRuleError(
      "Attempt operations require an identified session with a host connection. Restart this session from Parley.",
    );
  let response: Response;
  try {
    response = await fetch(new URL("/agent/attempts", context.agent.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.agent.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
  } catch {
    throw new RoomRuleError(
      "Parley's host did not return an attempt result. Read attempt_status before retrying with the same submissionKey or requestKey.",
    );
  }
  if (response.status === 401)
    throw new RoomRuleError(
      "Parley does not recognise this session's token. Restart this session from Parley.",
    );
  if (response.status === 404)
    throw new RoomRuleError(
      "Parley's host does not support /agent/attempts. Update Parley and restart this session.",
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RoomRuleError(
      "Parley's host sent an unreadable attempt answer. Read attempt_status before retrying.",
    );
  }
  if (
    record(body) &&
    body.ok === false &&
    record(body.error) &&
    typeof body.error.code === "string" &&
    typeof body.error.message === "string"
  )
    throw new RoomRuleError(`${body.error.code}: ${body.error.message}`);
  if (
    response.status === 200 &&
    record(body) &&
    body.ok === true &&
    record(body.result)
  )
    return body.result;
  throw new RoomRuleError(
    `Parley's host did not return a valid attempt result (HTTP ${response.status}). Read attempt_status before retrying.`,
  );
}

export async function attemptTool(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !isAttemptTool(name) ||
    Buffer.byteLength(JSON.stringify(args)) > 64 * 1024
  )
    throw new RoomRuleError("invalid attempt arguments");
  const map = await readMap(context.projectPath, context.workId);
  const actor = context.sessionId;
  if (
    map.work.id !== context.workId ||
    map.work.status !== "active" ||
    !actor ||
    !map.sessions.some(
      (session) => session.id === actor && session.lifecycle !== "closed",
    )
  )
    throw new RoomRuleError("a live launched caller is required");
  if (
    args.attemptId !== undefined &&
    (!validText(args.attemptId, 128) || !/^at-\d+$/.test(args.attemptId))
  )
    throw new RoomRuleError("invalid attempt identity");
  // Attempt identities are plan-local. Membership chooses the plan before looking up an id.
  const plans =
    map.plans?.filter(
      (plan) =>
        plan.mode === "autonomous" &&
        map.rooms.some(
          (room) =>
            room.id === plan.roomId &&
            isMember(room, actor) &&
            room.mode === "autonomous",
        ) &&
        (activeRoomPlan(map, plan.roomId) ??
          map.plans?.findLast((row) => row.roomId === plan.roomId))?.id === plan.id &&
        (args.attemptId === undefined ||
          plan.autonomous?.attempts.some((attempt) => attempt.id === args.attemptId)),
    ) ?? [];
  if (plans.length !== 1)
    throw new RoomRuleError(
      "attempt tools require membership in one autonomous plan room; select an available attemptId",
    );
  const plan = plans[0]!;
  requireOpenRoom(map, plan.roomId);
  const attempt = plan.autonomous?.attempts.find(
    (attempt) => attempt.id === args.attemptId,
  );
  if (name === "attempt_status") {
    keys(args, ["attemptId", "cursor", "maxBytes"]);
    const maxBytes = clampPageBytes(args.maxBytes);
    if (attempt)
      return {
        planId: plan.id,
        attemptId: attempt.id,
        ...textPage(JSON.stringify(attempt, null, 2), args.cursor, maxBytes),
      };
    const { items, page } = pageBySeq(plan.autonomous?.attempts ?? [], {
      seq: (attempt) => seqOf(attempt.id, "at-"),
      cursor: parseCursor(args.cursor),
      maxBytes,
      view: (attempt) => ({
        id: attempt.id,
        item: attempt.item,
        n: attempt.n,
        planRev: attempt.planRev,
        criteriaVersion: attempt.criteriaVersion,
        status: attempt.status,
        worker: attempt.worker,
        verifier: attempt.verifier,
        sha: attempt.sha,
        receipt: attempt.receipt && {
          id: attempt.receipt.id,
          valid: attempt.receipt.valid,
        },
        checks: attempt.checks.length,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
      }),
    });
    return { planId: plan.id, attempts: items, page };
  }
  if (!attempt)
    throw new RoomRuleError("attempt is not available to this session");
  if (name === "attempt_submit") {
    keys(args, ["attemptId", "submissionKey", "manifest"]);
    if (
      typeof args.submissionKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(args.submissionKey)
    )
      throw new RoomRuleError("invalid submissionKey");
    return sendAttemptRequest(
      context,
      {
        action: "submit",
        attemptId: attempt.id,
        submissionKey: args.submissionKey,
        manifest: manifest(args.manifest),
      },
      signal,
    );
  }
  keys(args, ["attemptId", "sha", "criterion", "verdict", "note"]);
  // The host checks the assignment too, including fresh integration verifiers recorded in ops.
  if (
    !validText(args.sha, 64) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(args.sha) ||
    !safe(args.criterion, 0) ||
    args.criterion >=
      (plan.items.find((item) => item.id === attempt.item)?.criteria.length ??
        0) ||
    !["pass", "fail", "error", "not_verified"].includes(String(args.verdict)) ||
    !validText(args.note)
  )
    throw new RoomRuleError("invalid verification criterion or SHA");
  return sendAttemptRequest(
    context,
    {
      action: "verify",
      attemptId: attempt.id,
      sha: args.sha,
      criterion: args.criterion,
      verdict: args.verdict as "pass" | "fail" | "error" | "not_verified",
      note: args.note,
    },
    signal,
  );
}
