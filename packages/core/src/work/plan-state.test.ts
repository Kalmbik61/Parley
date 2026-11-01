import { describe, expect, it } from "vitest";
import {
  amendmentChanges,
  planItemDuties,
  planItemSatisfied,
  planRemaining,
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

  it("autonomous: пункты ведёт движок, обязанностей у сессий нет", () => {
    const auto = plan([item()], "autonomous");
    expect(planItemDuties(auto, auto.items[0]!, LEAD)).toEqual([]);
    const blocked = item({ status: "blocked", note: "No access" });
    expect(planItemDuties(plan([blocked], "autonomous"), blocked, LEAD)).toEqual([]);
  });
});

/** Черновик поправки в том виде, в каком его строит `proposedRoomPlan`: все пункты `waiting`, чистые. */
function proposal(
  items: PlanItem[],
  mode: RoomPlan["mode"] = "verified",
  rev = 1,
): RoomPlan {
  return {
    ...plan(
      items.map((row) => ({
        ...row,
        status: "waiting" as const,
        evidence: null,
        note: null,
        log: [],
      })),
      mode,
      rev,
    ),
    status: "proposed",
    acceptedAt: null,
  };
}
const row = (id: number, over: Partial<PlanItem> = {}): PlanItem =>
  item({ id, title: `Item ${id}`, ...over });
const view = (result: ReturnType<typeof planRemaining>) =>
  result.items.map((entry) => [entry.item.id, entry.status, entry.mark]);

describe("amendmentChanges", () => {
  it("nothing changes when the semantic fields stay the same", () => {
    const rows = [row(1), row(2, { after: [1] })];
    const result = amendmentChanges(plan(rows, "verified", 0), proposal(rows));
    expect([...result.changed]).toEqual([]);
    expect([...result.promotionExempt]).toEqual([]);
  });
  it("a changed item, a new item and everything that depends on them are changed", () => {
    const active = plan(
      [
        row(1),
        row(2, { after: [1] }),
        row(3, { after: [2] }),
        row(4),
        row(5, { after: [4] }),
      ],
      "verified",
      0,
    );
    const proposed = proposal([
      row(1, { scope: "src/other.ts" }),
      row(2, { after: [1] }),
      row(3, { after: [2] }),
      row(4),
      row(5, { after: [4] }),
      row(6, { after: [4] }),
    ]);
    expect([...amendmentChanges(active, proposed).changed].sort()).toEqual([
      1, 2, 3, 6,
    ]);
  });
  it("criteria and verifier are semantic: changing either resets the item", () => {
    const active = plan([row(1), row(2)], "verified", 0);
    const proposed = proposal([
      row(1, { criteria: ["Other"] }),
      row(2, { verifier: LEAD }),
    ]);
    expect([...amendmentChanges(active, proposed).changed].sort()).toEqual([
      1, 2,
    ]);
  });
  it("promotion exempts a Checklist done item with the same core even when criteria and verifier differ", () => {
    const active = plan(
      [
        row(1, { status: "done", criteria: [], verifier: null }),
        row(2, { after: [1], criteria: [], verifier: null }),
      ],
      "checklist",
      0,
    );
    const proposed = proposal([row(1), row(2, { after: [1] })]);
    const result = amendmentChanges(active, proposed);
    expect([...result.promotionExempt]).toEqual([1]);
    expect([...result.changed]).toEqual([2]);
  });
  it("an exempt item still resets when something it depends on changed", () => {
    const active = plan(
      [
        row(1, { criteria: [], verifier: null }),
        row(2, {
          after: [1],
          status: "done",
          criteria: [],
          verifier: null,
        }),
      ],
      "checklist",
      0,
    );
    const proposed = proposal([
      row(1, { scope: "src/other.ts" }),
      row(2, { after: [1] }),
    ]);
    const result = amendmentChanges(active, proposed);
    expect([...result.promotionExempt]).toEqual([2]);
    expect([...result.changed].sort()).toEqual([1, 2]);
  });
});

