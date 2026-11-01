import { describe, expect, it } from "vitest";
import { addSession, transitionSession } from "./map.js";
import { mapLetterTx } from "./letter-store.js";
import { viewBytes } from "./context-pages.js";
import { ASSIGNMENTS_BLOCK_MAX_BYTES, contextBytes } from "./context-budget.js";
import {
  PLAN_TASKS_MAX_BYTES,
  assignmentsBlock,
  planTasksNext,
  planTasksView,
} from "./plan-tasks.js";
import type { PlanTasksView } from "./plan-tasks.js";
import { planSubmission } from "./plan-state.js";
import {
  cancelRoomPlan,
  savePlanCheckpoint,
  submitPlanItem,
  updatePlanItem,
  verifyPlanItem,
} from "./plans.js";
import {
  proposeCompletion,
  resolveProposal,
  setProposal,
} from "./proposals.js";
import { addRoom, archiveRoom } from "./rooms.js";
import { HUMAN } from "./types.js";
import type { PlanDraft, WorkMap } from "./types.js";

const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;
const AT = "2026-10-04T01:00:00.000Z";
const evidence = { text: "Test passed", artifacts: ["src/a.ts"] };

/** s-01 Lead (ведущий и владелец пункта 2), s-02 Owner, s-03 Verifier, s-04 вне комнаты. */
function fixture(): WorkMap {
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
  for (const label of ["Lead", "Owner", "Verifier", "Outsider"])
    addSession(map, { provider: "codex", label, task: "Fixture" }, AT);
  addRoom(
    map,
    {
      title: "Plan",
      creator: HUMAN,
      members: ["s-01", "s-02", "s-03"],
      lead: "s-01",
      mode: "verified",
    },
    AT,
  );
  return map;
}
const draft = (): PlanDraft => ({
  mode: "verified",
  goal: "Accepted complete behavior",
  items: [
    {
      id: 1,
      title: "Implement",
      owner: "s-02",
      scope: "src/a.ts",
      criteria: ["Works"],
      verifier: "s-03",
    },
    {
      id: 2,
      title: "Integrate",
      owner: "s-01",
      scope: "src/b.ts",
      after: [1],
      criteria: ["Integrated"],
      verifier: "s-03",
    },
    {
      id: 3,
      title: "Document",
      owner: "s-02",
      scope: "docs/c.md",
      criteria: ["Written"],
      verifier: "s-03",
    },
  ],
});
function accept(map: WorkMap, input: PlanDraft = draft()) {
  const p = setProposal(map, "r-01", "s-01", "Decision", AT, { plan: input });
  const plan = map.rooms[0]!.proposal!.plan!;
  resolveProposal(
    map,
    lt(map),
    "r-01",
    p.proposalId,
    "accept",
    { rev: p.rev, planId: plan.id, planRev: plan.rev },
    AT,
  );
  return map.plans![0]!;
}
const rows = (view: PlanTasksView) =>
  view.assignments.map(
    (entry) => `${entry.item ?? "-"}:${entry.role}:${entry.action}`,
  );
const unchanged = (map: WorkMap, run: () => void) => {
  const before = JSON.stringify(map);
  run();
  expect(JSON.stringify(map)).toBe(before);
};

