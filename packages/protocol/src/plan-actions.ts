import { z } from "zod";

const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          value,
        ),
    );
const text = boundedText(10_000).refine((value) => value.trim() !== "");
const id = (prefix: string) =>
  z
    .string()
    .max(128)
    .regex(new RegExp(`^${prefix}-\\d+$`));
const project = boundedText(32768).refine((value) => value !== "");
const rev = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const item = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const location = { projectPath: project, workId: id("w") };
const identity = { ...location, planId: id("pl"), rev };
export const roomMode = z.enum(["free", "checklist", "verified"]);
export const planEvidence = z
  .strictObject({
    text,
    artifacts: z
      .array(boundedText(1024).refine((value) => value !== ""))
      .max(30),
  })
  .refine(
    (value) =>
      value.text.length +
        value.artifacts.reduce((sum, value) => sum + value.length, 0) <=
      10_000,
  );
export const planDraftItem = z.strictObject({
  id: item,
  title: text,
  owner: id("s"),
  scope: text,
  after: z.array(item).max(30).optional(),
  criteria: z.array(text).max(10).optional(),
  verifier: id("s").nullable().optional(),
});
export const planDraft = z
  .strictObject({
    id: id("pl").optional(),
    rev: rev.optional(),
    mode: z.enum(["checklist", "verified"]),
    goal: text,
    items: z.array(planDraftItem).min(1).max(30),
    backlog: z
      .array(
        z
          .string()
          .regex(/^b-\d{3,}$/)
          .max(128),
      )
      .max(30)
      .optional(),
  })
  .refine((value) => (value.id === undefined) === (value.rev === undefined))
  .refine(
    (value) =>
      value.goal.length +
        value.items.reduce(
          (sum, row) =>
            sum +
            row.title.length +
            row.scope.length +
            (row.criteria ?? []).reduce((sum, value) => sum + value.length, 0),
          0,
        ) <=
      10_000,
  );
/** Actor identity is supplied by the host/MCP launch context, never by request parameters. */
export const planMethodSchemas = {
  "plans.retryEffects": z.strictObject(location),
  "rooms.setMode": z.strictObject({
    ...location,
    roomId: id("r"),
    mode: roomMode,
    reason: text.refine((value) => !/[\r\n]/.test(value)),
    confirmCancel: z.boolean().optional(),
  }),
  "plans.update": z
    .strictObject({
      ...identity,
      item,
      status: z.enum(["in_progress", "blocked"]),
      note: text.optional(),
    })
    .refine((value) => value.status !== "blocked" || value.note !== undefined),
  "plans.submit": z.strictObject({ ...identity, item, evidence: planEvidence }),
  "plans.verify": z.strictObject({
    ...identity,
    item,
    verdict: z.enum(["verified", "returned"]),
    note: text,
  }),
  "plans.cancel": z.strictObject(identity),
};
export const planEffectConflict = z.union([
  z.strictObject({
    planId: id("pl"),
    rev,
    backlogId: z
      .string()
      .regex(/^b-\d{3,}$/)
      .max(128),
    code: z.enum(["backlog-conflict", "backlog-unavailable"]),
  }),
  z.strictObject({
    planId: id("pl"),
    rev,
    code: z.enum(["snapshot-conflict", "snapshot-unavailable"]),
  }),
]);
const count = z.number().int().nonnegative().max(1_000_000);
export const planEffectsSummary = z.strictObject({
  queued: count,
  pendingSnapshots: count,
  pendingBacklog: count,
  conflictCount: count,
  conflicts: z.array(planEffectConflict).max(100),
});
export const planActionResult = z.strictObject({
  messageId: id("m").nullable(),
  effects: planEffectsSummary,
});
export type PlanMethodName = keyof typeof planMethodSchemas;
export type PlanMethodParams<M extends PlanMethodName> = z.infer<
  (typeof planMethodSchemas)[M]
>;
export type PlanActionResult = z.infer<typeof planActionResult>;
export type PlanMethodResults = { [M in PlanMethodName]: PlanActionResult };
