import { describe, expect, it } from "vitest";
import {
  planItemDuties,
  planItemSatisfied,
  planSubmission,
} from "./plan-state.js";
import type { PlanDuty } from "./plan-state.js";
import type { PlanItem, PlanItemStatus, RoomPlan } from "./types.js";

const AT = "2026-10-04T01:00:00.000Z";
const OWNER = "s-02";
const VERIFIER = "s-03";
const LEAD = "s-01";

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 1,
    title: "Implement",
    owner: OWNER,
    scope: "src/a.ts",
    after: [],
    criteria: ["Works"],
    verifier: VERIFIER,
    status: "ready",
    evidence: null,
    note: null,
    log: [],
    ...over,
  };
}
function plan(
  items: PlanItem[],
  mode: RoomPlan["mode"] = "verified",
  rev = 0,
): RoomPlan {
  return {
    id: "pl-01",
    roomId: "r-01",
    mode,
    status: "active",
    rev,
    goal: "Goal",
    items,
    backlog: [],
    acceptedAt: AT,
    completedAt: null,
    cancelledAt: null,
    completionSummary: null,
  };
}
const entry = (status: PlanItemStatus) => ({
  at: AT,
  by: OWNER,
  status,
  note: null,
});

describe("planItemSatisfied", () => {
  it("checklist is satisfied by done only", () => {
    const base = item({ verifier: null, criteria: [] });
    const p = plan([base], "checklist");
    expect(planItemSatisfied(p, { ...base, status: "done" })).toBe(true);
    expect(planItemSatisfied(p, { ...base, status: "in_progress" })).toBe(
      false,
    );
  });
  it("verified is satisfied by verified, not by a bare done", () => {
    const p = plan([item()]);
    expect(planItemSatisfied(p, item({ status: "verified" }))).toBe(true);
    expect(planItemSatisfied(p, item({ status: "done" }))).toBe(false);
  });
  it("a done item carried over from an earlier checklist revision is satisfied", () => {
    const p = plan([item()], "verified", 2);
    expect(
      planItemSatisfied(
        p,
        item({ status: "done", acceptedChecklistRevision: 1 }),
      ),
    ).toBe(true);
    expect(
      planItemSatisfied(
        p,
        item({ status: "done", acceptedChecklistRevision: 2 }),
      ),
    ).toBe(false);
  });
});

describe("planSubmission", () => {
  it("is null while the item was never submitted", () => {
    expect(planSubmission(item())).toBeNull();
    expect(
      planSubmission(item({ log: [entry("in_progress"), entry("blocked")] })),
    ).toBeNull();
  });
  it("is the index of the last done entry plus one", () => {
    expect(planSubmission(item({ log: [entry("done")] }))).toBe(1);
    expect(
      planSubmission(
        item({
          log: [
            entry("in_progress"),
            entry("done"),
            entry("returned"),
            entry("in_progress"),
            entry("done"),
          ],
        }),
      ),
    ).toBe(5);
  });
  it("ignores entries after the last done", () => {
    expect(
      planSubmission(
        item({ log: [entry("done"), entry("returned"), entry("in_progress")] }),
      ),
    ).toBe(1);
  });
});

