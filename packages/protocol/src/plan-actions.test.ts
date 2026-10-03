import { describe, expect, it } from "vitest";
import {
  planActionResult,
  planDraft,
  planEvidence,
  planMethodSchemas,
} from "./plan-actions.js";
const identity = {
  projectPath: "/project",
  workId: "w-01",
  planId: "pl-01",
  rev: 0,
};
describe("revision-bound human plan requests", () => {
  it("accepts each bounded action without actor claims", () => {
    expect(
      planMethodSchemas["rooms.setMode"].safeParse({
        projectPath: "/project",
        workId: "w-01",
        roomId: "r-01",
        mode: "verified",
        reason: "Human choice",
      }).success,
    ).toBe(true);
    expect(
      planMethodSchemas["plans.update"].safeParse({
        ...identity,
        item: 1,
        status: "in_progress",
      }).success,
    ).toBe(true);
    expect(
      planMethodSchemas["plans.submit"].safeParse({
        ...identity,
        item: 1,
        evidence: { text: "Test passed", artifacts: ["src/test.ts"] },
      }).success,
    ).toBe(true);
    expect(
      planMethodSchemas["plans.verify"].safeParse({
        ...identity,
        item: 1,
        verdict: "returned",
        note: "Missing case",
      }).success,
    ).toBe(true);
    expect(
      planMethodSchemas["plans.retryEffects"].safeParse({
        projectPath: "/project",
        workId: "w-01",
      }).success,
    ).toBe(true);
    expect(
      planMethodSchemas["plans.retryEffects"].safeParse({
        ...identity,
        actor: "human",
      }).success,
    ).toBe(false);
    expect(planMethodSchemas["plans.cancel"].safeParse(identity).success).toBe(
      true,
    );
  });
  it("refuses actor spoofing, missing revision, unknown keys, invalid status and unbounded identifiers", () => {
    for (const value of [
      { ...identity, actor: "human" },
      { ...identity, rev: undefined },
      { ...identity, planId: "../secret" },
      { ...identity, rev: Infinity },
    ])
      expect(planMethodSchemas["plans.cancel"].safeParse(value).success).toBe(
        false,
      );
    expect(
      planMethodSchemas["plans.update"].safeParse({
        ...identity,
        item: 1,
        status: "done",
      }).success,
    ).toBe(false);
    expect(
      planMethodSchemas["plans.update"].safeParse({
        ...identity,
        item: 1,
        status: "blocked",
      }).success,
    ).toBe(false);
  });
  it("enforces aggregate evidence bounds and safe Unicode while paths remain artifact data", () => {
    expect(
      planEvidence.safeParse({ text: "x".repeat(10_000), artifacts: ["x"] })
        .success,
    ).toBe(false);
    for (const text of ["\0", "\ud800", ""])
      expect(planEvidence.safeParse({ text, artifacts: [] }).success).toBe(
        false,
      );
    expect(
      planEvidence.safeParse({
        text: "Measured 😀",
        artifacts: ["/outside/path", "../file", "C:\\file"],
      }).success,
    ).toBe(true);
  });
  it("requires exact amendment identity pair and rejects persisted-state forgery", () => {
    const draft = {
      mode: "checklist",
      goal: "Done",
      items: [{ id: 1, owner: "s-01", title: "Test", scope: "src" }],
    };
    expect(planDraft.safeParse(draft).success).toBe(true);
    expect(planDraft.safeParse({ ...draft, id: "pl-01" }).success).toBe(false);
    expect(planDraft.safeParse({ ...draft, id: "pl-01", rev: 0 }).success).toBe(
      true,
    );
    expect(
      planDraft.safeParse({
        ...draft,
        items: [
          {
            ...draft.items[0],
            status: "verified",
            acceptedChecklistRevision: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("allows only bounded safe effects results, never raw errors/config/argv", () => {
    const result = {
      messageId: null,
      effects: {
        queued: 1,
        pendingSnapshots: 0,
        pendingBacklog: 0,
        conflictCount: 0,
        conflicts: [],
      },
    };
    expect(planActionResult.safeParse(result).success).toBe(true);
    for (const key of ["error", "config", "argv", "stdout"])
      expect(
        planActionResult.safeParse({ ...result, [key]: "private" }).success,
      ).toBe(false);
  });
});

it("registered proposal resolution preserves legacy omission and rejects a partial exact-plan pair", async () => {
  const { METHODS } = await import("./methods.js");
  const legacy = {
    projectPath: "/project",
    workId: "w-01",
    roomId: "r-01",
    proposalId: "p-01",
    action: "accept",
    rev: 0,
  };
  expect(METHODS["rooms.resolveProposal"].safeParse(legacy).success).toBe(true);
  expect(
    METHODS["rooms.resolveProposal"].safeParse({ ...legacy, planId: "pl-01" })
      .success,
  ).toBe(false);
  expect(
    METHODS["rooms.resolveProposal"].safeParse({ ...legacy, planRev: 0 })
      .success,
  ).toBe(false);
  expect(
    METHODS["rooms.resolveProposal"].safeParse({
      ...legacy,
      planId: "pl-01",
      planRev: 0,
    }).success,
  ).toBe(true);
  expect(
    METHODS["plans.retryEffects"].safeParse({
      projectPath: "/project",
      workId: "w-01",
    }).success,
  ).toBe(true);
});