describe("planTasksView: action table", () => {
  it("a fresh plan: owners start, the dependent owner and the verifier wait", () => {
    const map = fixture();
    accept(map);
    unchanged(map, () => {
      const owner = planTasksView(map, "s-02", {});
      expect(rows(owner)).toEqual(["1:owner:start", "3:owner:start"]);
      expect(owner.total).toBe(2);
      expect(owner.next).toBeNull();
      expect(owner.session).toBe("s-02");
      const lead = planTasksView(map, "s-01", {});
      expect(rows(lead)).toEqual(["2:owner:wait"]);
      expect(lead.assignments[0]!.waitingFor).toEqual({
        kind: "dependencies",
        items: [1],
      });
      const verifier = planTasksView(map, "s-03", {});
      expect(rows(verifier)).toEqual([
        "1:verifier:wait",
        "2:verifier:wait",
        "3:verifier:wait",
      ]);
      expect(verifier.assignments[0]!.waitingFor).toEqual({
        kind: "submission",
        by: "s-02",
      });
    });
  });

  it("an item in progress continues; a blocked one waits for the lead, who resolves it", () => {
    const map = fixture();
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    updatePlanItem(map, plan.id, 0, 3, "s-02", "blocked", "No fixture", AT);
    const owner = planTasksView(map, "s-02", {});
    expect(rows(owner)).toEqual(["1:owner:continue", "3:owner:wait"]);
    expect(owner.assignments[1]!.waitingFor).toEqual({
      kind: "blocked",
      note: "No fixture",
    });
    expect(owner.assignments[1]!.note).toBe("No fixture");
    // Лид: resolve-block раньше любого wait.
    expect(rows(planTasksView(map, "s-01", {}))).toEqual([
      "3:lead:resolve-block",
      "2:owner:wait",
    ]);
  });

  it("a submitted item: the verifier verifies, the owner waits for the verification", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    const verifier = planTasksView(map, "s-03", {});
    expect(rows(verifier)).toEqual([
      "1:verifier:verify",
      "2:verifier:wait",
      "3:verifier:wait",
    ]);
    expect(verifier.assignments[0]).toMatchObject({
      planId: plan.id,
      rev: 0,
      room: "r-01",
      roomTitle: "Plan",
      mode: "verified",
      title: "Implement",
      status: "done",
      submission: planSubmission(map.plans![0]!.items[0]!),
      evidence,
    });
    const owner = planTasksView(map, "s-02", {});
    expect(rows(owner)).toEqual(["3:owner:start", "1:owner:wait"]);
    expect(owner.assignments[1]!.waitingFor).toEqual({
      kind: "verification",
      by: "s-03",
    });
  });

  it("a returned item: the owner reworks it and sees the verdict and the earlier evidence", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, lt(map), plan.id, 0, 1, "s-03", "returned", "Fix it", AT);
    const owner = planTasksView(map, "s-02", {});
    expect(rows(owner)).toEqual(["1:owner:rework", "3:owner:start"]);
    expect(owner.assignments[0]).toMatchObject({
      status: "returned",
      note: "Fix it",
      evidence,
    });
    expect(rows(planTasksView(map, "s-03", {}))).toContain("1:verifier:wait");
  });

  it("evidence is shown to the verifier on verify and to the owner on returned or done only", () => {
    const map = fixture();
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    expect(planTasksView(map, "s-02", {}).assignments[0]!.evidence).toBeNull();
    const long = { text: "e".repeat(4000), artifacts: ["a".repeat(600)] };
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", long, AT);
    const shown = planTasksView(map, "s-03", {}).assignments[0]!.evidence!;
    expect(shown.text.length).toBeLessThan(1200);
    expect(shown.text).toContain("[cut:");
    expect(shown.artifacts[0]!.length).toBeLessThan(400);
    // Ожидающий проверяющий (item 3) и ожидающий владелец (item 2) доказательств не видят.
    const waiting = planTasksView(map, "s-03", {}).assignments.filter(
      (entry) => entry.action === "wait",
    );
    expect(waiting.every((entry) => entry.evidence === null)).toBe(true);
  });

  it("a plan whose items are all verified asks its live lead to propose completion", () => {
    const map = fixture();
    const plan = accept(map);
    for (const [id, owner] of [
      [1, "s-02"],
      [2, "s-01"],
      [3, "s-02"],
    ] as const) {
      submitPlanItem(map, lt(map), plan.id, 0, id, owner, evidence, AT);
      verifyPlanItem(map, lt(map), plan.id, 0, id, "s-03", "verified", "Seen", AT);
    }
    expect(map.plans![0]!.status).toBe("completing");
    const lead = planTasksView(map, "s-01", {});
    expect(rows(lead)).toEqual(["-:lead:propose-completion"]);
    expect(lead.assignments[0]).toMatchObject({
      planId: plan.id,
      rev: 0,
      item: null,
      title: "Accepted complete behavior",
      status: "completing",
      action: "propose-completion",
      waitingFor: null,
      checkpoint: null,
    });
    // Остальные участники заданий не получают; сделанное уходит в finished.
    for (const id of ["s-02", "s-03"]) {
      const view = planTasksView(map, id, {});
      expect(view.assignments).toEqual([]);
      expect(view.total).toBe(0);
    }
    expect(planTasksView(map, "s-02", {}).finished).toEqual({
      count: 2,
      items: [
        { planId: plan.id, item: 1, title: "Implement", role: "owner" },
        { planId: plan.id, item: 3, title: "Document", role: "owner" },
      ],
    });
    expect(planTasksView(map, "s-03", {}).finished.count).toBe(3);
    // Лид сделал свой пункт 2 как владелец: он в finished, а не в assignments.
    expect(lead.finished.items).toEqual([
      { planId: plan.id, item: 2, title: "Integrate", role: "owner" },
    ]);
    // Пока предложение не принесено, а план ещё active, лид этой строки не получает.
    const other = fixture();
    accept(other);
    expect(rows(planTasksView(other, "s-01", {}))).not.toContain(
      "-:lead:propose-completion",
    );
  });

  it("finished keeps at most 30 items but reports the full count", () => {
    const map = fixture();
    const many = draft();
    many.items = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      title: `Item ${index + 1}`,
      owner: "s-02",
      scope: "src",
      criteria: ["ok"],
      verifier: "s-03",
    }));
    const plan = accept(map, many);
    for (let id = 1; id <= 30; id++) {
      submitPlanItem(map, lt(map), plan.id, 0, id, "s-02", evidence, AT);
      verifyPlanItem(map, lt(map), plan.id, 0, id, "s-03", "verified", "Seen", AT);
    }
    const view = planTasksView(map, "s-02", {});
    expect(view.finished.count).toBe(30);
    expect(view.finished.items).toHaveLength(30);
    expect(view.total).toBe(0);
  });
});

