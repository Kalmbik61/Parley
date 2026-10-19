import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createParleyServer } from "./tools.js";
import { addSession, transitionSession } from "../work/map.js";
import { addRoom, archiveRoom } from "../work/rooms.js";
import { createWork, updateMap, readMap, workPaths } from "../work/store.js";
import { resolveProposal } from "../work/proposals.js";
import { HUMAN } from "../work/types.js";
import type { McpContext } from "./context.js";
let root: string;
let project: string;
let previous: string | undefined;
let context: McpContext;
const clients: Client[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp("/private/tmp/parley-plan-tools-"));
  project = path.join(root, "project");
  await mkdir(project);
  await mkdir(path.join(root, "home"));
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, "home");
  const map = await createWork(project, { title: "Plan tools" });
  await updateMap(project, map.work.id, (current) => {
    for (const label of ["Lead", "Owner", "Verifier"])
      addSession(current, {
        provider: "codex",
        label,
        task: "Bounded fixture",
      });
    addRoom(current, {
      title: "Plan",
      creator: HUMAN,
      members: ["s-01", "s-02", "s-03"],
      lead: "s-01",
      mode: "verified",
    });
  });
  context = {
    projectPath: project,
    workId: map.work.id,
    workDir: workPaths(project, map.work.id).dir,
    sessionId: "s-01",
    channel: false,
  };
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
async function connect(sessionId: string | null) {
  const server = createParleyServer({ ...context, sessionId });
  const client = new Client({ name: "fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}
async function call(
  sessionId: string | null,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await (
    await connect(sessionId)
  ).callTool({ name, arguments: args });
  return {
    failed: result.isError === true,
    text: (result.content as { text: string }[])[0]!.text,
  };
}
const draft = {
  mode: "verified",
  goal: "Bounded work",
  items: [
    {
      id: 1,
      title: "Implement",
      owner: "s-02",
      scope: "src/a.ts",
      criteria: ["Independent proof"],
      verifier: "s-03",
    },
  ],
};
async function accepted() {
  const result = await call("s-01", "propose_decision", {
    room: "r-01",
    text: "Human decision",
    plan: draft,
  });
  expect(result.failed).toBe(false);
  await updateMap(project, context.workId, (map) => {
    const p = map.rooms[0]!.proposal!;
    resolveProposal(map, "r-01", p.id, "accept", {
      rev: p.rev,
      planId: p.plan!.id,
      planRev: p.plan!.rev,
    });
  });
}
describe("trusted plan tool integration", () => {
  it("registers all mutations as writes with no actor/location input", async () => {
    const result = await (await connect("s-01")).listTools();
    for (const name of [
      "set_room_mode",
      "plan_update",
      "plan_submit",
      "plan_verify",
      "plan_progress",
      "propose_completion",
    ]) {
      const tool = result.tools.find((row) => row.name === name)!;
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("actor");
    }
  });
  it("accepts only the live lead plan, owner evidence and independent verifier at the exact revision", async () => {
    await accepted();
    const base = { planId: "pl-01", rev: 0, item: 1 };
    expect(
      (
        await call("s-02", "plan_submit", {
          ...base,
          evidence: { text: "Measured", artifacts: ["src/a.ts"] },
        })
      ).failed,
    ).toBe(false);
    expect(
      (
        await call("s-02", "plan_verify", {
          ...base,
          verdict: "verified",
          note: "Self proof",
        })
      ).failed,
    ).toBe(true);
    expect(
      (
        await call("s-03", "plan_verify", {
          ...base,
          verdict: "verified",
          note: "Independent pass",
        })
      ).failed,
    ).toBe(false);
    expect(
      (
        await call("s-01", "propose_completion", {
          planId: "pl-01",
          rev: 0,
          summary: "All verified",
        })
      ).failed,
    ).toBe(false);
    expect(
      (await readMap(project, context.workId)).rooms[0]!.proposal!.kind,
    ).toBe("completion");
  });
  it("rejects spoofed context, missing caller, stale revision and forged persisted waiver without writing", async () => {
    await accepted();
    const before = JSON.stringify(await readMap(project, context.workId));
    for (const [actor, args] of [
      [null, { planId: "pl-01", rev: 0, item: 1, status: "in_progress" }],
      ["s-02", { planId: "pl-01", rev: 1, item: 1, status: "in_progress" }],
      [
        "s-02",
        {
          planId: "pl-01",
          rev: 0,
          item: 1,
          status: "in_progress",
          actor: "s-01",
        },
      ],
      [
        "s-02",
        {
          planId: "pl-01",
          rev: 0,
          item: 1,
          status: "in_progress",
          projectPath: "/foreign",
        },
      ],
    ] as const)
      expect((await call(actor, "plan_update", args)).failed).toBe(true);
    expect(
      (
        await call("s-01", "propose_decision", {
          room: "r-01",
          text: "Amend",
          plan: {
            ...draft,
            id: "pl-01",
            rev: 0,
            items: [{ ...draft.items[0], acceptedChecklistRevision: 0 }],
          },
        })
      ).failed,
    ).toBe(true);
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("refuses a closed owner and preserves legacy Free decision calls", async () => {
    await accepted();
    await updateMap(project, context.workId, (map) =>
      transitionSession(map, "s-02", "closed"),
    );
    expect(
      (
        await call("s-02", "plan_submit", {
          planId: "pl-01",
          rev: 0,
          item: 1,
          evidence: { text: "No", artifacts: [] },
        })
      ).failed,
    ).toBe(true);
    await updateMap(project, context.workId, (map) => {
      addRoom(map, {
        title: "Free",
        creator: HUMAN,
        members: ["s-01"],
        lead: "s-01",
      });
    });
    expect(
      (
        await call("s-01", "propose_decision", {
          room: "r-02",
          text: "Legacy unchanged",
        })
      ).failed,
    ).toBe(false);
  });
});

it("only a live lead raises mode and a participant cannot lower or spoof it", async () => {
  await updateMap(project, context.workId, (map) => {
    map.rooms[0]!.mode = "free";
  });
  expect(
    (
      await call("s-02", "set_room_mode", {
        room: "r-01",
        mode: "checklist",
        reason: "Need a plan",
      })
    ).failed,
  ).toBe(true);
  expect(
    (
      await call("s-01", "set_room_mode", {
        room: "r-01",
        mode: "checklist",
        reason: "Need a plan",
      })
    ).failed,
  ).toBe(false);
  const before = JSON.stringify(await readMap(project, context.workId));
  expect(
    (
      await call("s-01", "set_room_mode", {
        room: "r-01",
        mode: "free",
        reason: "Lower",
      })
    ).failed,
  ).toBe(true);
  expect(
    (
      await call("s-01", "set_room_mode", {
        room: "r-01",
        mode: "verified",
        reason: "Raise",
        actor: "human",
      })
    ).failed,
  ).toBe(true);
  expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
});

it("a still-live verifier cannot complete an unsatisfied item whose owner closed before the host reconcile event", async () => {
  await accepted();
  const identity = { planId: "pl-01", rev: 0, item: 1 };
  expect(
    (
      await call("s-02", "plan_submit", {
        ...identity,
        evidence: { text: "Measured", artifacts: [] },
      })
    ).failed,
  ).toBe(false);
  await updateMap(project, context.workId, (map) =>
    transitionSession(map, "s-02", "closed"),
  );
  const before = JSON.stringify(await readMap(project, context.workId));
  expect(
    (
      await call("s-03", "plan_verify", {
        ...identity,
        verdict: "verified",
        note: "Too late",
      })
    ).failed,
  ).toBe(true);
  expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
});

it("legacy Free decision preserves character limits for 6000 and 10000 Cyrillic characters and its exact reply shape", async () => {
  await updateMap(project, context.workId, (map) => {
    map.rooms[0]!.mode = "free";
  });
  for (const [index, length] of [6000, 10000].entries()) {
    const result = await call("s-01", "propose_decision", {
      room: "r-01",
      text: "я".repeat(length),
    });
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ proposalId: "p-01", rev: index });
  }
  const before = JSON.stringify(await readMap(project, context.workId));
  expect(
    (await call("s-01", "propose_decision", {
      room: "r-01",
      text: "я".repeat(10001),
    })).failed,
  ).toBe(true);
  expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
});

it("evidence uses the same 10000-character aggregate and 1024-character artifact limits as the domain", async () => {
  await accepted();
  const identity = { planId: "pl-01", rev: 0, item: 1 };
  const before = JSON.stringify(await readMap(project, context.workId));
  for (const evidence of [
    { text: "я".repeat(8977), artifacts: ["ф".repeat(1024)] },
    { text: "Valid", artifacts: ["ф".repeat(1025)] },
    { text: "\uD800", artifacts: [] },
    { text: "Valid", artifacts: ["bad\0path"] },
  ]) {
    expect(
      (await call("s-02", "plan_submit", { ...identity, evidence })).failed,
    ).toBe(true);
  }
  expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  const result = await call("s-02", "plan_submit", {
    ...identity,
    evidence: { text: "я".repeat(8976), artifacts: ["ф".repeat(1024)] },
  });
  expect(result.failed).toBe(false);
  expect((await readMap(project, context.workId)).plans![0]!.items[0]!.status).toBe("done");
});

it("multilingual near-limit notes remain valid while the independent 64 KiB JSON envelope remains bounded", async () => {
  await accepted();
  const identity = { planId: "pl-01", rev: 0, item: 1, status: "blocked" };
  const before = JSON.stringify(await readMap(project, context.workId));
  const tooLarge = await call("s-02", "plan_update", {
    ...identity,
    note: "я".repeat(40000),
  });
  expect(tooLarge.failed).toBe(true);
  expect(tooLarge.text).toContain("plan arguments are too large");
  expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  expect(
    (await call("s-02", "plan_update", {
      ...identity,
      note: "я".repeat(10000),
    })).failed,
  ).toBe(false);
});

describe("archived room", () => {
  const REFUSAL = "room r-01 is archived: only the human can reopen it";
  it("refuses every plan tool with the archive reason, not a stale-revision error, and writes nothing", async () => {
    await accepted();
    await updateMap(project, context.workId, (map) => {
      archiveRoom(map, "r-01", "2026-10-08T12:00:00.000Z");
    });
    const before = JSON.stringify(await readMap(project, context.workId));
    const cases: [string, string, Record<string, unknown>][] = [
      ["s-01", "propose_decision", { room: "r-01", text: "Amend", plan: draft }],
      ["s-01", "set_room_mode", { room: "r-01", mode: "verified", reason: "No change" }],
      ["s-02", "plan_update", { planId: "pl-01", rev: 0, item: 1, status: "in_progress" }],
      ["s-02", "plan_submit", { planId: "pl-01", rev: 0, item: 1, evidence: { text: "Done", artifacts: [] } }],
      ["s-03", "plan_verify", { planId: "pl-01", rev: 0, item: 1, verdict: "verified", note: "Fine" }],
      ["s-02", "plan_progress", { planId: "pl-01", rev: 0, item: 1, done: "Half", next: "Rest" }],
      ["s-01", "propose_completion", { planId: "pl-01", rev: 0, summary: "All done" }],
    ];
    for (const [actor, name, args] of cases) {
      const result = await call(actor, name, args);
      expect(result.failed, name).toBe(true);
      expect(result.text, name).toBe(REFUSAL);
    }
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
});

describe("plan_progress", () => {
  const base = { planId: "pl-01", rev: 0, item: 1 };
  const position = { done: "Parser done", next: "Wire the tests" };
  /** Всё, что чекпоинт не вправе менять: письма, эффекты, статусы, журнал пункта. */
  async function untouched() {
    const map = await readMap(project, context.workId);
    const plan = map.plans![0]!;
    return {
      effects: JSON.stringify(map.planEffects ?? []),
      messages: map.messages.length,
      statuses: plan.items.map((row) => row.status),
      log: JSON.stringify(plan.items.map((row) => row.log)),
      evidence: JSON.stringify(plan.items.map((row) => row.evidence)),
      note: JSON.stringify(plan.items.map((row) => row.note)),
    };
  }
  async function started() {
    await accepted();
    expect(
      (await call("s-02", "plan_update", { ...base, status: "in_progress" }))
        .failed,
    ).toBe(false);
  }
  async function submitted() {
    await started();
    expect(
      (
        await call("s-02", "plan_submit", {
          ...base,
          evidence: { text: "Measured", artifacts: ["src/a.ts"] },
        })
      ).failed,
    ).toBe(false);
  }

  it("is registered as a write with the exact input schema and the agreed description", async () => {
    const tool = (await (await connect("s-02")).listTools()).tools.find(
      (row) => row.name === "plan_progress",
    )!;
    expect(tool.description).toBe(
      "Save your current position on an accepted plan item you own (after plan_update in_progress) or verify (after the owner submitted). Overwrites your previous checkpoint; does not change status, send messages or verify anything. Call it before ending a turn without plan_submit or plan_verify.",
    );
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual([
      "artifacts",
      "blocker",
      "done",
      "item",
      "next",
      "planId",
      "rev",
    ]);
    expect(tool.inputSchema.required).toEqual([
      "planId",
      "rev",
      "item",
      "done",
      "next",
    ]);
  });

  it("the owner saves a position after starting, and nothing else changes", async () => {
    await started();
    const before = await untouched();
    const result = await call("s-02", "plan_progress", {
      ...base,
      ...position,
      artifacts: ["src/a.ts"],
      blocker: "Waiting for a fixture",
    });
    expect(result.failed).toBe(false);
    const body = JSON.parse(result.text);
    const saved = (await readMap(project, context.workId)).plans![0]!.items[0]!
      .progress!.owner!;
    expect(body.saved).toEqual({
      role: "owner",
      submission: null,
      at: saved.at,
    });
    expect(saved).toMatchObject({
      by: "s-02",
      ...position,
      artifacts: ["src/a.ts"],
      blocker: "Waiting for a fixture",
    });
    expect(body.next).toEqual({
      total: 1,
      assignments: [
        {
          planId: "pl-01",
          rev: 0,
          item: 1,
          role: "owner",
          action: "continue",
          title: "Implement",
        },
      ],
    });
    expect(body.effects).toBeDefined();
    expect(await untouched()).toEqual(before);
  });

  it("the verifier saves a position on a submitted item without verifying it, sending a letter or creating an effect", async () => {
    await submitted();
    const before = await untouched();
    const result = await call("s-03", "plan_progress", {
      ...base,
      done: "Read the diff",
      next: "Run the suite",
    });
    expect(result.failed).toBe(false);
    const body = JSON.parse(result.text);
    const map = await readMap(project, context.workId);
    const item = map.plans![0]!.items[0]!;
    expect(body.saved).toEqual({
      role: "verifier",
      submission: item.log.length,
      at: item.progress!.verifier!.at,
    });
    expect(body.next.assignments).toEqual([
      {
        planId: "pl-01",
        rev: 0,
        item: 1,
        role: "verifier",
        action: "verify",
        title: "Implement",
      },
    ]);
    expect(await untouched()).toEqual(before);
    expect(item.status).toBe("done");
    expect(
      map.plans![0]!.items.filter((row) => row.status === "verified"),
    ).toEqual([]);
  });

  it("passes the domain rule text through for a wrong status or a wrong role", async () => {
    await accepted();
    const early = await call("s-02", "plan_progress", {
      ...base,
      ...position,
    });
    expect(early.failed).toBe(true);
    expect(early.text).toBe("start the item with plan_update(in_progress) first");
    const premature = await call("s-03", "plan_progress", {
      ...base,
      ...position,
    });
    expect(premature.failed).toBe(true);
    expect(premature.text).toBe(
      "the owner has not submitted the item for review",
    );
    const stranger = await call("s-01", "plan_progress", {
      ...base,
      ...position,
    });
    expect(stranger.failed).toBe(true);
    expect(stranger.text).toBe(
      "only the item owner or its independent verifier can save a checkpoint",
    );
  });

  it("a stale revision gets the plan_tasks hint, and nothing is written", async () => {
    await started();
    const before = JSON.stringify(await readMap(project, context.workId));
    const result = await call("s-02", "plan_progress", {
      ...base,
      rev: 1,
      ...position,
    });
    expect(result.failed).toBe(true);
    expect(result.text).toBe(
      "Plan revision or item changed; call plan_tasks for the current revision.",
    );
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });

  it("rejects spoofed fields, a missing session and out-of-range text without writing", async () => {
    await started();
    const before = JSON.stringify(await readMap(project, context.workId));
    const long = (length: number) => "x".repeat(length);
    for (const [actor, args] of [
      ["s-02", { ...base, ...position, actor: "s-03" }],
      ["s-02", { ...base, ...position, projectPath: "/foreign" }],
      [null, { ...base, ...position }],
      ["s-02", { ...base, next: "No done" }],
      ["s-02", { ...base, done: "No next" }],
      ["s-02", { ...base, done: long(601), next: "ok" }],
      ["s-02", { ...base, done: "ok", next: long(301) }],
      ["s-02", { ...base, ...position, blocker: long(301) }],
      ["s-02", { ...base, ...position, artifacts: Array(6).fill("a") }],
      ["s-02", { ...base, ...position, artifacts: [long(257)] }],
      ["s-02", { ...base, ...position, artifacts: [7] }],
      ["s-02", { ...base, done: 5, next: "ok" }],
      ["s-02", { ...base, item: 0, ...position }],
      ["s-02", { ...base, planId: "x", ...position }],
    ] as const)
      expect(
        (await call(actor, "plan_progress", args as Record<string, unknown>))
          .failed,
        JSON.stringify(args),
      ).toBe(true);
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });

  it("overwrites the previous position and accepts the documented limits", async () => {
    await started();
    const long = (length: number) => "x".repeat(length);
    expect(
      (await call("s-02", "plan_progress", { ...base, ...position })).failed,
    ).toBe(false);
    const result = await call("s-02", "plan_progress", {
      ...base,
      done: long(600),
      next: long(300),
      blocker: long(300),
      artifacts: Array(5).fill(long(256)),
    });
    expect(result.failed).toBe(false);
    const owner = (await readMap(project, context.workId)).plans![0]!.items[0]!
      .progress!.owner!;
    expect(owner.done).toHaveLength(600);
    expect(owner.artifacts).toHaveLength(5);
  });
});

describe("next actions after a mutation", () => {
  const base = { planId: "pl-01", rev: 0, item: 1 };
  const entry = (role: string, action: string) => ({
    planId: "pl-01",
    rev: 0,
    item: 1,
    role,
    action,
    title: "Implement",
  });

  it("plan_update, plan_submit and plan_verify answer with the caller's next actions after the change", async () => {
    await accepted();
    const started = JSON.parse(
      (await call("s-02", "plan_update", { ...base, status: "in_progress" }))
        .text,
    );
    expect(started.next).toEqual({
      total: 1,
      assignments: [entry("owner", "continue")],
    });
    expect(started.effects).toBeDefined();

    const submitted = JSON.parse(
      (
        await call("s-02", "plan_submit", {
          ...base,
          evidence: { text: "Measured", artifacts: [] },
        })
      ).text,
    );
    expect(submitted.next).toEqual({
      total: 1,
      assignments: [entry("owner", "wait")],
    });

    const returned = JSON.parse(
      (
        await call("s-03", "plan_verify", {
          ...base,
          verdict: "returned",
          note: "Needs a regression test",
        })
      ).text,
    );
    expect(returned.next).toEqual({
      total: 1,
      assignments: [entry("verifier", "wait")],
    });

    const again = JSON.parse(
      (await call("s-02", "plan_update", { ...base, status: "in_progress" }))
        .text,
    );
    expect(again.next.assignments).toEqual([entry("owner", "continue")]);
    await call("s-02", "plan_submit", {
      ...base,
      evidence: { text: "Fixed", artifacts: [] },
    });
    const verified = JSON.parse(
      (
        await call("s-03", "plan_verify", {
          ...base,
          verdict: "verified",
          note: "Looks right",
        })
      ).text,
    );
    expect(verified.next).toEqual({ total: 0, assignments: [] });
  });

  it("propose_completion keeps its old output", async () => {
    await accepted();
    await call("s-02", "plan_submit", {
      ...base,
      evidence: { text: "Measured", artifacts: [] },
    });
    await call("s-03", "plan_verify", {
      ...base,
      verdict: "verified",
      note: "Fine",
    });
    const completion = JSON.parse(
      (
        await call("s-01", "propose_completion", {
          planId: "pl-01",
          rev: 0,
          summary: "All verified",
        })
      ).text,
    );
    expect(Object.keys(completion).sort()).toEqual([
      "effects",
      "proposalId",
      "rev",
    ]);
  });

  it("set_room_mode keeps its old output", async () => {
    await updateMap(project, context.workId, (map) => {
      map.rooms[0]!.mode = "free";
    });
    const result = JSON.parse(
      (
        await call("s-01", "set_room_mode", {
          room: "r-01",
          mode: "checklist",
          reason: "Need a plan",
        })
      ).text,
    );
    expect(Object.keys(result)).toEqual(["effects"]);
  });

  it("the conflict message points at plan_tasks", async () => {
    await accepted();
    const result = await call("s-02", "plan_update", {
      ...base,
      rev: 3,
      status: "in_progress",
    });
    expect(result.failed).toBe(true);
    expect(result.text).toBe(
      "Plan revision or item changed; call plan_tasks for the current revision.",
    );
  });
});

describe("plan_tasks tool", () => {
  const base = { planId: "pl-01", rev: 0, item: 1 };

  it("is a read with no session parameter and a one-sentence description", async () => {
    const tool = (await (await connect("s-02")).listTools()).tools.find(
      (row) => row.name === "plan_tasks",
    )!;
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual([
      "cursor",
      "item",
      "planId",
    ]);
    expect(tool.inputSchema.required ?? []).toEqual([]);
    expect(tool.description).toMatch(
      /reading a letter does not finish an assignment/i,
    );
  });

  it("lists the caller's open assignments and writes nothing", async () => {
    await accepted();
    const before = JSON.stringify(await readMap(project, context.workId));
    const owner = JSON.parse((await call("s-02", "plan_tasks", {})).text);
    expect(owner).toMatchObject({
      session: "s-02",
      total: 1,
      next: null,
      finished: { count: 0, items: [] },
    });
    expect(owner.assignments[0]).toMatchObject({
      planId: "pl-01",
      rev: 0,
      room: "r-01",
      item: 1,
      role: "owner",
      action: "start",
      title: "Implement",
    });
    const verifier = JSON.parse((await call("s-03", "plan_tasks", {})).text);
    expect(verifier.assignments[0]).toMatchObject({
      role: "verifier",
      action: "wait",
      waitingFor: { kind: "submission", by: "s-02" },
    });
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });

  it("shows the verification as soon as the owner submits, even after the letters were read", async () => {
    await accepted();
    await call("s-02", "plan_submit", {
      ...base,
      evidence: { text: "Measured", artifacts: [] },
    });
    await call("s-03", "check_inbox", {});
    const view = JSON.parse((await call("s-03", "plan_tasks", {})).text);
    expect(view.assignments.map((row: { action: string }) => row.action)).toEqual(
      ["verify"],
    );
  });

  it("reads one item in full when planId and item are given", async () => {
    await accepted();
    const view = JSON.parse(
      (await call("s-01", "plan_tasks", { planId: "pl-01", item: 1 })).text,
    );
    expect(view.assignments).toEqual([]);
    expect(view.detail).toMatchObject({
      planId: "pl-01",
      item: 1,
      owner: "s-02",
      verifier: "s-03",
      scope: "src/a.ts",
    });
  });

  it("refuses a missing session, a session argument and bad input", async () => {
    await accepted();
    const noSession = await call(null, "plan_tasks", {});
    expect(noSession.failed).toBe(true);
    expect(noSession.text).toMatch(/no session/i);
    for (const args of [
      { session: "s-03" },
      { item: 1 },
      { planId: "x" },
      { planId: "pl-01", item: 0 },
      { cursor: 5 },
      { maxBytes: 100 },
    ])
      expect(
        (await call("s-02", "plan_tasks", args)).failed,
        JSON.stringify(args),
      ).toBe(true);
  });

  it("refuses an invalid cursor with the retry hint", async () => {
    await accepted();
    const result = await call("s-02", "plan_tasks", { cursor: "junk" });
    expect(result.failed).toBe(true);
    expect(result.text).toMatch(/call plan_tasks without cursor/);
  });
});
