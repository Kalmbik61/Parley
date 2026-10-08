import { describe, expect, it } from "vitest";
import {
  addSession,
  parseMap,
  removeSession,
  transitionSession,
} from "./map.js";
import { addRoom } from "./rooms.js";
import {
  proposeCompletion,
  resolveProposal,
  setProposal,
} from "./proposals.js";
import {
  cancelRoomPlan,
  reconcileRoomPlans,
  setRoomMode,
  submitPlanItem,
  updatePlanItem,
  verifyPlanItem,
} from "./plans.js";
import { HUMAN } from "./types.js";
import type { PlanDraft, WorkMap } from "./types.js";
const AT = "2026-10-04T01:00:00.000Z";
function fixture(mode: "checklist" | "verified" = "checklist"): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: {
      id: "w-0001",
      title: "Fixture",
      goal: "",
      status: "active",
      createdAt: AT,
      updatedAt: AT,
    },
    rooms: [],
    sessions: [],
    messages: [],
  };
  for (const label of ["Lead", "Owner", "Reviewer"])
    addSession(map, { provider: "codex", label, task: "Fixture" }, AT);
  addRoom(
    map,
    {
      title: "Plan",
      creator: HUMAN,
      members: ["s-01", "s-02", "s-03"],
      lead: "s-01",
      mode,
    },
    AT,
  );
  return map;
}
const input = (mode: PlanDraft["mode"] = "checklist"): PlanDraft => ({
  mode,
  goal: "Accepted complete behavior",
  items: [
    {
      id: 1,
      title: "Implement",
      owner: "s-02",
      scope: "src/a.ts",
      ...(mode === "verified" ? { criteria: ["Works"], verifier: "s-03" } : {}),
    },
    {
      id: 2,
      title: "Integrate",
      owner: "s-01",
      scope: "src/b.ts",
      after: [1],
      ...(mode === "verified"
        ? { criteria: ["Integrated"], verifier: "s-03" }
        : {}),
    },
  ],
  backlog: ["b-001"],
});
function accept(
  map: WorkMap,
  draft = input(map.rooms[0]!.mode as PlanDraft["mode"]),
) {
  const p = setProposal(map, "r-01", "s-01", "Decision", AT, { plan: draft });
  const plan = map.rooms[0]!.proposal!.plan!;
  resolveProposal(
    map,
    "r-01",
    p.proposalId,
    "accept",
    { rev: p.rev, planId: plan.id, planRev: plan.rev },
    AT,
  );
  return map.plans![0]!;
}
const evidence = { text: "Test passed", artifacts: ["src/a.ts"] };