describe("planTasksView: scope", () => {
  it("a session outside the room sees nothing, and neither does the room owner without membership", () => {
    const map = fixture();
    accept(map);
    map.rooms[0]!.ownerId = "s-04";
    unchanged(map, () => {
      expect(planTasksView(map, "s-04", {})).toEqual({
        session: "s-04",
        total: 0,
        assignments: [],
        finished: { count: 0, items: [] },
        next: null,
      });
    });
  });

  it("a member who left the room no longer sees its assignments", () => {
    const map = fixture();
    accept(map);
    map.rooms[0]!.members = ["s-01", "s-03"];
    expect(planTasksView(map, "s-02", {}).total).toBe(0);
  });

  it("cancelled, completed and archived plans are excluded", () => {
    const cancelled = fixture();
    const cancelledPlan = accept(cancelled);
    cancelRoomPlan(cancelled, lt(cancelled), cancelledPlan.id, 0, HUMAN, AT);
    expect(cancelled.plans![0]!.status).toBe("cancelled");
    expect(planTasksView(cancelled, "s-02", {}).total).toBe(0);

    const completed = fixture();
    const plan = accept(completed);
    for (const [id, owner] of [
      [1, "s-02"],
      [2, "s-01"],
      [3, "s-02"],
    ] as const) {
      submitPlanItem(completed, lt(completed), plan.id, 0, id, owner, evidence, AT);
      verifyPlanItem(completed, lt(completed), plan.id, 0, id, "s-03", "verified", "Seen", AT);
    }
    const p = proposeCompletion(completed, "r-01", "s-01", plan.id, 0, "Done", AT);
    resolveProposal(
      completed,
      lt(completed),
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: plan.id, planRev: 0 },
      AT,
    );
    expect(completed.plans![0]!.status).toBe("completed");
    for (const id of ["s-01", "s-02", "s-03"])
      expect(planTasksView(completed, id, {})).toMatchObject({
        total: 0,
        finished: { count: 0 },
      });

    const archived = fixture();
    accept(archived);
    archiveRoom(archived, lt(archived), "r-01", AT);
    expect(planTasksView(archived, "s-02", {}).total).toBe(0);
  });

  it("an autonomous plan gives no assignments, finished items or completion duty", () => {
    const map = fixture();
    const plan = accept(map);
    plan.mode = "autonomous";
    for (const id of ["s-01", "s-02", "s-03"])
      expect(planTasksView(map, id, {})).toMatchObject({
        total: 0,
        finished: { count: 0 },
      });
    expect(planTasksNext(map, "s-02")).toEqual({ total: 0, assignments: [] });
    plan.status = "completing";
    expect(planTasksView(map, "s-01", {}).total).toBe(0);
  });

  it("a plan whose room has no live member is excluded", () => {
    const map = fixture();
    accept(map);
    for (const id of ["s-01", "s-02", "s-03"])
      transitionSession(map, id, "closed");
    expect(planTasksView(map, "s-02", {}).total).toBe(0);
  });

  it("after a reassignment the item disappears from the old owner and appears for the new one", () => {
    const map = fixture();
    const plan = accept(map);
    map.rooms[0]!.members.push("s-04");
    const amended = draft();
    amended.id = plan.id;
    amended.rev = 0;
    amended.items[2]!.owner = "s-04";
    accept(map, amended);
    expect(map.plans![0]!.rev).toBe(1);
    expect(rows(planTasksView(map, "s-02", {}))).toEqual(["1:owner:start"]);
    const next = planTasksView(map, "s-04", {});
    expect(rows(next)).toEqual(["3:owner:start"]);
    expect(next.assignments[0]!.rev).toBe(1);
  });

  it("a plan from another room is invisible to the members of this one", () => {
    const map = fixture();
    accept(map);
    addRoom(
      map,
      {
        title: "Other",
        creator: HUMAN,
        members: ["s-04"],
        lead: "s-04",
        mode: "verified",
      },
      AT,
    );
    expect(planTasksView(map, "s-04", {}).total).toBe(0);
  });
});

