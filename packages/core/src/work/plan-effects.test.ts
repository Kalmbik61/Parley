import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMessage, addSession, parseMap, transitionSession } from "./map.js";
import { addRoom, archiveRoom } from "./rooms.js";
import {
  proposeCompletion,
  resolveProposal,
  setProposal,
} from "./proposals.js";
import { setRoomMode, submitPlanItem, verifyPlanItem } from "./plans.js";
import { lookupIn, unreadFor } from "./letters.js";
import {
  capturePlanNotice,
  cancelledPlanLetter,
  PLAN_LETTERS_PER_HOUR,
  reservePlanEffects,
  resumablePlanLetter,
  validatePlanEffects,
} from "./plan-effects.js";
import { HUMAN, PARLEY } from "./types.js";
import type { PlanDraft, PlanEffect, WorkMap } from "./types.js";
import type { BacklogDocument } from "./backlog.js";
import type { PlanEffectsIO } from "./plan-effects.js";
import { mapLetterTx, type LetterTx, type NewLetter } from "./letter-store.js";
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;
const AT = "2026-10-04T01:00:00.000Z";
function fixture(
  mode: "checklist" | "verified" = "verified",
  count = 1,
): WorkMap {
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
  const input: PlanDraft = {
    mode,
    goal: "Done",
    items: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `Item ${i + 1}`,
      owner: "s-02",
      scope: `src/${i}.ts; use a native skill if available`,
      ...(mode === "verified"
        ? { criteria: ["Passing meaningful checks"], verifier: "s-03" }
        : {}),
    })),
  };
  const p = setProposal(map, "r-01", "s-01", "Decision", AT, { plan: input });
  resolveProposal(
    map,
    lt(map),
    "r-01",
    p.proposalId,
    "accept",
    { rev: p.rev, planId: map.rooms[0]!.proposal!.plan!.id, planRev: 0 },
    AT,
  );
  return map;
}
describe("durable accepted-plan delivery", () => {
  it("ordinary Free maps without pending effects remain byte-identical", () => {
    const map = fixture();
    map.plans = undefined as never;
    map.planExports = undefined as never;
    map.rooms[0]!.mode = "free";
    delete map.plans;
    delete map.planExports;
    const before = JSON.stringify(map);
    expect(reservePlanEffects(map, lt(map), 20, AT).changed).toBe(false);
    expect(JSON.stringify(map)).toBe(before);
    expect(map.planEffects).toBeUndefined();
    expect(map.planBacklogIntents).toBeUndefined();
  });
  it("captures scope/criteria and reserves one message and occurrence together, with restart dedup", () => {
    const map = fixture();
    reservePlanEffects(map, lt(map), 20, AT);
    const owned = map.messages.filter((row) => row.from === PARLEY);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.text).toContain("src/0.ts; use a native skill");
    expect(owned[0]!.text).toContain("Passing meaningful checks");
    const restarted = parseMap(JSON.stringify(map), "fixture");
    expect(resumablePlanLetter(restarted, owned[0]!, "s-02", lookupIn(restarted))).toBe(true);
    expect(reservePlanEffects(restarted, lt(restarted), 20, AT).changed).toBe(false);
    expect(
      restarted.messages.filter((row) => row.from === PARLEY),
    ).toHaveLength(1);
  });
  it("queues beyond the room's plan letter budget and releases after its sliding window", () => {
    const map = fixture("checklist", 3);
    expect(reservePlanEffects(map, lt(map), 1, AT).queued).toBe(2);
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(1);
    expect(reservePlanEffects(map, lt(map), 1, "2026-10-04T01:59:59.999Z").queued).toBe(
      2,
    );
    expect(reservePlanEffects(map, lt(map), 1, "2026-10-04T02:00:00.000Z").queued).toBe(
      1,
    );
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(2);
  });
  it("the plan letter budget is 120 per room per hour", () => {
    expect(PLAN_LETTERS_PER_HOUR).toBe(120);
  });
  it("other Parley letters do not use up the plan letter budget", () => {
    const map = fixture("checklist", 1);
    for (let i = 0; i < 25; i++)
      addMessage(map, { from: PARLEY, to: ["s-02"], text: `Other Parley letter ${i}` }, AT);
    expect(reservePlanEffects(map, lt(map), 1, AT).queued).toBe(0);
    expect(
      map.messages.filter((row) => row.from === PARLEY && row.roomId === "r-01"),
    ).toHaveLength(1);
  });
  it("the budget is per room", () => {
    const map = fixture("checklist", 2);
    for (const label of ["Lead 2", "Owner 2", "Reviewer 2"])
      addSession(map, { provider: "codex", label, task: "Fixture" }, AT);
    addRoom(
      map,
      {
        title: "Plan 2",
        creator: HUMAN,
        members: ["s-04", "s-05", "s-06"],
        lead: "s-04",
        mode: "checklist",
      },
      AT,
    );
    const p = setProposal(map, "r-02", "s-04", "Decision", AT, {
      plan: {
        mode: "checklist",
        goal: "Done",
        items: [1, 2].map((id) => ({
          id,
          title: `Item ${id}`,
          owner: "s-05",
          scope: `src/b${id}.ts; use a native skill if available`,
        })),
      },
    });
    resolveProposal(
      map,
      lt(map),
      "r-02",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: map.rooms[1]!.proposal!.plan!.id, planRev: 0 },
      AT,
    );
    // Две комнаты по два пункта, бюджет один: по письму в каждой комнате, остальные два ждут.
    expect(reservePlanEffects(map, lt(map), 1, AT).queued).toBe(2);
    expect(
      map.messages
        .filter((row) => row.from === PARLEY)
        .map((row) => row.roomId)
        .sort(),
    ).toEqual(["r-01", "r-02"]);
  });
  it("does not drop repeated return occurrences within one accepted revision", () => {
    const map = fixture();
    reservePlanEffects(map, lt(map), 20, AT);
    for (let i = 0; i < 2; i++) {
      submitPlanItem(
        map,
        lt(map),
        "pl-01",
        0,
        1,
        "s-02",
        { text: "Measured", artifacts: [] },
        AT,
      );
      reservePlanEffects(map, lt(map), 20, AT);
      verifyPlanItem(
        map,
        lt(map),
        "pl-01",
        0,
        1,
        "s-03",
        "returned",
        `Fix case ${i}`,
        AT,
      );
      reservePlanEffects(map, lt(map), 20, AT);
    }
    expect(
      map.planEffects!.filter((row) => row.kind === "returned"),
    ).toHaveLength(2);
    expect(new Set(map.planEffects!.map((row) => row.key)).size).toBe(
      map.planEffects!.length,
    );
  });
  it("invalidates queued and sent old-scope assignments on an accepted amendment", () => {
    const map = fixture("checklist", 2);
    reservePlanEffects(map, lt(map), 1, AT);
    const old = map.messages.find((row) => row.from === PARLEY)!;
    const plan = map.plans![0]!;
    const p = setProposal(map, "r-01", "s-01", "Amend", AT, {
      plan: {
        id: plan.id,
        rev: plan.rev,
        mode: "checklist",
        goal: plan.goal,
        items: plan.items.map((row) => ({
          ...row,
          scope: "New accepted scope",
        })),
      },
    });
    resolveProposal(
      map,
      lt(map),
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: plan.id, planRev: 1 },
      AT,
    );
    reservePlanEffects(map, lt(map), 1, AT);
    expect(
      map
        .planEffects!.filter((row) => row.rev === 0)
        .every((row) => row.status === "cancelled"),
    ).toBe(true);
    expect(cancelledPlanLetter(map, old, lookupIn(map))).toBe(true);
    expect(unreadFor(map, "s-02")).not.toContainEqual(old);
    expect(map.messages).toContainEqual(old);
    expect(old.readBy["s-02"]).toBeUndefined();
    expect(reservePlanEffects(map, lt(map), 1, "2026-10-04T02:00:00.000Z").queued).toBe(
      1,
    );
    expect(map.messages.at(-1)!.text).toContain("New accepted scope");
  });
  it("tells the letter store about a sent effect that stopped being current, and only about that one", () => {
    const map = fixture("checklist", 2);
    reservePlanEffects(map, lt(map), 1, AT);
    const old = map.messages.find((row) => row.from === PARLEY)!;
    const plan = map.plans![0]!;
    const p = setProposal(map, "r-01", "s-01", "Amend", AT, {
      plan: {
        id: plan.id,
        rev: plan.rev,
        mode: "checklist",
        goal: plan.goal,
        items: plan.items.map((row) => ({ ...row, scope: "New accepted scope" })),
      },
    });
    resolveProposal(
      map,
      lt(map),
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: plan.id, planRev: 1 },
      AT,
    );
    const cancelled: string[] = [];
    const letters: LetterTx = {
      ...lt(map),
      effectCancelled: (messageId) => {
        cancelled.push(messageId);
      },
    };
    reservePlanEffects(map, letters, 1, AT);
    // Item 1 of revision 0 was sent, item 2 only queued: a queued effect has no letter to take back.
    expect(map.planEffects!.filter((row) => row.rev === 0).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled).toEqual([old.id]);
  });
  it("a delivery pass that fails after its first letter leaves no letter and no sent effect behind", () => {
    const map = fixture("checklist", 2);
    const before = JSON.stringify(map);
    const real = lt(map);
    let adds = 0;
    const failing: LetterTx = {
      ...real,
      add(letter: NewLetter) {
        adds += 1;
        if (adds > 1) throw new Error("write failed");
        return real.add(letter);
      },
    };
    expect(() => reservePlanEffects(map, failing, 20, AT)).toThrow("write failed");
    expect(adds).toBe(2);
    expect(JSON.stringify(map)).toBe(before);
    expect(reservePlanEffects(map, lt(map), 20, AT).changed).toBe(true);
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(2);
  });
  const VERIFY_HEAD =
    "Accepted plan pl-01, revision 0, item 1: Item 1\nScope:\nsrc/0.ts; use a native skill if available\nCriteria:\nPassing meaningful checks\nEvidence:\nMeasured\nsrc/test.ts\n";
  const submitFirst = (map: WorkMap, by = "s-02") =>
    submitPlanItem(map, lt(map), "pl-01", 0, 1, by, { text: "Measured", artifacts: ["src/test.ts"] }, AT);
  it("verify letter to an available verifier keeps its exact text", () => {
    const map = fixture();
    submitFirst(map);
    reservePlanEffects(map, lt(map), 20, AT);
    const sent = map.planEffects!.filter((row) => row.kind === "verify");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe("s-03");
    const letter = map.messages.find((row) => row.id === sent[0]!.messageId)!;
    expect(letter.text).toBe(
      `${VERIFY_HEAD}Independently inspect the result and call plan_verify with this exact planId/rev/item.`,
    );
  });
  it("closed verifier: verify letter goes to the live lead with the stand-in tail", () => {
    const map = fixture();
    submitFirst(map);
    reservePlanEffects(map, lt(map), 20, AT);
    transitionSession(map, "s-03", "closed", { at: AT });
    reservePlanEffects(map, lt(map), 20, AT);
    const length = map.plans![0]!.items[0]!.log.length;
    const [old, next] = map.planEffects!.filter((row) => row.kind === "verify");
    expect(old!.target).toBe("s-03");
    expect(old!.status).toBe("cancelled");
    expect(next!.key).toBe(`r-01/pl-01/0/1/verify/${length}/s-01`);
    expect(next!.target).toBe("s-01");
    expect(next!.status).toBe("sent");
    const letter = map.messages.find((row) => row.id === next!.messageId)!;
    expect(letter.to).toEqual(["s-01"]);
    expect(letter.text).toBe(
      `${VERIFY_HEAD}The named verifier is unavailable. Inspect the result and call plan_verify with this exact planId/rev/item; if you own this item, propose an amended plan with another verifier.`,
    );
  });
  it("a verifier removed from the room is unavailable too; the letter is not repeated on the next pass", () => {
    const map = fixture();
    submitFirst(map);
    map.rooms[0]!.members = map.rooms[0]!.members.filter((id) => id !== "s-03");
    reservePlanEffects(map, lt(map), 20, AT);
    const verify = map.planEffects!.filter((row) => row.kind === "verify");
    expect(verify.map((row) => row.target)).toEqual(["s-01"]);
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.planEffects!.filter((row) => row.kind === "verify")).toHaveLength(1);
  });
  it("a lead that owns the item gets the same stand-in letter", () => {
    const map = fixture();
    map.plans![0]!.items[0]!.owner = "s-01";
    submitFirst(map, "s-01");
    transitionSession(map, "s-03", "closed", { at: AT });
    reservePlanEffects(map, lt(map), 20, AT);
    const verify = map.planEffects!.filter((row) => row.kind === "verify");
    expect(verify.map((row) => row.target)).toEqual(["s-01"]);
    const letter = map.messages.find((row) => row.id === verify[0]!.messageId)!;
    expect(letter.text.endsWith("propose an amended plan with another verifier.")).toBe(true);
  });
  it("a submitted item stays verifiable when its owner closes", () => {
    const map = fixture();
    submitPlanItem(
      map,
      lt(map),
      "pl-01",
      0,
      1,
      "s-02",
      { text: "Measured", artifacts: ["src/test.ts"] },
      AT,
    );
    reservePlanEffects(map, lt(map), 20, AT);
    const verify = map.messages.find((row) => row.from === PARLEY)!;
    transitionSession(map, "s-02", "closed", { at: AT });
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.plans![0]!.items[0]!.status).toBe("done");
    expect(map.plans![0]!.items[0]!.evidence!.text).toBe("Measured");
    expect(resumablePlanLetter(map, verify, "s-03", lookupIn(map))).toBe(true);
    expect(cancelledPlanLetter(map, verify, lookupIn(map))).toBe(false);
    expect(map.planEffects!.some((row) => row.kind === "blocked")).toBe(false);
    verifyPlanItem(map, lt(map), "pl-01", 0, 1, "s-03", "verified", "Checked", AT);
    expect(map.plans![0]!.items[0]!.status).toBe("verified");
  });
  it("keeps genuinely verified and completed Checklist results when their owners close", () => {
    for (const mode of ["checklist", "verified"] as const) {
      const map = fixture(mode);
      submitPlanItem(
        map,
        lt(map),
        "pl-01",
        0,
        1,
        "s-02",
        { text: "Measured", artifacts: [] },
        AT,
      );
      if (mode === "verified")
        verifyPlanItem(
          map,
          lt(map),
          "pl-01",
          0,
          1,
          "s-03",
          "verified",
          "Independent check",
          AT,
        );
      transitionSession(map, "s-02", "closed", { at: AT });
      reservePlanEffects(map, lt(map), 20, AT);
      expect(map.plans![0]!.items[0]!.status).toBe(
        mode === "verified" ? "verified" : "done",
      );
    }
  });
  it("retains an explicitly accepted Checklist completion basis after owner closure", () => {
    const map = fixture("checklist", 2);
    submitPlanItem(
      map,
      lt(map),
      "pl-01",
      0,
      1,
      "s-02",
      { text: "Measured", artifacts: [] },
      AT,
    );
    map.rooms[0]!.mode = "verified";
    const plan = map.plans![0]!;
    const p = setProposal(map, "r-01", "s-01", "Promote", AT, {
      plan: {
        id: plan.id,
        rev: 0,
        mode: "verified",
        goal: plan.goal,
        items: plan.items.map((row) => ({
          ...row,
          criteria: ["Works"],
          verifier: "s-03",
        })),
      },
    });
    resolveProposal(
      map,
      lt(map),
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: plan.id, planRev: 1 },
      AT,
    );
    transitionSession(map, "s-02", "closed", { at: AT });
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.plans![0]!.items[0]!.status).toBe("done");
    expect(map.plans![0]!.items[0]!.acceptedChecklistRevision).toBe(0);
    expect(map.plans![0]!.items[1]!.status).toBe("blocked");
  });
  it("never suppresses ordinary old mail using a mismatched ownership record", () => {
    const map = fixture();
    reservePlanEffects(map, lt(map), 20, AT);
    const ordinary = addMessage(
      map,
      { from: HUMAN, to: ["s-02"], text: "Human instruction" },
      AT,
    );
    const value = map.planEffects![0]!;
    value.status = "cancelled";
    value.messageId = ordinary.id;
    expect(cancelledPlanLetter(map, ordinary, lookupIn(map))).toBe(false);
    expect(unreadFor(map, "s-02")).toContainEqual(ordinary);
    expect(resumablePlanLetter(map, ordinary, "s-02", lookupIn(map))).toBe(false);
  });
  it("captures one actual mode occurrence with trusted sender and lead identity", () => {
    const map = fixture();
    setRoomMode(map, lt(map), "r-01", HUMAN, "checklist", "Human choice", {}, AT);
    const source = map.messages.at(-1)!;
    capturePlanNotice(map, lt(map), "r-01", "mode", source.id);
    reservePlanEffects(map, lt(map), 20, AT);
    const sent = map.planEffects!.find((row) => row.kind === "mode")!;
    expect(sent.target).toBe("s-01");
    expect(sent.occurrence).toBe(source.id);
    expect(sent.status).toBe("sent");
    expect(() =>
      capturePlanNotice(map, lt(map), "r-01", "mode", map.messages.at(-1)!.id),
    ).toThrow();
  });
  it("completion Return keeps a human feed occurrence and one rate-queued Parley lead letter", () => {
    const map = fixture();
    submitPlanItem(
      map,
      lt(map),
      "pl-01",
      0,
      1,
      "s-02",
      { text: "Measured", artifacts: [] },
      AT,
    );
    verifyPlanItem(map, lt(map), "pl-01", 0, 1, "s-03", "verified", "Checked", AT);
    const p = proposeCompletion(map, "r-01", "s-01", "pl-01", 0, "Done", AT);
    const source = resolveProposal(
      map,
      lt(map),
      "r-01",
      p.proposalId,
      "return",
      { rev: p.rev, planId: "pl-01", planRev: 0, note: "Add detail" },
      AT,
    );
    expect(map.messages.at(-1)!.to).toEqual([HUMAN]);
    capturePlanNotice(
      map,
      lt(map),
      "r-01",
      "completion-returned",
      source.messageId,
      "pl-01",
    );
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(1);
    expect(map.messages.at(-1)!.to).toEqual(["s-01"]);
    expect(map.messages.at(-1)!.text).toContain("Add detail");
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(1);
  });
  it("rejects malformed local delivery records and failed budget without mutating caller state", () => {
    const map = fixture();
    const before = JSON.stringify(map);
    expect(() => reservePlanEffects(map, lt(map), 0, AT)).toThrow();
    expect(JSON.stringify(map)).toBe(before);
    reservePlanEffects(map, lt(map), 20, AT);
    map.planEffects![0]!.key = "forged";
    expect(() => validatePlanEffects(map)).toThrow();
  });
});