describe("room plan state and permissions", () => {
  it("normalizes legacy v2 maps to Free without upgrading schema version", () => {
    const map = fixture();
    delete map.rooms[0]!.mode;
    delete map.plans;
    const parsed = parseMap(JSON.stringify(map), "fixture");
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.rooms[0]!.mode).toBe("free");
    expect(parsed.plans).toEqual([]);
  });
  it("retains legacy positional proposal at and optional revision resolution", () => {
    const map = fixture();
    map.rooms[0]!.mode = "free";
    const p = setProposal(map, "r-01", "s-01", "Legacy", AT);
    expect(map.rooms[0]!.proposal).toEqual({
      id: p.proposalId,
      from: "s-01",
      text: "Legacy",
      rev: 0,
      at: AT,
    });
    resolveProposal(map, "r-01", p.proposalId, "accept");
  });
  it("requires mode-compatible decisions and permits only upward changes by a live lead", () => {
    const map = fixture();
    expect(() => setProposal(map, "r-01", "s-01", "Text", AT)).toThrow();
    expect(() =>
      setRoomMode(map, "r-01", "s-02", "verified", "Need verification"),
    ).toThrow();
    setRoomMode(map, "r-01", "s-01", "verified", "Need verification");
    expect(map.rooms[0]!.mode).toBe("verified");
    expect(() =>
      setRoomMode(map, "r-01", "s-01", "free", "Less ceremony"),
    ).toThrow();
    setRoomMode(map, "r-01", HUMAN, "free", "Small task");
    expect(map.rooms[0]!.mode).toBe("free");
    expect(() =>
      setProposal(map, "r-01", "s-01", "Plan", AT, { plan: input() }),
    ).toThrow();
  });
  it.each([
    "cycle",
    "missing",
    "duplicate",
    "limit",
    "owner",
    "criteria",
    "verifier",
  ])("rejects invalid %s without mutating map or reserving IDs", (kind) => {
    const map = fixture("verified");
    const draft = input("verified");
    if (kind === "cycle") draft.items[0]!.after = [2];
    if (kind === "missing") draft.items[0]!.after = [99];
    if (kind === "duplicate") draft.items[1]!.id = 1;
    if (kind === "limit")
      draft.items = Array.from({ length: 31 }, (_, i) => ({
        ...draft.items[0]!,
        id: i + 1,
      }));
    if (kind === "owner") draft.items[0]!.owner = "s-99";
    if (kind === "criteria") draft.items[0]!.criteria = [];
    if (kind === "verifier") draft.items[0]!.verifier = "s-02";
    const before = JSON.stringify(map);
    expect(() =>
      setProposal(map, "r-01", "s-01", "Decision", AT, { plan: draft }),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
  });
  it("acceptance requires displayed proposal+plan revision and revalidates membership", () => {
    const map = fixture();
    const p = setProposal(map, "r-01", "s-01", "Decision", AT, {
      plan: input(),
    });
    const plan = map.rooms[0]!.proposal!.plan!;
    const before = JSON.stringify(map);
    expect(() =>
      resolveProposal(map, "r-01", p.proposalId, "accept", { rev: p.rev }, AT),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
    transitionSession(map, "s-02", "closed", { at: AT });
    expect(() =>
      resolveProposal(
        map,
        "r-01",
        p.proposalId,
        "accept",
        { rev: p.rev, planId: plan.id, planRev: plan.rev },
        AT,
      ),
    ).toThrow();
    expect(map.plans).toBeUndefined();
  });
  it("Checklist advances dependencies by done and auto-completes with captured exports", () => {
    const map = fixture();
    const plan = accept(map);
    expect(plan.items.map((item) => item.status)).toEqual(["ready", "waiting"]);
    submitPlanItem(map, plan.id, plan.rev, 1, "s-02", evidence, AT);
    expect(map.plans![0]!.items.map((item) => item.status)).toEqual([
      "done",
      "ready",
    ]);
    submitPlanItem(map, plan.id, plan.rev, 2, "s-01", evidence, AT);
    expect(map.plans![0]!.status).toBe("completed");
    expect(map.planExports!.map((item) => item.event)).toEqual([
      "accepted",
      "completed",
    ]);
    const before = JSON.stringify(map);
    expect(() =>
      submitPlanItem(map, plan.id, plan.rev, 2, "s-01", evidence),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
  });
  it("Verified unlocks only after independent verification and requires human completion acceptance", () => {
    const map = fixture("verified");
    const plan = accept(map);
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    expect(map.plans![0]!.items[1]!.status).toBe("waiting");
    expect(() =>
      verifyPlanItem(map, plan.id, 0, 1, "s-02", "verified", "Own review"),
    ).toThrow();
    verifyPlanItem(
      map,
      plan.id,
      0,
      1,
      "s-03",
      "returned",
      "Missing regression",
      AT,
    );
    expect(map.plans![0]!.items[0]!.status).toBe("returned");
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 1, HUMAN, "verified", "Reviewed", AT);
    submitPlanItem(map, plan.id, 0, 2, "s-01", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 2, "s-03", "verified", "Reviewed", AT);
    expect(map.plans![0]!.status).toBe("completing");
    const p = proposeCompletion(
      map,
      "r-01",
      "s-01",
      plan.id,
      0,
      "Final summary",
      AT,
    );
    resolveProposal(
      map,
      "r-01",
      p.proposalId,
      "return",
      { rev: p.rev, planId: plan.id, planRev: 0, note: "Explain validation" },
      AT,
    );
    expect(map.plans![0]!.status).toBe("active");
    const second = proposeCompletion(
      map,
      "r-01",
      "s-01",
      plan.id,
      0,
      "Validated summary",
      AT,
    );
    resolveProposal(
      map,
      "r-01",
      second.proposalId,
      "accept",
      { rev: second.rev, planId: plan.id, planRev: 0 },
      AT,
    );
    expect(map.plans![0]!.status).toBe("completed");
    expect(map.planExports!.at(-1)!.content).toContain("Validated summary");
  });
  it.each(["title", "owner", "scope", "after", "criteria", "verifier"])(
    "amending %s invalidates evidence and dependent checks while old rev is immutable",
    (field) => {
      const map = fixture("verified");
      const plan = accept(map);
      submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
      verifyPlanItem(map, plan.id, 0, 1, "s-03", "verified", "Reviewed", AT);
      submitPlanItem(map, plan.id, 0, 2, "s-01", evidence, AT);
      const snapshot = map.planExports![0]!.content;
      const draft = input("verified");
      draft.id = plan.id;
      draft.rev = 0;
      if (field === "title") draft.items[0]!.title = "Changed";
      if (field === "owner") draft.items[0]!.owner = "s-01";
      if (field === "scope") draft.items[0]!.scope = "src/other.ts";
      if (field === "after") {
        draft.items.push({
          id: 3,
          title: "Before",
          owner: "s-01",
          scope: "src/c.ts",
          verifier: "s-03",
          criteria: ["Works"],
        });
        draft.items[0]!.after = [3];
      }
      if (field === "criteria") draft.items[0]!.criteria = ["New criterion"];
      if (field === "verifier") draft.items[0]!.verifier = "s-01";
      accept(map, draft);
      const next = map.plans![0]!;
      expect(next.rev).toBe(1);
      expect(next.items[0]!.evidence).toBeNull();
      expect(next.items[1]!.evidence).toBeNull();
      expect(next.items[1]!.status).toBe("waiting");
      expect(map.planExports![0]!.content).toBe(snapshot);
      const before = JSON.stringify(map);
      expect(() =>
        submitPlanItem(map, plan.id, 0, 1, "s-02", evidence),
      ).toThrow();
      expect(JSON.stringify(map)).toBe(before);
    },
  );
  it("unchanged assignments preserve evidence across a revision; removing items retains prior snapshot", () => {
    const map = fixture("verified");
    const plan = accept(map);
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 1, "s-03", "verified", "Reviewed", AT);
    const draft = input("verified");
    draft.id = plan.id;
    draft.rev = 0;
    draft.goal = "Clarified goal";
    accept(map, draft);
    expect(map.plans![0]!.items[0]!.status).toBe("verified");
    expect(map.plans![0]!.items[0]!.evidence).toEqual(evidence);
  });
  it("pending/sleeping members are live; closed/deleted/foreign actors cannot mutate plans", () => {
    const map = fixture();
    transitionSession(map, "s-02", "active", { at: AT });
    transitionSession(map, "s-02", "sleeping", { at: AT });
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    expect(() =>
      submitPlanItem(map, plan.id, 0, 1, "s-03", evidence),
    ).toThrow();
    removeSession(map, "s-02");
    const before = JSON.stringify(map);
    expect(() =>
      submitPlanItem(map, plan.id, 0, 1, "s-02", evidence),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
    reconcileRoomPlans(map, AT);
    expect(map.plans![0]!.items[0]!.status).toBe("blocked");
    transitionSession(map, "s-01", "closed", { at: AT });
    transitionSession(map, "s-03", "closed", { at: AT });
    reconcileRoomPlans(map, AT);
    expect(map.plans![0]!.status).toBe("cancelled");
  });
  it("Human Free transition requires cancellation confirmation and captures cancellation once", () => {
    const map = fixture();
    const plan = accept(map);
    const before = JSON.stringify(map);
    expect(() =>
      setRoomMode(map, "r-01", HUMAN, "free", "Small task"),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
    setRoomMode(
      map,
      "r-01",
      HUMAN,
      "free",
      "Small task",
      { confirmCancel: true },
      AT,
    );
    expect(map.plans![0]!.status).toBe("cancelled");
    expect(map.planExports!.at(-1)!.event).toBe("cancelled");
    expect(() => cancelRoomPlan(map, plan.id, 0, HUMAN)).toThrow();
  });
  it("Verified downgrade makes returned items executable and done items satisfy Checklist", () => {
    const map = fixture("verified");
    const plan = accept(map);
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 1, "s-03", "returned", "Fix", AT);
    setRoomMode(map, "r-01", HUMAN, "checklist", "Enough checking", {}, AT);
    expect(map.plans![0]!.mode).toBe("checklist");
    expect(map.plans![0]!.items[0]!.status).toBe("in_progress");
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    submitPlanItem(map, plan.id, 0, 2, HUMAN, evidence, AT);
    expect(map.plans![0]!.status).toBe("completed");
  });
  it("human-accepted promotion preserves Checklist done honestly; later criteria edits clear its basis", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    setRoomMode(
      map,
      "r-01",
      HUMAN,
      "verified",
      "Independent review for remaining work",
      {},
      AT,
    );
    const promoted = input("verified");
    promoted.id = plan.id;
    promoted.rev = 0;
    accept(map, promoted);
    expect(map.plans![0]!.items[0]).toMatchObject({
      status: "done",
      acceptedChecklistRevision: 0,
      evidence,
    });
    expect(map.plans![0]!.items[1]!.status).toBe("ready");
    expect(map.planExports!.at(-1)!.content).toContain(
      "no verification claimed",
    );
    const amended = input("verified");
    amended.id = plan.id;
    amended.rev = 1;
    amended.items[0]!.criteria = ["Different requirement"];
    accept(map, amended);
    expect(map.plans![0]!.items[0]!.evidence).toBeNull();
    expect(map.plans![0]!.items[0]!.acceptedChecklistRevision).toBeUndefined();
    expect(map.plans![0]!.items[1]!.status).toBe("waiting");
  });
  it("caller-provided completion basis is discarded and new Verified work requires actual verification", () => {
    const map = fixture("verified");
    const draft = input("verified");
    Object.assign(draft.items[0]!, {
      acceptedChecklistRevision: 0,
      status: "done",
      evidence,
    });
    const plan = accept(map, draft);
    expect(plan.items[0]!.status).toBe("ready");
    expect(plan.items[0]!.acceptedChecklistRevision).toBeUndefined();
  });
});