describe("planTasksView: the S12 scenario", () => {
  it("two verify letters already read: both verifications are still listed and nothing is mutated", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    submitPlanItem(map, lt(map), plan.id, 0, 3, "s-02", evidence, AT);
    // Письма лежат вне карты: читаем их через обычный доступ и отмечаем прочитанными.
    const letters = lt(map);
    for (const item of [1, 3]) {
      const letter = letters.add({
        from: "parley",
        to: ["s-03"],
        text: `Verify item ${item}`,
        kind: "note",
        roomId: "r-01",
        at: AT,
      });
      letters.markRead("s-03", [letter.id], AT);
    }
    unchanged(map, () => {
      const view = planTasksView(map, "s-03", {});
      expect(
        view.assignments
          .filter((entry) => entry.action === "verify")
          .map((entry) => entry.item),
      ).toEqual([1, 3]);
      expect(view.total).toBe(3);
    });
  });

  it("an empty inbox does not hide open assignments", () => {
    const map = fixture();
    accept(map);
    expect(lt(map).query({ limit: 100 }).filter((m) => m.to.includes("s-02"))).toEqual([]);
    expect(rows(planTasksView(map, "s-02", {}))).toEqual([
      "1:owner:start",
      "3:owner:start",
    ]);
  });
});

describe("planTasksView: checkpoints", () => {
  const save = { done: "Parser done", next: "Wire the tests" };
  function withCheckpoints() {
    const map = fixture();
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    savePlanCheckpoint(map, plan.id, 0, 1, "s-02", save, AT);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    savePlanCheckpoint(
      map,
      plan.id,
      0,
      1,
      "s-03",
      { done: "Read the diff", next: "Run the suite", blocker: "No CI" },
      AT,
    );
    return { map, plan };
  }

  it("each role sees its own checkpoint", () => {
    const { map } = withCheckpoints();
    const owner = planTasksView(map, "s-02", {}).assignments.find(
      (entry) => entry.item === 1,
    )!;
    expect(owner.checkpoint).toMatchObject({ by: "s-02", done: "Parser done" });
    expect(owner.checkpoint).not.toHaveProperty("stale");
    const verifier = planTasksView(map, "s-03", {}).assignments.find(
      (entry) => entry.item === 1,
    )!;
    expect(verifier.checkpoint).toMatchObject({
      by: "s-03",
      next: "Run the suite",
      blocker: "No CI",
      submission: planSubmission(map.plans![0]!.items[0]!),
    });
    expect(verifier.checkpoint).not.toHaveProperty("stale");
  });

  it("a verifier checkpoint of an earlier submission is marked stale", () => {
    const { map } = withCheckpoints();
    map.plans![0]!.items[0]!.log.push({
      at: AT,
      by: "s-02",
      status: "done",
      note: null,
    });
    const verifier = planTasksView(map, "s-03", {}).assignments.find(
      (entry) => entry.item === 1,
    )!;
    expect(verifier.checkpoint).toMatchObject({ by: "s-03", stale: true });
  });

  it("the checkpoint survives a round trip through JSON, as after a host restart", () => {
    const { map } = withCheckpoints();
    const reloaded = JSON.parse(JSON.stringify(map)) as WorkMap;
    expect(planTasksView(reloaded, "s-03", {})).toEqual(
      planTasksView(map, "s-03", {}),
    );
  });
});