describe("captured backlog completion retries", () => {
  async function prepared() {
    const { flushPlanBacklog } = await import("./plan-effects.js");
    const map = fixture("checklist");
    map.plans![0]!.backlog = ["b-001"];
    submitPlanItem(
      map,
      lt(map),
      "pl-01",
      0,
      1,
      "s-02",
      { text: "Measured", artifacts: [] },
      AT,
    );
    reservePlanEffects(map, lt(map), 20, AT);
    const document: BacklogDocument = {
      source: "",
      version: "v1",
      items: [
        {
          id: "b-001",
          title: "Original",
          details: "Human details",
          section: null,
          checked: false,
        },
      ],
    };
    let writes = 0;
    let failWrite = false;
    let lostAck = false;
    let failAck = false;
    let mapLocked = false;
    const io: PlanEffectsIO = {
      readMap: async () => structuredClone(map),
      readBacklog: async () => structuredClone(document),
      updateMap: async (_p: string, _w: string, body: (m: WorkMap) => void) => {
        mapLocked = true;
        try {
          const draft = structuredClone(map);
          body(draft);
          if (failAck && draft.planBacklogIntents![0]!.status === "written") {
            failAck = false;
            throw new Error("PRIVATE_ACK");
          }
          Object.assign(map, draft);
          return structuredClone(map);
        } finally {
          mapLocked = false;
        }
      },
      completeBacklogItem: async (
        _p: string,
        _id: string,
        done: string,
        options: { expectedVersion: string },
      ) => {
        expect(mapLocked).toBe(false);
        expect(options.expectedVersion).toBe(document.version);
        writes++;
        if (failWrite) {
          failWrite = false;
          throw new Error("PRIVATE_WRITE");
        }
        document.items[0]!.checked = true;
        document.items[0]!.done = done;
        document.version = "v2";
        if (lostAck) {
          lostAck = false;
          throw new Error("PRIVATE_REPLY");
        }
        return {
          id: "b-001",
          document: structuredClone(document),
          diagnostics: [],
        };
      },
    };
    return {
      map,
      get document() {
        return document;
      },
      get writes() {
        return writes;
      },
      set failWrite(v: boolean) {
        failWrite = v;
      },
      set lostAck(v: boolean) {
        lostAck = v;
      },
      set failAck(v: boolean) {
        failAck = v;
      },
      flush: () => flushPlanBacklog("/project", "w-0001", { io }),
    };
  }
  it("prepares durable version under map lock then writes outside it and acknowledges exactly once", async () => {
    const f = await prepared();
    expect((await f.flush()).written).toHaveLength(1);
    expect(f.writes).toBe(1);
    expect(f.document.items[0]!.done).toBe("2026-10-04");
    await f.flush();
    expect(f.writes).toBe(1);
    expect(f.map.planBacklogIntents![0]!.status).toBe("written");
  });
  it.each(["failWrite", "lostAck", "failAck"] as const)(
    "recovers %s without changing captured date or duplicating a committed write",
    async (failure) => {
      const f = await prepared();
      f[failure] = true;
      expect((await f.flush()).failed[0]!.code).toBe("backlog-unavailable");
      expect(f.map.planBacklogIntents![0]!.expectedVersion).toBe("v1");
      expect(f.map.planBacklogIntents![0]!.completedAt).toBe(AT);
      expect((await f.flush()).written).toHaveLength(1);
      expect(f.writes).toBe(failure === "failWrite" ? 2 : 1);
    },
  );
  it.each(["reopened", "edited", "removed"] as const)(
    "does not overwrite a human %s row after a lost reply",
    async (change) => {
      const f = await prepared();
      f.lostAck = true;
      await f.flush();
      if (change === "reopened") f.document.items[0]!.checked = false;
      if (change === "edited") f.document.items[0]!.title = "Human amendment";
      if (change === "removed") f.document.items = [];
      f.document.version = "human-v3";
      const before = JSON.stringify(f.document);
      expect((await f.flush()).failed[0]!.code).toBe("backlog-conflict");
      expect(JSON.stringify(f.document)).toBe(before);
      expect(f.writes).toBe(1);
      expect(f.map.planBacklogIntents![0]!.status).toBe("conflict");
    },
  );
  it("preserves a pre-existing human completion with another date as visible conflict", async () => {
    const f = await prepared();
    f.document.items[0]!.checked = true;
    f.document.items[0]!.done = "2026-10-03";
    expect((await f.flush()).failed[0]!.code).toBe("backlog-conflict");
    expect(f.writes).toBe(0);
    expect(f.document.items[0]!.done).toBe("2026-10-03");
  });
});