describe("planItemDuties", () => {
  const waitSubmission = {
    role: "verifier",
    sessionId: VERIFIER,
    action: "wait",
    waitingFor: { kind: "submission", by: OWNER },
  } satisfies PlanDuty;
  const duty = (
    role: PlanDuty["role"],
    sessionId: string,
    action: PlanDuty["action"],
    waitingFor: PlanDuty["waitingFor"] = null,
  ): PlanDuty => ({ role, sessionId, action, waitingFor });

  it("verified: ready owner starts, verifier waits for the submission", () => {
    expect(planItemDuties(plan([item()]), item(), LEAD)).toEqual([
      duty("owner", OWNER, "start"),
      waitSubmission,
    ]);
  });
  it("verified: in_progress owner continues", () => {
    const row = item({ status: "in_progress" });
    expect(planItemDuties(plan([row]), row, LEAD)).toEqual([
      duty("owner", OWNER, "continue"),
      waitSubmission,
    ]);
  });
  it("verified: returned owner reworks", () => {
    const row = item({ status: "returned", note: "Fix it" });
    expect(planItemDuties(plan([row]), row, LEAD)).toEqual([
      duty("owner", OWNER, "rework"),
      waitSubmission,
    ]);
  });
  it("verified: blocked owner waits, the verifier waits and the live lead resolves", () => {
    const row = item({ status: "blocked", note: "No access" });
    expect(planItemDuties(plan([row]), row, LEAD)).toEqual([
      duty("owner", OWNER, "wait", { kind: "blocked", note: "No access" }),
      waitSubmission,
      duty("lead", LEAD, "resolve-block"),
    ]);
  });
  it("blocked without a live lead has no lead duty", () => {
    const row = item({ status: "blocked", note: "No access" });
    expect(planItemDuties(plan([row]), row, null)).toEqual([
      duty("owner", OWNER, "wait", { kind: "blocked", note: "No access" }),
      waitSubmission,
    ]);
  });
  it("a lead that owns the blocked item has both duties", () => {
    const row = item({ owner: LEAD, status: "blocked", note: "Stuck" });
    expect(planItemDuties(plan([row]), row, LEAD)).toEqual([
      duty("owner", LEAD, "wait", { kind: "blocked", note: "Stuck" }),
      {
        role: "verifier",
        sessionId: VERIFIER,
        action: "wait",
        waitingFor: { kind: "submission", by: LEAD },
      },
      duty("lead", LEAD, "resolve-block"),
    ]);
  });
  it("waiting owner lists only the unsatisfied dependencies", () => {
    const first = item({ id: 1, status: "verified" });
    const second = item({ id: 2, status: "in_progress" });
    const third = item({ id: 3, status: "waiting", after: [1, 2] });
    const p = plan([first, second, third]);
    expect(planItemDuties(p, third, LEAD)).toEqual([
      duty("owner", OWNER, "wait", { kind: "dependencies", items: [2] }),
      waitSubmission,
    ]);
  });
  it("done awaiting verification: owner waits for the verifier, verifier verifies", () => {
    const row = item({
      status: "done",
      evidence: { text: "ok", artifacts: [] },
    });
    expect(planItemDuties(plan([row]), row, LEAD)).toEqual([
      duty("owner", OWNER, "wait", { kind: "verification", by: VERIFIER }),
      duty("verifier", VERIFIER, "verify"),
    ]);
  });
  it("a satisfied item has no duties, whoever the live lead is", () => {
    const verified = item({ status: "verified" });
    expect(planItemDuties(plan([verified]), verified, LEAD)).toEqual([]);
    const carried = item({ status: "done", acceptedChecklistRevision: 0 });
    expect(planItemDuties(plan([carried], "verified", 1), carried, LEAD)).toEqual(
      [],
    );
  });
  it("checklist: only the owner has duties and a done item is finished", () => {
    const ready = item({ verifier: null, criteria: [] });
    expect(planItemDuties(plan([ready], "checklist"), ready, LEAD)).toEqual([
      duty("owner", OWNER, "start"),
    ]);
    const done = item({ verifier: null, criteria: [], status: "done" });
    expect(planItemDuties(plan([done], "checklist"), done, LEAD)).toEqual([]);
  });
  it("checklist ignores a stray verifier field", () => {
    const row = item({ status: "in_progress" });
    expect(planItemDuties(plan([row], "checklist"), row, null)).toEqual([
      duty("owner", OWNER, "continue"),
    ]);
  });
  it("checklist: blocked owner waits and the live lead resolves", () => {
    const row = item({
      verifier: null,
      criteria: [],
      status: "blocked",
      note: "Waiting for a key",
    });
    expect(planItemDuties(plan([row], "checklist"), row, LEAD)).toEqual([
      duty("owner", OWNER, "wait", {
        kind: "blocked",
        note: "Waiting for a key",
      }),
      duty("lead", LEAD, "resolve-block"),
    ]);
  });
  it("no verifier duty when the verifier is missing or the owner themself", () => {
    const none = item({ verifier: null });
    expect(planItemDuties(plan([none]), none, null)).toEqual([
      duty("owner", OWNER, "start"),
    ]);
    const same = item({ verifier: OWNER });
    expect(planItemDuties(plan([same]), same, null)).toEqual([
      duty("owner", OWNER, "start"),
    ]);
  });
});