describe("planTasksView: pages", () => {
  function crowded(count = 9) {
    const map = fixture();
    const big = draft();
    big.items = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      title: `Item ${index + 1}`,
      owner: "s-02",
      scope: "s".repeat(500),
      criteria: ["Works"],
      verifier: "s-03",
    }));
    const plan = accept(map, big);
    return { map, plan };
  }
  const keys = (view: PlanTasksView) =>
    view.assignments.map((entry) => `${entry.planId}#${entry.item}`);

  it("the default page is 16 KiB and holds a small list whole", () => {
    expect(PLAN_TASKS_MAX_BYTES).toBe(16 * 1024);
    const { map } = crowded(3);
    const view = planTasksView(map, "s-02", {});
    expect(view.assignments).toHaveLength(3);
    expect(view.next).toBeNull();
  });

  it("a long list is paged without gaps or repeats, within the byte limit, with the same total", () => {
    const { map } = crowded();
    const whole = planTasksView(map, "s-02", {});
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const view = planTasksView(map, "s-02", {
        maxBytes: 2048,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      expect(view.total).toBe(9);
      if (view.assignments.length > 1)
        expect(viewBytes(view)).toBeLessThanOrEqual(2048);
      if (view.next !== null)
        expect(view.assignments.length).toBeGreaterThan(0);
      collected.push(...keys(view));
      cursor = view.next ?? undefined;
    } while (cursor !== undefined && pages < 30);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(keys(whole));
    expect(new Set(collected).size).toBe(9);
  });

  it("finished items are listed on the first page only; the count stays", () => {
    const { map, plan } = crowded();
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    verifyPlanItem(map, lt(map), plan.id, 0, 1, "s-03", "verified", "Seen", AT);
    const first = planTasksView(map, "s-02", { maxBytes: 2048 });
    expect(first.next).not.toBeNull();
    expect(first.finished.items).toHaveLength(1);
    const second = planTasksView(map, "s-02", {
      maxBytes: 2048,
      cursor: first.next!,
    });
    expect(second.finished).toEqual({ count: 1, items: [] });
  });

  it("a cursor from a changed list is refused", () => {
    const { map, plan } = crowded();
    const first = planTasksView(map, "s-02", { maxBytes: 2048 });
    expect(first.next).not.toBeNull();
    updatePlanItem(map, plan.id, 0, 5, "s-02", "in_progress", undefined, AT);
    expect(() =>
      planTasksView(map, "s-02", { maxBytes: 2048, cursor: first.next! }),
    ).toThrow("assignments changed; call plan_tasks without cursor");
  });

  it("a cursor of another filter or another session is refused, and garbage is invalid", () => {
    const { map, plan } = crowded();
    const first = planTasksView(map, "s-02", { maxBytes: 2048 });
    expect(() =>
      planTasksView(map, "s-02", {
        planId: plan.id,
        item: 1,
        cursor: first.next!,
      }),
    ).toThrow(/assignments changed/);
    expect(() =>
      planTasksView(map, "s-03", { cursor: first.next! }),
    ).toThrow(/assignments changed/);
    expect(() => planTasksView(map, "s-02", { cursor: "not-a-cursor" })).toThrow(
      /invalid cursor/,
    );
  });

  it("an entry that alone exceeds the limit still comes through, one per page", () => {
    const { map } = crowded(3);
    const view = planTasksView(map, "s-02", { maxBytes: 1 });
    expect(view.assignments).toHaveLength(1);
    expect(view.total).toBe(3);
    expect(view.next).not.toBeNull();
  });
});