it("flushes a real temp Markdown file only after captured map completion, without repeat overwrite", async () => {
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createWork, updateMap, readMap } = await import("./store.js");
  const { addBacklogItem, readBacklog } = await import("./backlog.js");
  const { flushPlanBacklog } = await import("./plan-effects.js");
  const root = await mkdtemp("/private/tmp/parley-p23-real-");
  const previous = process.env.PARLEY_HOME;
  try {
    const project = path.join(root, "project");
    await mkdir(project);
    process.env.PARLEY_HOME = path.join(root, "home");
    const created = await createWork(project, { title: "Real completion" });
    const added = await addBacklogItem(project, {
      title: "Human row",
      details: "Preserve details",
    });
    await updateMap(project, created.work.id, (map, letters) => {
      addSession(
        map,
        { provider: "codex", label: "Lead", task: "Fixture" },
        AT,
      );
      addRoom(
        map,
        {
          creator: HUMAN,
          members: ["s-01"],
          title: "Plan",
          lead: "s-01",
          mode: "checklist",
        },
        AT,
      );
      const p = setProposal(map, "r-01", "s-01", "Decision", AT, {
        plan: {
          mode: "checklist",
          goal: "Done",
          items: [{ id: 1, title: "Implement", owner: "s-01", scope: "src" }],
          backlog: [added.id],
        },
      });
      resolveProposal(
        map,
        letters,
        "r-01",
        p.proposalId,
        "accept",
        { rev: p.rev, planId: "pl-01", planRev: 0 },
        AT,
      );
      submitPlanItem(
        map,
        letters,
        "pl-01",
        0,
        1,
        "s-01",
        { text: "Measured", artifacts: [] },
        AT,
      );
      reservePlanEffects(map, letters, 20, AT);
    });
    expect((await readBacklog(project)).items[0]!.checked).toBe(false);
    const concurrent = await Promise.all([
      flushPlanBacklog(project, created.work.id),
      flushPlanBacklog(project, created.work.id),
    ]);
    expect(
      concurrent.every(
        (row) => row.written.length === 1 && row.failed.length === 0,
      ),
    ).toBe(true);
    expect(
      (await readMap(project, created.work.id)).planBacklogIntents![0]!.status,
    ).toBe("written");
    const file = path.join(project, ".parley", "backlog.md");
    const source = await readFile(file, "utf8");
    await flushPlanBacklog(project, created.work.id);
    expect(await readFile(file, "utf8")).toBe(source);
    expect((await readBacklog(project)).items[0]).toMatchObject({
      checked: true,
      done: "2026-10-04",
      details: "Preserve details",
    });
  } finally {
    if (previous === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("a submitted item keeps its verification letter current when its owner closes, before persistence reconciliation", () => {
  const map = fixture();
  submitPlanItem(
    map,
    lt(map),
    map.plans![0]!.id,
    0,
    1,
    "s-02",
    { text: "Measured", artifacts: [] },
    AT,
  );
  reservePlanEffects(map, lt(map), 20, AT);
  const proof = map.planEffects!.find((row) => row.kind === "verify")!;
  const message = map.messages.find((row) => row.id === proof.messageId)!;
  expect(resumablePlanLetter(map, message, proof.target, lookupIn(map))).toBe(true);
  transitionSession(map, "s-02", "closed", { at: AT });
  expect(proof.status).toBe("sent");
  expect(resumablePlanLetter(map, message, proof.target, lookupIn(map))).toBe(true);
  expect(cancelledPlanLetter(map, message, lookupIn(map))).toBe(false);
  expect(
    unreadFor(map, proof.target).some((row) => row.id === message.id),
  ).toBe(true);
});
it("closed work never reserves or resumes a plan assignment, but retains captured export intents", () => {
  const map = fixture();
  reservePlanEffects(map, lt(map), 1, AT);
  map.work.status = "archived";
  const before = map.messages.length;
  const captured = JSON.stringify(map.planExports);
  const proof = map.planEffects!.find((row) => row.status === "sent")!;
  const message = map.messages.find((row) => row.id === proof.messageId)!;
  expect(resumablePlanLetter(map, message, proof.target, lookupIn(map))).toBe(false);
  reservePlanEffects(map, lt(map), 20, AT);
  expect(map.messages).toHaveLength(before);
  expect(JSON.stringify(map.planExports)).toBe(captured);
});

describe("effect texts live only in the letter once an effect is sent or cancelled", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  it("a sent effect keeps textSha256 of its letter, a queued one keeps its text; the letter stays owned and resumable", () => {
    const map = fixture("checklist", 3);
    reservePlanEffects(map, lt(map), 1, AT);
    const [sent, ...queued] = map.planEffects!;
    const letter = map.messages.find((row) => row.id === sent!.messageId)!;
    expect(sent!.status).toBe("sent");
    expect(sent).not.toHaveProperty("text");
    expect(sent!.textSha256).toBe(sha(letter.text));
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      expect(row.status).toBe("queued");
      expect(row.text).toContain("Accepted plan");
      expect(row).not.toHaveProperty("textSha256");
    }
    expect(resumablePlanLetter(map, letter, sent!.target, lookupIn(map))).toBe(true);
    expect(cancelledPlanLetter(map, letter, lookupIn(map))).toBe(false);
    expect(() => validatePlanEffects(map)).not.toThrow();
  });
  const expectSentByHash = (map: WorkMap, kind: "mode" | "completion-returned") => {
    // Второй расчёт сверяет уже отправленные эффекты по хэшу текста: ни один не отменяется.
    reservePlanEffects(map, lt(map), 20, AT);
    const sent = map.planEffects!.find((row) => row.kind === kind)!;
    const letter = map.messages.find((row) => row.id === sent.messageId)!;
    expect(sent.status).toBe("sent");
    expect(sent).not.toHaveProperty("text");
    expect(sent.textSha256).toBe(sha(letter.text));
    expect(resumablePlanLetter(map, letter, sent.target, lookupIn(map))).toBe(true);
  };
  it("a sent mode notice stays current by hash", () => {
    const map = fixture();
    setRoomMode(map, lt(map), "r-01", HUMAN, "checklist", "Human choice", {}, AT);
    capturePlanNotice(map, lt(map), "r-01", "mode", map.messages.at(-1)!.id);
    reservePlanEffects(map, lt(map), 20, AT);
    expectSentByHash(map, "mode");
  });
  it("a sent completion-return notice stays current by hash", () => {
    const map = fixture();
    submitPlanItem(
      map,
      lt(map),
      "pl-01",
      0,
      1,
      "s-02",
      { text: "Measured", artifacts: [] },
      AT,
    );
    verifyPlanItem(map, lt(map), "pl-01", 0, 1, "s-03", "verified", "Checked", AT);
    const p = proposeCompletion(map, "r-01", "s-01", "pl-01", 0, "Done", AT);
    const source = resolveProposal(
      map,
      lt(map),
      "r-01",
      p.proposalId,
      "return",
      { rev: p.rev, planId: "pl-01", planRev: 0, note: "Add detail" },
      AT,
    );
    capturePlanNotice(map, lt(map), "r-01", "completion-returned", source.messageId, "pl-01");
    reservePlanEffects(map, lt(map), 20, AT);
    expectSentByHash(map, "completion-returned");
  });
  it("a cancelled effect still hides its sent letter when only the hash is left", () => {
    const map = fixture();
    reservePlanEffects(map, lt(map), 20, AT);
    const sent = map.planEffects!.find((row) => row.status === "sent")!;
    const letter = map.messages.find((row) => row.id === sent.messageId)!;
    transitionSession(map, sent.target, "closed", { at: AT });
    reservePlanEffects(map, lt(map), 20, AT);
    // Расчёт ведётся на копии: запись эффекта после него — другой объект.
    const proof = map.planEffects!.find((row) => row.key === sent.key)!;
    expect(proof.status).toBe("cancelled");
    expect(proof).not.toHaveProperty("text");
    expect(proof.textSha256).toBe(sha(letter.text));
    expect(cancelledPlanLetter(map, letter, lookupIn(map))).toBe(true);
    expect(unreadFor(map, proof.target).some((row) => row.id === letter.id)).toBe(false);
    // Письмо с чужим текстом тем же номером эффекту не принадлежит.
    expect(cancelledPlanLetter(map, { ...letter, text: `${letter.text}!` }, lookupIn(map))).toBe(false);
  });
  it("an effect cancelled before it was sent drops its text and keeps the hash", () => {
    const map = fixture("checklist", 3);
    reservePlanEffects(map, lt(map), 1, AT);
    const texts = map.planEffects!.map((row) => row.text);
    archiveRoom(map, lt(map), "r-01", AT);
    expect(map.planEffects!.map((row) => row.status)).toEqual(["sent", "cancelled", "cancelled"]);
    for (const [index, row] of map.planEffects!.entries()) {
      if (index === 0) continue;
      expect(row).not.toHaveProperty("text");
      expect(row.textSha256).toBe(sha(texts[index]!));
    }
    expect(() => validatePlanEffects(map)).not.toThrow();
  });
  it("a sent effect with neither text nor hash is not valid storage", () => {
    const map = fixture();
    reservePlanEffects(map, lt(map), 20, AT);
    delete map.planEffects![0]!.textSha256;
    expect(() => validatePlanEffects(map)).toThrow("invalid plan effect");
  });
});

describe("cancelled effects come back to life and old rows are pruned", () => {
  const T2 = "2026-10-04T02:00:00.000Z";
  const KEEP = 7 * 24 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse(AT);
  const iso = (age: number) => new Date(NOW - age).toISOString();
  const parleyLetters = (map: WorkMap) => map.messages.filter((row) => row.from === PARLEY);
  /** Эффект отменён тем, что работа ушла в архив; затем работа открыта снова. */
  function archiveAndReopen(map: WorkMap) {
    map.work.status = "archived";
    reservePlanEffects(map, lt(map), 20, AT);
    map.work.status = "active";
  }
  it("an assignment cancelled while the workspace was archived is sent again after reopening", () => {
    const map = fixture("checklist");
    reservePlanEffects(map, lt(map), 20, AT);
    const oldLetter = parleyLetters(map)[0]!;
    archiveAndReopen(map);
    expect(map.planEffects![0]!.status).toBe("cancelled");
    reservePlanEffects(map, lt(map), 20, T2);
    // Одна строка эффекта, два письма: оживший эффект пишет новое письмо, старое не трогает.
    expect(map.planEffects).toHaveLength(1);
    const row = map.planEffects![0]!;
    expect(row.status).toBe("sent");
    expect(row.createdAt).toBe(T2);
    const letters = parleyLetters(map);
    expect(letters).toHaveLength(2);
    expect(row.messageId).toBe(letters[1]!.id);
    expect(row.messageId).not.toBe(oldLetter.id);
    expect(letters[1]!.text).toBe(oldLetter.text);
    expect(resumablePlanLetter(map, oldLetter, "s-02", lookupIn(map))).toBe(false);
    expect(resumablePlanLetter(map, letters[1]!, "s-02", lookupIn(map))).toBe(true);
    // Повторный проход без изменений не даёт ни эффектов, ни писем.
    expect(reservePlanEffects(map, lt(map), 20, T2).changed).toBe(false);
    expect(map.planEffects).toHaveLength(1);
    expect(parleyLetters(map)).toHaveLength(2);
  });
  it("a cancelled effect is revived only with the same text", () => {
    const map = fixture("checklist");
    reservePlanEffects(map, lt(map), 20, AT);
    archiveAndReopen(map);
    // Формат письма сменился обновлением: хэш отменённого эффекта не совпадает с текстом текущего.
    map.planEffects![0]!.textSha256 = createHash("sha256").update("an older format").digest("hex");
    reservePlanEffects(map, lt(map), 20, T2);
    expect(map.planEffects).toHaveLength(1);
    expect(map.planEffects![0]!.status).toBe("cancelled");
    expect(parleyLetters(map)).toHaveLength(1);
  });
  it("a mode notice stays cancelled after the workspace is archived and reopened", () => {
    const map = fixture();
    setRoomMode(map, lt(map), "r-01", HUMAN, "checklist", "Human choice", {}, AT);
    capturePlanNotice(map, lt(map), "r-01", "mode", map.messages.at(-1)!.id);
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.planEffects!.find((row) => row.kind === "mode")!.status).toBe("sent");
    archiveAndReopen(map);
    reservePlanEffects(map, lt(map), 20, T2);
    expect(map.planEffects!.find((row) => row.kind === "mode")!.status).toBe("cancelled");
    expect(parleyLetters(map).filter((row) => row.text.startsWith("Room mode changed."))).toHaveLength(1);
  });
  /** Отменённая строка нужного возраста: копия настоящего эффекта с другим ключом, текст свёрнут в хэш. */
  const cancelledRow = (source: PlanEffect, name: string, age: number): PlanEffect => {
    return {
      ...source,
      key: `${source.key}/${name}`,
      status: "cancelled",
      messageId: null,
      createdAt: iso(age),
      textSha256: "0".repeat(64),
    };
  };
  it("prunes cancelled effects older than seven days and leaves queued and sent ones alone", () => {
    const map = fixture("checklist", 2);
    reservePlanEffects(map, lt(map), 1, AT);
    expect(map.planEffects!.map((row) => row.status)).toEqual(["sent", "queued"]);
    const source = map.planEffects![0]!;
    for (const [name, age] of [["age-0", 0], ["age-keep", KEEP], ["age-keep-1", KEEP + 1], ["age-30d", 30 * DAY]] as const)
      map.planEffects!.push(cancelledRow(source, name, age));
    reservePlanEffects(map, lt(map), 1, AT);
    expect(map.planEffects!.map((row) => row.status)).toEqual(["sent", "queued", "cancelled", "cancelled"]);
    expect(map.planEffects!.slice(2).map((row) => row.key.split("/").at(-1))).toEqual(["age-0", "age-keep"]);
  });
  /** Закончившийся план: единственный план фикстуры завершён `age` назад; строки бэклога и экспортов разных статусов. */
  function endedPlan(age: number): WorkMap {
    const map = fixture("checklist");
    const plan = map.plans![0]!;
    plan.status = "completed";
    plan.completedAt = iso(age);
    plan.backlog = ["b-001"];
    const intent = (backlogId: string, status: "pending" | "written" | "conflict") => ({
      key: `${plan.id}/${plan.rev}/${backlogId}/${plan.completedAt}`,
      planId: plan.id,
      rev: plan.rev,
      backlogId,
      completedAt: plan.completedAt!,
      status,
    });
    map.planBacklogIntents = [intent("b-001", "written"), intent("b-002", "pending"), intent("b-003", "conflict")];
    const file = (event: "accepted" | "completed") => `w-0001-r-01-${plan.id}-rev-0-${event}.md`;
    map.planExports = [
      { file: file("accepted"), planId: plan.id, rev: plan.rev, event: "accepted", status: "written" },
      { file: file("completed"), planId: plan.id, rev: plan.rev, event: "completed", status: "pending" },
    ];
    return map;
  }
  it.each([
    [0, true],
    [KEEP, true],
    [KEEP + 1, false],
    [30 * DAY, false],
  ])("written rows of a plan that ended %d ms ago: kept = %s, pending and conflict rows always kept", (age, kept) => {
    const map = endedPlan(age);
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.planBacklogIntents!.map((row) => row.status)).toEqual(
      kept ? ["written", "pending", "conflict"] : ["pending", "conflict"],
    );
    expect(map.planExports!.map((row) => row.status)).toEqual(kept ? ["written", "pending"] : ["pending"]);
  });
  it("rows of a plan with neither date stay", () => {
    const map = endedPlan(30 * DAY);
    map.plans![0]!.completedAt = null;
    map.plans![0]!.status = "active";
    reservePlanEffects(map, lt(map), 20, AT);
    expect(map.planBacklogIntents!.map((row) => row.status)).toEqual(["written", "pending", "conflict"]);
    expect(map.planExports!.map((row) => row.status)).toEqual(["written", "pending"]);
  });
  it("at the limit cancelled rows of any age go before the error", () => {
    const map = fixture("checklist");
    reservePlanEffects(map, lt(map), 20, AT);
    const source = map.planEffects![0]!;
    for (let i = 0; i < 30_001; i++) map.planEffects!.push(cancelledRow(source, `n-${i}`, 0));
    expect(() => reservePlanEffects(map, lt(map), 20, AT)).not.toThrow();
    expect(map.planEffects!.map((row) => row.status)).toEqual(["sent"]);
  });
  it("the limit error says what to do", () => {
    const map = fixture("checklist");
    reservePlanEffects(map, lt(map), 20, AT);
    const source = map.planEffects![0]!;
    for (let i = 0; i < 30_001; i++) map.planEffects!.push({ ...source, key: `${source.key}/n-${i}` });
    expect(() => reservePlanEffects(map, lt(map), 20, AT)).toThrow(/complete or cancel plans/);
    expect(map.planEffects).toHaveLength(30_002);
  });
});
