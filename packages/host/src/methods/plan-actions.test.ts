import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createWork,
  updateMap,
  readMap,
  addSession,
  addRoom,
  HUMAN,
  setProposal,
  resolveProposal,
  submitPlanItem,
  verifyPlanItem,
  proposeCompletion,
  summarizePlanEffects,
  PARLEY,
} from "@parley/core";
import type { RequestInfo } from "../context.js";
import { createPlanHandlers } from "./rooms.js";
import { resolveRoomProposal } from "../rooms/rooms-service.js";
let root: string;
let project: string;
let workId: string;
let previous: string | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp("/private/tmp/parley-human-plan-"));
  project = path.join(root, "project");
  await mkdir(project);
  await mkdir(path.join(root, "home"));
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, "home");
  workId = (await createWork(project, { title: "Plan" })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ["Lead", "Owner", "Verifier"])
      addSession(map, { provider: "codex", label, task: "Fixture" });
    addRoom(map, {
      creator: HUMAN,
      members: ["s-01", "s-02", "s-03"],
      title: "Plan",
      lead: "s-01",
      mode: "verified",
    });
  });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
async function accept() {
  await updateMap(project, workId, (map) => {
    const p = setProposal(map, "r-01", "s-01", "Decision", undefined, {
      plan: {
        mode: "verified",
        goal: "Done",
        items: [
          {
            id: 1,
            title: "Work",
            owner: "s-02",
            scope: "src",
            criteria: ["Measured"],
            verifier: "s-03",
          },
        ],
      },
    });
    resolveProposal(map, "r-01", p.proposalId, "accept", {
      rev: p.rev,
      planId: "pl-01",
      planRev: 0,
    });
  });
}
const request = {} as RequestInfo;
function handlers(fail = false) {
  const flush = vi.fn(async () => {
    if (fail) throw new Error("PRIVATE IO");
    return summarizePlanEffects(await readMap(project, workId));
  });
  return { flush, all: createPlanHandlers({ start() {}, stop() {}, flush }) };
}
describe("host-owned human plan actions", () => {
  it("submits as human, preserves exact revision and retries captured effects without another mutation", async () => {
    await accept();
    const h = handlers();
    const result = await h.all["plans.submit"](
      {
        projectPath: project,
        workId,
        planId: "pl-01",
        rev: 0,
        item: 1,
        evidence: { text: "Human evidence", artifacts: [] },
      },
      request,
    );
    expect(result.effects.pendingSnapshots).toBe(1);
    const map = await readMap(project, workId);
    expect(map.plans![0]!.items[0]!.log.at(-1)!.by).toBe(HUMAN);
    const before = JSON.stringify(map);
    await h.all["plans.retryEffects"](
      { projectPath: project, workId },
      request,
    );
    expect(JSON.stringify(await readMap(project, workId))).toBe(before);
    await expect(
      h.all["plans.verify"](
        {
          projectPath: project,
          workId,
          planId: "pl-01",
          rev: 1,
          item: 1,
          verdict: "verified",
          note: "Pass",
        },
        request,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("returns committed pending counts on flush failure without raw errors or second submission", async () => {
    await accept();
    const h = handlers(true);
    const result = await h.all["plans.submit"](
      {
        projectPath: project,
        workId,
        planId: "pl-01",
        rev: 0,
        item: 1,
        evidence: { text: "Saved", artifacts: [] },
      },
      request,
    );
    expect(result.effects.pendingSnapshots).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect((await readMap(project, workId)).plans![0]!.items[0]!.status).toBe(
      "done",
    );
  });
  it("captures a trusted mode source then one Parley lead notice, with a no-op when unchanged", async () => {
    const h = handlers();
    const result = await h.all["rooms.setMode"](
      {
        projectPath: project,
        workId,
        roomId: "r-01",
        mode: "checklist",
        reason: "Human choice",
      },
      request,
    );
    expect(result.messageId).not.toBeNull();
    const map = await readMap(project, workId);
    expect(map.planEffects!.filter((row) => row.kind === "mode")).toHaveLength(
      1,
    );
    expect(map.messages.filter((row) => row.from === PARLEY)).toHaveLength(1);
    const before = JSON.stringify(map);
    await h.all["rooms.setMode"](
      {
        projectPath: project,
        workId,
        roomId: "r-01",
        mode: "checklist",
        reason: "Same",
      },
      request,
    );
    expect(JSON.stringify(await readMap(project, workId))).toBe(before);
  });
  it("completion Return keeps a human room-feed source and one proof-bound Parley lead letter", async () => {
    await accept();
    await updateMap(project, workId, (map) => {
      submitPlanItem(map, "pl-01", 0, 1, "s-02", {
        text: "Measured",
        artifacts: [],
      });
      verifyPlanItem(map, "pl-01", 0, 1, "s-03", "verified", "Independent");
      proposeCompletion(map, "r-01", "s-01", "pl-01", 0, "Summary");
    });
    const before = await readMap(project, workId);
    const p = before.rooms[0]!.proposal!;
    const id = await resolveRoomProposal({
      projectPath: project,
      workId,
      roomId: "r-01",
      proposalId: p.id,
      rev: p.rev,
      planId: "pl-01",
      planRev: 0,
      action: "return",
      note: "Revise summary",
    });
    const map = await readMap(project, workId);
    expect(map.messages.find((row) => row.id === id)!.to).toEqual([HUMAN]);
    expect(
      map.planEffects!.filter((row) => row.kind === "completion-returned"),
    ).toHaveLength(1);
    const letter = map.messages.find(
      (row) =>
        row.id ===
        map.planEffects!.find((row) => row.kind === "completion-returned")!
          .messageId,
    )!;
    expect(letter.from).toBe(PARLEY);
    expect(letter.to).toEqual(["s-01"]);
  });
});