describe("planTasksView: reading one item", () => {
  function longItem() {
    const map = fixture();
    const input = draft();
    input.items[0]!.scope = "scope ".repeat(800);
    input.items[0]!.criteria = ["c".repeat(900)];
    const plan = accept(map, input);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    for (let round = 0; round < 7; round++) {
      updatePlanItem(map, plan.id, 0, 1, "s-02", "blocked", `Wait ${round}`, AT);
      updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    }
    savePlanCheckpoint(map, plan.id, 0, 1, "s-02", {
      done: "Owner position",
      next: "Keep going",
    });
    return { map, plan };
  }

  it("returns full texts, the last ten log entries and both checkpoints to any room member", () => {
    const { map, plan } = longItem();
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    savePlanCheckpoint(map, plan.id, 0, 1, "s-03", {
      done: "Review position",
      next: "Verdict",
    });
    const item = map.plans![0]!.items[0]!;
    // s-01 не владелец и не проверяющий пункта 1, но участник комнаты.
    const view = planTasksView(map, "s-01", { planId: plan.id, item: 1 });
    expect(view.assignments).toEqual([]);
    expect(view.detail).toMatchObject({
      planId: plan.id,
      rev: 0,
      item: 1,
      title: "Implement",
      owner: "s-02",
      verifier: "s-03",
      status: "done",
      scope: item.scope,
      criteria: item.criteria,
      evidence,
      submission: planSubmission(item),
    });
    expect(view.detail!.log).toEqual(item.log.slice(-10));
    expect(view.detail!.log).toHaveLength(10);
    expect(view.detail!.progress.owner).toMatchObject({ done: "Owner position" });
    expect(view.detail!.progress.verifier).toMatchObject({
      done: "Review position",
    });
  });

  it("the list form cuts a long scope and points at the item filter", () => {
    const { map } = longItem();
    const listed = planTasksView(map, "s-02", {}).assignments[0]!;
    expect(listed.scope!.length).toBeLessThan(1200);
    expect(listed.scope).toContain("[cut:");
    expect(listed.criteria[0]!.length).toBeLessThan(400);
    expect(planTasksView(map, "s-02", {}).detail).toBeUndefined();
  });

  it("with a planId alone it narrows the list to that plan", () => {
    const { map, plan } = longItem();
    const view = planTasksView(map, "s-02", { planId: plan.id });
    expect(view.total).toBe(2);
  });

  it("refuses an item without planId, an unknown plan or item, and a non-member", () => {
    const { map, plan } = longItem();
    expect(() => planTasksView(map, "s-02", { item: 1 })).toThrow(/planId/);
    expect(() => planTasksView(map, "s-02", { planId: "pl-99" })).toThrow(
      /not available/,
    );
    expect(() =>
      planTasksView(map, "s-02", { planId: plan.id, item: 9 }),
    ).toThrow(/no item 9/);
    expect(() =>
      planTasksView(map, "s-04", { planId: plan.id, item: 1 }),
    ).toThrow(/not available/);
  });
});

describe("planTasksNext", () => {
  it("is the compact form: total and at most five short assignments", () => {
    const map = fixture();
    const many = draft();
    many.items = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      title: `Item ${index + 1} ${"t".repeat(200)}`,
      owner: "s-02",
      scope: "s".repeat(300),
      criteria: ["Works"],
      verifier: "s-03",
    }));
    const plan = accept(map, many);
    const next = planTasksNext(map, "s-02");
    expect(next.total).toBe(8);
    expect(next.assignments).toHaveLength(5);
    expect(Object.keys(next.assignments[0]!)).toEqual([
      "planId",
      "rev",
      "item",
      "role",
      "action",
      "title",
    ]);
    expect(next.assignments[0]).toMatchObject({
      planId: plan.id,
      rev: 0,
      item: 1,
      role: "owner",
      action: "start",
    });
    expect(JSON.stringify(next).length).toBeLessThan(1500);
    expect(planTasksNext(map, "s-04")).toEqual({ total: 0, assignments: [] });
  });
});

