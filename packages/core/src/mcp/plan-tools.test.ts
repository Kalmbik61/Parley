import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createParleyServer } from "./tools.js";
import { addSession, transitionSession } from "../work/map.js";
import { addRoom } from "../work/rooms.js";
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