it("bounds the combined decision/plan text before reserving either identity", () => {
  const map = fixture();
  const draft = input();
  draft.goal = "g".repeat(6_000);
  const before = JSON.stringify(map);
  expect(() =>
    setProposal(map, "r-01", "s-01", "d".repeat(5_000), AT, { plan: draft }),
  ).toThrow("limit");
  expect(JSON.stringify(map)).toBe(before);
});
it("a declared lead outside the room cannot gain plan permissions", () => {
  const map = fixture();
  const outside = addSession(
    map,
    { provider: "claude", label: "Outside", task: "" },
    AT,
  );
  map.rooms[0]!.lead = outside.id;
  const before = JSON.stringify(map);
  expect(() =>
    setProposal(map, "r-01", outside.id, "Decision", AT, { plan: input() }),
  ).toThrow();
  expect(JSON.stringify(map)).toBe(before);
  expect(() =>
    setProposal(map, "r-01", "s-01", "Decision", AT, { plan: input() }),
  ).not.toThrow();
});
it("removed assignments and their latest submitted evidence survive in the accepted amendment journal", () => {
  const map = fixture("verified");
  const plan = accept(map);
  submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
  const next = input("verified");
  next.id = plan.id;
  next.rev = 0;
  next.items = [next.items[1]!];
  next.items[0]!.after = [];
  accept(map, next);
  const markdown = map.planExports!.at(-1)!.content;
  expect(map.plans![0]!.items.map((item) => item.id)).toEqual([2]);
  expect(markdown).toContain("Removed items at this amendment");
  expect(markdown).toContain("Test passed");
  expect(markdown).toContain("Status: done");
});
it("human can return a verified item after completion was proposed, invalidating dependent results", () => {
  const map = fixture("verified");
  const plan = accept(map);
  submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
  verifyPlanItem(map, plan.id, 0, 1, "s-03", "verified", "Reviewed", AT);
  submitPlanItem(map, plan.id, 0, 2, "s-01", evidence, AT);
  verifyPlanItem(map, plan.id, 0, 2, "s-03", "verified", "Reviewed", AT);
  const proposal = proposeCompletion(
    map,
    "r-01",
    "s-01",
    plan.id,
    0,
    "Final",
    AT,
  );
  verifyPlanItem(
    map,
    plan.id,
    0,
    1,
    HUMAN,
    "returned",
    "Found a regression",
    AT,
  );
  expect(map.plans![0]!.status).toBe("active");
  expect(map.plans![0]!.items.map((item) => item.status)).toEqual([
    "returned",
    "waiting",
  ]);
  expect(map.plans![0]!.items[1]!.evidence).toBeNull();
  expect(map.rooms[0]!.proposal).toBeNull();
  expect(() =>
    resolveProposal(
      map,
      "r-01",
      proposal.proposalId,
      "accept",
      { rev: proposal.rev, planId: plan.id, planRev: 0 },
      AT,
    ),
  ).toThrow();
});
it.each(["cycle", "basis"])(
  "rejects malformed persisted %s rather than enabling an assignment",
  (kind) => {
    const map = fixture("verified");
    accept(map);
    if (kind === "cycle") map.plans![0]!.items[0]!.after = [2];
    else map.plans![0]!.items[0]!.acceptedChecklistRevision = -1;
    expect(() => parseMap(JSON.stringify(map), "fixture")).toThrow();
  },
);