describe("assignmentsBlock: the open-assignments block of the session layer (C6)", () => {
  const HEAD =
    "Open room assignments (reading a letter does not finish them; call plan_tasks): ";
  /** Пункты одного владельца s-02: по одному заданию на каждый. */
  function owned(count: number, extra: Partial<PlanDraft["items"][number]> = {}) {
    const map = fixture();
    const many = draft();
    many.items = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      title: `Item ${index + 1} ${"t".repeat(300)}`,
      owner: "s-02",
      scope: "s".repeat(300),
      criteria: ["Works"],
      verifier: "s-03",
      ...extra,
    }));
    const plan = accept(map, many);
    return { map, plan };
  }

  it("no assignments: an empty string for a session outside the room, an empty map and an unknown session", () => {
    const map = fixture();
    expect(assignmentsBlock(map, "s-02")).toBe("");
    accept(map);
    expect(assignmentsBlock(map, "s-04")).toBe("");
    expect(assignmentsBlock(map, "s-99")).toBe("");
  });

  it("one assignment: the header, the action and a full stop, no tail", () => {
    const map = fixture();
    const one = draft();
    one.items = [one.items[0]!];
    const plan = accept(map, one);
    unchanged(map, () => {
      expect(assignmentsBlock(map, "s-02")).toBe(
        `${HEAD}${plan.id} rev 0 #1 start.`,
      );
    });
  });

  it("the owner position: a continue entry carries its checkpoint next", () => {
    const map = fixture();
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    savePlanCheckpoint(
      map,
      plan.id,
      0,
      1,
      "s-02",
      { done: "Parser done", next: "Wire the tests" },
      AT,
    );
    expect(assignmentsBlock(map, "s-02")).toBe(
      `${HEAD}${plan.id} rev 0 #1 continue — next: Wire the tests; ${plan.id} rev 0 #3 start.`,
    );
  });

  it("plan_tasks order: verify before wait, the verifier entry carries the verifier next", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    savePlanCheckpoint(
      map,
      plan.id,
      0,
      1,
      "s-03",
      { done: "Read the diff", next: "Run the suite" },
      AT,
    );
    expect(assignmentsBlock(map, "s-03")).toBe(
      `${HEAD}${plan.id} rev 0 #1 verify — next: Run the suite; ${plan.id} rev 0 #2 wait; ${plan.id} rev 0 #3 wait.`,
    );
  });

  it("rework shows the owner next; wait and start entries carry none", () => {
    const map = fixture();
    const plan = accept(map);
    updatePlanItem(map, plan.id, 0, 1, "s-02", "in_progress", undefined, AT);
    savePlanCheckpoint(
      map,
      plan.id,
      0,
      1,
      "s-02",
      { done: "Parser done", next: "Fix the edge case" },
      AT,
    );
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    // Сдан и ждёт проверки: это запись wait, позиция в блок не идёт.
    expect(assignmentsBlock(map, "s-02")).not.toContain("next:");
    verifyPlanItem(map, lt(map), plan.id, 0, 1, "s-03", "returned", "Fix it", AT);
    expect(assignmentsBlock(map, "s-02")).toBe(
      `${HEAD}${plan.id} rev 0 #1 rework — next: Fix the edge case; ${plan.id} rev 0 #3 start.`,
    );
  });

  it("a verifier checkpoint of an earlier submission is stale and stays out of the block", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    savePlanCheckpoint(
      map,
      plan.id,
      0,
      1,
      "s-03",
      { done: "Read the diff", next: "Run the suite" },
      AT,
    );
    map.plans![0]!.items[0]!.log.push({
      at: AT,
      by: "s-02",
      status: "done",
      note: null,
    });
    const block = assignmentsBlock(map, "s-03");
    expect(block).toContain(`${plan.id} rev 0 #1 verify;`);
    expect(block).not.toContain("Run the suite");
  });

  it("a whole-plan assignment has no item number", () => {
    const map = fixture();
    const plan = accept(map);
    for (const [id, owner] of [
      [1, "s-02"],
      [2, "s-01"],
      [3, "s-02"],
    ] as const) {
      submitPlanItem(map, lt(map), plan.id, 0, id, owner, evidence, AT);
      verifyPlanItem(map, lt(map), plan.id, 0, id, "s-03", "verified", "Seen", AT);
    }
    expect(assignmentsBlock(map, "s-01")).toBe(
      `${HEAD}${plan.id} rev 0 propose-completion.`,
    );
  });

  it("six assignments: five are shown and the rest is counted as +1 more", () => {
    const { map, plan } = owned(6);
    expect(assignmentsBlock(map, "s-02")).toBe(
      `${HEAD}${[1, 2, 3, 4, 5].map((id) => `${plan.id} rev 0 #${id} start`).join("; ")}; +1 more.`,
    );
    const nine = owned(9);
    expect(assignmentsBlock(nine.map, "s-02")).toMatch(/; \+4 more\.$/);
  });

  it("the entries are those of plan_tasks, in the same order", () => {
    const map = fixture();
    const plan = accept(map);
    submitPlanItem(map, lt(map), plan.id, 0, 1, "s-02", evidence, AT);
    updatePlanItem(map, plan.id, 0, 3, "s-02", "blocked", "No fixture", AT);
    for (const session of ["s-01", "s-02", "s-03"]) {
      const view = planTasksView(map, session, {});
      const expected = view.assignments
        .map((entry) =>
          entry.item === null
            ? `${entry.planId} rev ${entry.rev} ${entry.action}`
            : `${entry.planId} rev ${entry.rev} #${entry.item} ${entry.action}`,
        )
        .join("; ");
      const block = assignmentsBlock(map, session);
      expect(block.slice(HEAD.length, -1).replace(/ — next: [^;]*/g, "")).toBe(
        expected,
      );
    }
  });

  it("bounds: a long multibyte next is cut per entry, the block stays within 1024 bytes and never splits a character", () => {
    const { map, plan } = owned(7);
    for (const [index, text] of [
      "я".repeat(300),
      "😀".repeat(75),
      '"\n\t'.repeat(60),
      "ж".repeat(299) + "é",
      "n".repeat(300),
      "\u0001".repeat(40),
      "x",
    ].entries()) {
      updatePlanItem(map, plan.id, 0, index + 1, "s-02", "in_progress", undefined, AT);
      savePlanCheckpoint(
        map,
        plan.id,
        0,
        index + 1,
        "s-02",
        { done: "d", next: text },
        AT,
      );
    }
    const block = assignmentsBlock(map, "s-02");
    expect(ASSIGNMENTS_BLOCK_MAX_BYTES).toBe(1024);
    expect(contextBytes(block)).toBeLessThanOrEqual(ASSIGNMENTS_BLOCK_MAX_BYTES);
    expect(block.startsWith(HEAD)).toBe(true);
    expect(block.endsWith("+2 more.")).toBe(true);
    expect(block.split("\n")).toHaveLength(1);
    expect(/\p{Surrogate}/u.test(block)).toBe(false);
    expect(block).not.toContain("\uFFFD");
    expect(block).toContain("[cut:");
  });

  it("a block with very long identifiers stays within the bound: the surplus entries go to +N more", () => {
    const { map, plan } = owned(5);
    for (const id of [1, 2, 3, 4, 5]) {
      updatePlanItem(map, plan.id, 0, id, "s-02", "in_progress", undefined, AT);
      savePlanCheckpoint(
        map,
        plan.id,
        0,
        id,
        "s-02",
        { done: "d", next: "я".repeat(300) },
        AT,
      );
    }
    map.plans![0]!.id = "pl-" + "9".repeat(60);
    map.plans![0]!.rev = 123456789;
    const block = assignmentsBlock(map, "s-02");
    expect(contextBytes(block)).toBeLessThanOrEqual(ASSIGNMENTS_BLOCK_MAX_BYTES);
    expect(block).toMatch(/\+\d+ more\.$/);
  });

  it("an autonomous plan gives no block: its items are driven by the engine", () => {
    const map = fixture();
    accept(map);
    expect(assignmentsBlock(map, "s-02")).not.toBe("");
    map.plans![0]!.mode = "autonomous";
    expect(assignmentsBlock(map, "s-02")).toBe("");
  });

  it("does not change the map and survives a JSON round trip", () => {
    const { map } = owned(3);
    unchanged(map, () => {
      assignmentsBlock(map, "s-02");
    });
    const reloaded = JSON.parse(JSON.stringify(map)) as WorkMap;
    expect(assignmentsBlock(reloaded, "s-02")).toBe(assignmentsBlock(map, "s-02"));
  });
});
