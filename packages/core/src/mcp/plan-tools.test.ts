import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createParleyServer } from "./tools.js";
import { addSession, transitionSession } from "../work/map.js";
import { addRoom, archiveRoom } from "../work/rooms.js";
import { createWork, updateMap, readMap, readStoredMap, workPaths } from "../work/store.js";
import { resolveProposal } from "../work/proposals.js";
import { ENGINE, HUMAN, SYSTEM } from "../work/types.js";
import { setRoomMode } from "../work/plans.js";
import type { McpContext } from "./context.js";
// Оболочка над настоящей `setRoomMode`: тест подставляет ответ с лишней строкой на один вызов, остальные идут как есть.
vi.mock("../work/plans.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../work/plans.js")>();
  return { ...actual, setRoomMode: vi.fn(actual.setRoomMode) };
});
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
  vi.unstubAllGlobals();
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
  await updateMap(project, context.workId, (map, letters) => {
    const p = map.rooms[0]!.proposal!;
    resolveProposal(map, letters, "r-01", p.id, "accept", {
      rev: p.rev,
      planId: p.plan!.id,
      planRev: p.plan!.rev,
    });
  });
}
const autonomous = {
  ...draft,
  mode: "autonomous",
  items: [{ ...draft.items[0]!, owner: ENGINE, verifier: ENGINE }],
  autonomous: {
    budget: {
      attemptsPerItem: 3,
      repairWaves: 2,
      minutesPerAttempt: 10,
      sessions: 6,
      concurrent: 2,
    },
    checks: [
      {
        id: "ck-spec-01",
        item: 1,
        argv: ["pnpm", "test"],
        cwd: ".",
        env: {},
        inputs: ["test.ts"],
        timeoutMs: 1000,
      },
    ],
    coverage: { 1: { 0: ["ck-spec-01", "verifier"] } },
  },
};
const manifest = {
  version: 1,
  criteriaVersion: 1,
  dependsOn: [],
  coverage: "covered",
  scope: "src/a.ts",
  facts: ["Implemented"],
  hypotheses: [],
  notFound: [],
  gaps: [],
  text: "Done",
  artifacts: [],
  hash: "a".repeat(64),
  submittedAt: "2026-10-24T10:00:00.000Z",
};
async function autonomousAccepted() {
  await accepted();
  await updateMap(project, context.workId, (map) => {
    map.rooms[0]!.mode = "autonomous";
    const plan = map.plans![0]!;
    plan.mode = "autonomous";
    plan.items[0]!.owner = ENGINE;
    plan.items[0]!.verifier = ENGINE;
    plan.autonomous = {
      budget: {
        limits: autonomous.autonomous.budget,
        spent: {
          attempts: 1,
          repairWaves: 0,
          sessions: 2,
          verifiers: 0,
          minutes: 0,
          launches: 1,
        },
        reservations: [],
      },
      checks: [
        {
          ...autonomous.autonomous.checks[0]!,
          inputs: [{ path: "test.ts", blob: "b".repeat(40) }],
          frozenAt: manifest.submittedAt,
        },
      ],
      coverage: autonomous.autonomous.coverage,
      criteriaVersion: { 1: 1 },
      integration: {
        branch: "parley/w-0001/integration/pl-01",
        baseSha: "a".repeat(40),
        verifiedHead: "a".repeat(40),
        candidateHead: null,
        queue: [],
        suspended: null,
      },
      attempts: [
        {
          id: "at-0001",
          item: 1,
          n: 1,
          planRev: 0,
          criteriaVersion: 1,
          worker: "s-02",
          verifier: "s-03",
          branch: "attempt/at-0001",
          baseSha: "a".repeat(40),
          sha: null,
          tree: null,
          submissionKey: null,
          status: "running",
          manifest: null,
          receipt: null,
          checks: [],
          failureSignature: null,
          startedAt: manifest.submittedAt,
          endedAt: null,
          log: [],
        },
      ],
      ops: [],
      halted: null,
      seq: { attempt: 1, receipt: 0, check: 0, op: 0 },
    };
  });
}
function attemptChannel() {
  context.agent = {
    url: "http://127.0.0.1:12345/agent/browser",
    token: "f".repeat(64),
  };
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(options.headers),
      body: JSON.parse(options.body as string),
    });
    return Response.json({ ok: true, result: { queued: true } });
  });
  return requests;
}
describe("autonomous agent channel", () => {
  it("allows the live lead to raise the room mode to autonomous", async () => {
    const result = await call("s-01", "set_room_mode", {
      room: "r-01",
      mode: "autonomous",
      reason: "Engine workflow",
    });
    expect(result.failed, result.text).toBe(false);
    expect((await readMap(project, context.workId)).rooms[0]!.mode).toBe(
      "autonomous",
    );
    expect(
      (
        await call("s-01", "set_room_mode", {
          room: "r-01",
          mode: "verified",
          reason: "Lower",
        })
      ).text,
    ).toContain("only the human");
  });
  it("registers attempt status as a read and attempt submission/verification as writes", async () => {
    const { tools } = await (await connect("s-01")).listTools();
    for (const name of ["attempt_submit", "attempt_verify", "attempt_status"]) {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.annotations!.readOnlyHint).toBe(name === "attempt_status");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("actor");
    }
  });
  it("forwards hashless submissions and returns the host-assigned key", async () => {
    await autonomousAccepted();
    const requests = attemptChannel();
    const before = JSON.stringify(await readMap(project, context.workId));
    const { hash: _hash, ...body } = manifest;
    const submissionKey = "a".repeat(64);
    vi.stubGlobal("fetch", async (_url: URL, options: RequestInit) => {
      requests.push({ url: String(_url), headers: new Headers(options.headers), body: JSON.parse(options.body as string) });
      return Response.json({ ok: true, result: { submissionKey, receipt: { id: "rc-0001" } } });
    });
    for (const args of [
      { attemptId: "at-0001", manifest: body },
      { attemptId: "at-0001", manifest: body, submissionKey },
    ]) {
      const result = await call("s-02", "attempt_submit", args);
      expect(result.failed, result.text).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ submissionKey, receipt: { id: "rc-0001" } });
      expect(requests.at(-1)!.body).toEqual({ action: "submit", ...args });
    }
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });

  it("forwards submit and verify with the session token and exact payload without writing the map", async () => {
    await autonomousAccepted();
    const requests = attemptChannel();
    const before = JSON.stringify(await readMap(project, context.workId));
    const submit = {
      attemptId: "at-0001",
      submissionKey: "b".repeat(64),
      manifest,
    };
    const verify = {
      attemptId: "at-0001",
      sha: "c".repeat(40),
      criterion: 0,
      verdict: "pass",
      note: "Independent proof",
    };
    for (const [actor, name, args] of [
      ["s-02", "attempt_submit", submit],
      ["s-03", "attempt_verify", verify],
    ] as const) {
      const result = await call(actor, name, args);
      expect(result.failed, result.text).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ queued: true });
    }
    expect(requests.map((request) => request.body)).toEqual([
      { action: "submit", ...submit },
      { action: "verify", ...verify },
    ]);
    for (const request of requests) {
      expect(request.url).toBe("http://127.0.0.1:12345/agent/attempts");
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${"f".repeat(64)}`,
      );
    }
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("forwards initial and amendment proposals with stable requestKey and no local mutations", async () => {
    const requests = attemptChannel();
    await updateMap(project, context.workId, (map) => {
      map.rooms[0]!.mode = "autonomous";
    });
    let before = JSON.stringify(await readMap(project, context.workId));
    const args = {
      room: "r-01",
      text: "Go",
      plan: autonomous,
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await call("s-01", "propose_decision", args);
      expect(result.failed, result.text).toBe(false);
    }
    expect(requests.map((request) => request.body)).toEqual([
      {
        action: "propose-plan",
        roomId: "r-01",
        text: "Go",
        requestKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        plan: autonomous,
      },
      {
        action: "propose-plan",
        roomId: "r-01",
        text: "Go",
        requestKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        plan: autonomous,
      },
    ]);
    expect(requests[0]!.body).toMatchObject({
      requestKey:
        "edfeb8f9ec75edadc1ad8ccc988dfa3022958e991441cb25133491e2a7658209",
    });
    const reordered = {
      autonomous: {
        coverage: autonomous.autonomous.coverage,
        checks: autonomous.autonomous.checks,
        budget: {
          concurrent: 2,
          sessions: 6,
          minutesPerAttempt: 10,
          repairWaves: 2,
          attemptsPerItem: 3,
        },
      },
      items: autonomous.items,
      goal: autonomous.goal,
      mode: autonomous.mode,
    };
    expect(
      (await call("s-01", "propose_decision", { ...args, plan: reordered }))
        .failed,
    ).toBe(false);
    expect(requests.at(-1)!.body).toEqual(requests[0]!.body);
    expect(
      (
        await call("s-01", "propose_decision", {
          ...args,
          plan: { ...autonomous, goal: "Changed scope" },
        })
      ).failed,
    ).toBe(false);
    expect(
      (requests.at(-1)!.body as { requestKey: string }).requestKey,
    ).not.toBe((requests[0]!.body as { requestKey: string }).requestKey);
    const changedText = await call("s-01", "propose_decision", {
      ...args,
      text: "Corrected decision wording",
    });
    expect(changedText.failed, changedText.text).toBe(false);
    expect(
      (requests.at(-1)!.body as { requestKey: string }).requestKey,
    ).not.toBe((requests[0]!.body as { requestKey: string }).requestKey);
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
    await updateMap(project, context.workId, (map) => {
      map.rooms[0]!.mode = "verified";
    });
    await autonomousAccepted();
    before = JSON.stringify(await readMap(project, context.workId));
    const amendment = { ...autonomous, id: "pl-01", rev: 0 };
    const result = await call("s-01", "propose_decision", {
      ...args,
      plan: amendment,
    });
    expect(result.failed, result.text).toBe(false);
    expect(requests.at(-1)!.body).toEqual({
      action: "propose-plan",
      roomId: "r-01",
      text: "Go",
      requestKey:
        "dc1d141119cde0b965a93d83e3f79a28c87b35b61a7b68bfb2160612d87d4974",
      planId: "pl-01",
      rev: 0,
      plan: amendment,
    });
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("rejects nonmembers, ordinary rooms and spoofed arguments before calling the channel", async () => {
    await autonomousAccepted();
    const requests = attemptChannel();
    await updateMap(project, context.workId, (map) => {
      addSession(map, { provider: "codex", label: "Outsider", task: "None" });
    });
    const submit = {
      attemptId: "at-0001",
      submissionKey: "b".repeat(64),
      manifest,
    };
    for (const [actor, name, args] of [
      ["s-04", "attempt_status", {}],
      ["s-04", "attempt_submit", submit],
      [
        "s-02",
        "attempt_submit",
        { ...submit, manifest: { ...manifest, sha: null } },
      ],
      ["s-02", "attempt_submit", { ...submit, actor: "s-03" }],
      [
        "s-02",
        "propose_decision",
        { room: "r-01", text: "Go", plan: autonomous },
      ],
      [
        "s-01",
        "propose_decision",
        { room: "r-01", text: "Go", requestKey: "forged", plan: autonomous },
      ],
    ] as const)
      expect((await call(actor, name, args)).failed, name).toBe(true);
    await updateMap(project, context.workId, (map) => {
      map.rooms[0]!.mode = "verified";
    });
    for (const [name, args] of [
      ["attempt_status", {}],
      ["attempt_submit", submit],
      [
        "attempt_verify",
        {
          attemptId: "at-0001",
          sha: "c".repeat(40),
          criterion: 0,
          verdict: "pass",
          note: "Checked",
        },
      ],
    ] as const)
      expect((await call("s-02", name, args)).failed, name).toBe(true);
    expect(requests).toHaveLength(0);
  });
  it("pages attempt cards and the full attempt by byte cursors without changing the map", async () => {
    await autonomousAccepted();
    await updateMap(project, context.workId, (map) => {
      const auto = map.plans![0]!.autonomous!;
      const first = auto.attempts[0]!;
      first.manifest = {
        ...manifest,
        sha: null,
        text: "x".repeat(4000),
      } as typeof first.manifest;
      auto.attempts = Array.from({ length: 12 }, (_, i) => ({
        ...structuredClone(first),
        id: `at-${String(i + 1).padStart(4, "0")}`,
        n: i + 1,
      }));
      auto.seq.attempt = 12;
    });
    const before = JSON.stringify(await readMap(project, context.workId));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await call("s-01", "attempt_status", {
        maxBytes: 2048,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.failed, result.text).toBe(false);
      const page = JSON.parse(result.text);
      expect(page.page.bytes).toBeLessThanOrEqual(2048);
      ids.push(...page.attempts.map((row: { id: string }) => row.id));
      cursor = page.page.next ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toHaveLength(12);
    let full = "";
    do {
      const result = await call("s-02", "attempt_status", {
        attemptId: "at-0001",
        maxBytes: 2048,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.failed, result.text).toBe(false);
      const page = JSON.parse(result.text);
      full += page.text;
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(JSON.parse(full).manifest.text).toBe("x".repeat(4000));
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("rejects stale amendments and incomplete coverage before forwarding", async () => {
    await autonomousAccepted();
    const requests = attemptChannel();
    const before = JSON.stringify(await readMap(project, context.workId));
    for (const plan of [
      { ...autonomous, id: "pl-01", rev: 9 },
      {
        ...autonomous,
        autonomous: { ...autonomous.autonomous, coverage: { 1: { 0: [] } } },
      },
    ])
      expect(
        (
          await call("s-01", "propose_decision", {
            room: "r-01",
            text: "Change",
            plan,
          })
        ).failed,
      ).toBe(true);
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("hashes numeric coverage keys in canonical lexical order", async () => {
    const requests = attemptChannel();
    await updateMap(project, context.workId, (map) => {
      map.rooms[0]!.mode = "autonomous";
    });
    const plan = {
      ...autonomous,
      items: [2, 10].map((id) => ({ ...autonomous.items[0]!, id })),
      autonomous: {
        ...autonomous.autonomous,
        checks: [],
        coverage: { 2: { 0: ["verifier"] }, 10: { 0: ["verifier"] } },
      },
    };
    const result = await call("s-01", "propose_decision", {
      room: "r-01",
      text: "Go",
      plan,
    });
    expect(result.failed, result.text).toBe(false);
    expect(requests[0]!.body).toMatchObject({
      requestKey:
        "fc839279a2260f54cc97caedbaccaceec1398503e5c8a03e35b50c022eb183f4",
    });
  });
  it("accepts top-level planId/rev for an autonomous amendment", async () => {
    await autonomousAccepted();
    const requests = attemptChannel();
    const result = await call("s-01", "propose_decision", {
      room: "r-01",
      text: "Amend",
      planId: "pl-01",
      rev: 0,
      plan: autonomous,
    });
    expect(result.failed, result.text).toBe(false);
    expect(requests[0]!.body).toMatchObject({
      action: "propose-plan",
      planId: "pl-01",
      rev: 0,
      requestKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it("refuses legacy plan_* tools for all autonomous participants", async () => {
    await autonomousAccepted();
    const before = JSON.stringify(await readMap(project, context.workId));
    for (const [name, args] of [
      ["plan_update", { status: "in_progress" }],
      ["plan_submit", { evidence: { text: "Done", artifacts: [] } }],
      ["plan_verify", { verdict: "verified", note: "Checked" }],
    ] as const) {
      const result = await call("s-02", name, {
        planId: "pl-01",
        rev: 0,
        item: 1,
        ...args,
      });
      expect(result.failed).toBe(true);
      expect(result.text).toBe("autonomous plan is driven by the engine");
    }
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("reports host refusal, unavailable channel and uncertain outcomes without writing", async () => {
    await autonomousAccepted();
    const before = JSON.stringify(await readMap(project, context.workId));
    const args = {
      attemptId: "at-0001",
      submissionKey: "b".repeat(64),
      manifest,
    };
    let result = await call("s-02", "attempt_submit", args);
    expect(result.failed).toBe(true);
    expect(result.text).toContain("host connection");
    attemptChannel();
    for (const [response, message] of [
      [
        Response.json(
          {
            ok: false,
            error: { code: "attempt-fenced", message: "Attempt superseded" },
          },
          { status: 409 },
        ),
        "attempt-fenced: Attempt superseded",
      ],
      [new Response("", { status: 401 }), "token"],
      [new Response("", { status: 404 }), "does not support /agent/attempts"],
      [new Response("unreadable"), "unreadable attempt answer"],
    ] as const) {
      vi.stubGlobal("fetch", async () => response);
      result = await call("s-02", "attempt_submit", args);
      expect(result.failed).toBe(true);
      expect(result.text).toContain(message);
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection lost");
    });
    result = await call("s-02", "attempt_submit", args);
    expect(result.failed).toBe(true);
    expect(result.text).toContain("Read attempt_status before retrying");
    expect(JSON.stringify(await readMap(project, context.workId))).toBe(before);
  });
  it("keeps completed attempt cards readable and explains invalid cursors", async () => {
    await autonomousAccepted();
    await updateMap(project, context.workId, (map) => {
      map.plans![0]!.status = "completed";
    });
    const result = await call("s-01", "attempt_status", {});
    expect(result.failed, result.text).toBe(false);
    expect(JSON.parse(result.text).attempts[0].id).toBe("at-0001");
    const invalid = await call("s-01", "attempt_status", { cursor: "bogus" });
    expect(invalid.failed).toBe(true);
    expect(invalid.text).toContain("invalid-cursor");
  });
});
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

it("set_room_mode reports its own system line by id, even when the write put another system line in the room before it", async () => {
  await updateMap(project, context.workId, (map) => {
    map.rooms[0]!.mode = "free";
  });
  const real = await vi.importActual<typeof import("../work/plans.js")>("../work/plans.js");
  vi.mocked(setRoomMode).mockImplementationOnce((...args) => {
    // Строка плана раньше строки режима — так пишет понижение режима, которое завершает план: «первая системная
    // строка комнаты после записи» была бы не той.
    const earlier = args[1].add({ roomId: "r-01", from: SYSTEM, to: [HUMAN], text: "Plan pl-01 completed", kind: "note" });
    return [earlier.id, ...real.setRoomMode(...args)];
  });
  const result = await call("s-01", "set_room_mode", {
    room: "r-01",
    mode: "checklist",
    reason: "Need a plan",
  });
  expect(result.failed, result.text).toBe(false);
  const notices = readStoredMap(project, context.workId).messages.filter((message) =>
    message.text.startsWith("Room mode changed."),
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toContain("switched the room to checklist: Need a plan");
  expect(notices[0]!.text).not.toContain("Plan pl-01 completed");
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
    await updateMap(project, context.workId, (map, letters) => {
      archiveRoom(map, letters, "r-01", "2026-10-08T12:00:00.000Z");
    });
    const before = JSON.stringify(await readMap(project, context.workId));
    const cases: [string, string, Record<string, unknown>][] = [
      ["s-01", "propose_decision", { room: "r-01", text: "Amend", plan: draft }],
      ["s-01", "set_room_mode", { room: "r-01", mode: "verified", reason: "No change" }],
      ["s-02", "plan_update", { planId: "pl-01", rev: 0, item: 1, status: "in_progress" }],
      ["s-02", "plan_submit", { planId: "pl-01", rev: 0, item: 1, evidence: { text: "Done", artifacts: [] } }],
      ["s-03", "plan_verify", { planId: "pl-01", rev: 0, item: 1, verdict: "verified", note: "Fine" }],
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