describe("planRemaining", () => {
  it("lists every unsatisfied status of a Verified plan, shows done-on-verification and hides the satisfied ones", () => {
    const active = plan(
      [
        row(1, { status: "verified" }),
        row(2, { status: "done" }),
        row(3, { status: "in_progress" }),
        row(4, { status: "blocked", note: "Need a key" }),
        row(5, { status: "returned" }),
        row(6, { status: "ready" }),
        row(7, { status: "waiting", after: [3] }),
        row(8, { status: "verified" }),
      ],
      "verified",
      1,
    );
    const proposed = proposal(
      active.items.map((old) => ({ ...old })),
      "verified",
      2,
    );
    const result = planRemaining(active, proposed);
    expect(result.base).toEqual({ id: "pl-01", rev: 1 });
    expect(view(result)).toEqual([
      [2, "done", null],
      [3, "in_progress", null],
      [4, "blocked", null],
      [5, "returned", null],
      [6, "ready", null],
      [7, "waiting", null],
    ]);
    expect(result.doneHidden).toBe(2);
    expect(result.removed).toEqual([]);
  });
  it("an unchanged in_progress item stays in_progress instead of the draft's waiting", () => {
    const active = plan([row(1, { status: "in_progress" })], "verified", 0);
    const proposed = proposal(active.items);
    expect(proposed.items[0]!.status).toBe("waiting");
    const result = planRemaining(active, proposed);
    expect(view(result)).toEqual([[1, "in_progress", null]]);
    expect(result.items[0]!.item.status).toBe("in_progress");
  });
  it("marks new and changed items and redoes satisfied ones, including transitively", () => {
    const active = plan(
      [
        row(1, { status: "in_progress" }),
        row(2, { status: "verified", after: [1] }),
        row(3, { status: "verified", after: [2] }),
        row(4, { status: "verified" }),
        row(6, { status: "in_progress", after: [4] }),
        row(7, { status: "waiting", after: [1] }),
        row(8, { status: "verified", after: [4] }),
      ],
      "verified",
      3,
    );
    const proposed = proposal(
      [
        row(1, { title: "Item 1 renamed" }),
        row(2, { after: [1] }),
        row(3, { after: [2] }),
        row(4),
        row(5, { after: [4] }),
        row(6, { after: [4] }),
        row(7, { after: [1] }),
        row(8, { after: [4], scope: "src/other.ts" }),
      ],
      "verified",
      4,
    );
    const result = planRemaining(active, proposed);
    expect(view(result)).toEqual([
      [1, "ready", "changed"],
      [2, "waiting", "redo"],
      [3, "waiting", "redo"],
      [5, "ready", "new"],
      [6, "in_progress", null],
      [7, "waiting", "changed"],
      [8, "ready", "redo"],
    ]);
    expect(result.doneHidden).toBe(1);
    expect(result.removed).toEqual([]);
  });
  it("a changed item whose dependencies are satisfied after acceptance is ready, otherwise waiting", () => {
    const active = plan(
      [row(1, { status: "verified" }), row(2, { status: "in_progress" })],
      "verified",
      0,
    );
    const proposed = proposal([
      row(1),
      row(2, { title: "Other" }),
      row(3, { after: [1] }),
      row(4, { after: [2] }),
    ]);
    expect(view(planRemaining(active, proposed))).toEqual([
      [2, "ready", "changed"],
      [3, "ready", "new"],
      [4, "waiting", "new"],
    ]);
  });
  it("checklist to verified promotion keeps carried-over done items hidden", () => {
    const checklist = { criteria: [], verifier: null };
    const active = plan(
      [
        row(1, { status: "done", ...checklist }),
        row(2, { status: "ready", after: [1], ...checklist }),
        row(3, { status: "in_progress", ...checklist }),
      ],
      "checklist",
      0,
    );
    const proposed = proposal(
      [row(1), row(2, { after: [1] }), row(3)],
      "verified",
      1,
    );
    const result = planRemaining(active, proposed);
    expect(view(result)).toEqual([
      [2, "ready", "changed"],
      [3, "ready", "changed"],
    ]);
    expect(result.doneHidden).toBe(1);
  });
  it("lists a removed unfinished item, including done-on-verification, but not a removed satisfied one", () => {
    const active = plan(
      [
        row(1, { status: "verified" }),
        row(2, { status: "verified" }),
        row(3, { status: "in_progress", title: "Wire the host" }),
        row(4, { status: "done", title: "Docs" }),
      ],
      "verified",
      1,
    );
    const result = planRemaining(active, proposal([row(1)], "verified", 2));
    expect(result.items).toEqual([]);
    expect(result.doneHidden).toBe(1);
    expect(result.removed).toEqual([
      { id: 3, title: "Wire the host" },
      { id: 4, title: "Docs" },
    ]);
  });
  it("the first plan of a room is not an amendment: base null, every item listed", () => {
    const proposed = proposal(
      [row(1), row(2, { after: [1] })],
      "verified",
      0,
    );
    for (const active of [undefined, { ...plan([row(1)]), id: "pl-99" }]) {
      const result = planRemaining(active, proposed);
      expect(result.base).toBeNull();
      expect(view(result)).toEqual([
        [1, "ready", null],
        [2, "waiting", null],
      ]);
      expect(result.doneHidden).toBe(0);
      expect(result.removed).toEqual([]);
    }
  });
  it("does not touch its arguments", () => {
    const active = plan(
      [row(1, { status: "verified" }), row(2, { status: "in_progress" })],
      "verified",
      1,
    );
    const proposed = proposal(
      [row(1, { scope: "x" }), row(2), row(3)],
      "verified",
      2,
    );
    const before = JSON.stringify([active, proposed]);
    planRemaining(active, proposed);
    expect(JSON.stringify([active, proposed])).toBe(before);
  });
});