it("downgrade removes the verifier queue and promotion basis while keeping done and reloadable state", () => {
  const map = fixture();
  const plan = accept(map);
  submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
  setRoomMode(map, "r-01", HUMAN, "verified", "Review remaining", {}, AT);
  const promoted = input("verified");
  promoted.id = plan.id;
  promoted.rev = 0;
  accept(map, promoted);
  setRoomMode(map, "r-01", HUMAN, "checklist", "Enough review", {}, AT);
  const reloaded = parseMap(JSON.stringify(map), "fixture");
  expect(reloaded.plans![0]!.items[0]!.status).toBe("done");
  expect(
    reloaded.plans![0]!.items[0]!.acceptedChecklistRevision,
  ).toBeUndefined();
  expect(
    reloaded.plans![0]!.items.every(
      (item) => item.verifier === null && !item.criteria.length,
    ),
  ).toBe(true);
  const amended = input();
  amended.id = plan.id;
  amended.rev = 1;
  accept(map, amended);
  expect(map.plans![0]!.items[0]!.status).toBe("done");
});

it("captures artifact paths verbatim as evidence text without resolving or reading them", () => {
  const map = fixture();
  const plan = accept(map);
  const artifacts = [
    "/private/tmp/result.md",
    "../shared/report.md",
    "C:\\reports\\result.txt",
    "nested/line\nname",
  ];
  submitPlanItem(
    map,
    plan.id,
    0,
    1,
    "s-02",
    { text: "Reproduced 🛠️", artifacts },
    AT,
  );
  expect(map.plans![0]!.items[0]!.evidence).toEqual({
    text: "Reproduced 🛠️",
    artifacts,
  });
  submitPlanItem(map, plan.id, 0, 2, "s-01", evidence, AT);
  for (const value of artifacts)
    expect(map.planExports!.at(-1)!.content).toContain(value);
});
it.each(["goal", "evidence", "summary"])(
  "rejects non-roundtrippable UTF-8 %s before mutating or capturing another payload",
  (field) => {
    const map = fixture(field === "summary" ? "verified" : "checklist");
    if (field === "goal") {
      const draft = input();
      draft.goal = "Bad \ud800";
      const before = JSON.stringify(map);
      expect(() => accept(map, draft)).toThrow();
      expect(JSON.stringify(map)).toBe(before);
      return;
    }
    const plan = accept(map);
    if (field === "evidence") {
      const before = JSON.stringify(map);
      expect(() =>
        submitPlanItem(
          map,
          plan.id,
          0,
          1,
          "s-02",
          { text: "Bad \ud800", artifacts: [] },
          AT,
        ),
      ).toThrow();
      expect(JSON.stringify(map)).toBe(before);
      return;
    }
    submitPlanItem(map, plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 1, "s-03", "verified", "Reviewed", AT);
    submitPlanItem(map, plan.id, 0, 2, "s-01", evidence, AT);
    verifyPlanItem(map, plan.id, 0, 2, "s-03", "verified", "Reviewed", AT);
    const before = JSON.stringify(map);
    expect(() =>
      proposeCompletion(map, "r-01", "s-01", plan.id, 0, "Bad \ud800", AT),
    ).toThrow();
    expect(JSON.stringify(map)).toBe(before);
  },
);
