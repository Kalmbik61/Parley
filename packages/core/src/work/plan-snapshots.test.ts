import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSession } from "./map.js";
import { addRoom } from "./rooms.js";
import { resolveProposal, setProposal } from "./proposals.js";
import { createWork, readMap, updateMap, workPaths } from "./store.js";
import { cancelRoomPlan, submitPlanItem } from "./plans.js";
import { flushPlanSnapshots } from "./plan-snapshots.js";
import { HUMAN } from "./types.js";
let root: string;
let project: string;
let workId: string;
let previous: string | undefined;
const AT = "2026-10-04T01:00:00.000Z";
beforeEach(async () => {
  root = await realpath(await mkdtemp("/private/tmp/parley-plan-snapshots-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await Promise.all([mkdir(project), mkdir(home)]);
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: "Snapshot" })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: "codex", label: "Lead", task: "Fixture" }, AT);
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
        goal: "Original exact goal",
        items: [{ id: 1, title: "Work", owner: "s-01", scope: "src/a.ts" }],
      },
    });
    const plan = map.rooms[0]!.proposal!.plan!;
    resolveProposal(
      map,
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: plan.id, planRev: plan.rev },
      AT,
    );
  });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
const snapshotDir = () => path.join(project, ".parley", "plans");

describe("captured immutable plan exports", () => {
  it("writes the accepted payload even after a later revision and completion; replay is idempotent", async () => {
    const captured = (await readMap(project, workId)).planExports![0]!;
    await updateMap(project, workId, (map) => {
      const p = setProposal(map, "r-01", "s-01", "New decision", AT, {
        plan: {
          id: "pl-01",
          rev: 0,
          mode: "checklist",
          goal: "New goal",
          items: [
            { id: 1, title: "New work", owner: "s-01", scope: "src/new.ts" },
          ],
        },
      });
      resolveProposal(
        map,
        "r-01",
        p.proposalId,
        "accept",
        { rev: p.rev, planId: "pl-01", planRev: 1 },
        AT,
      );
      submitPlanItem(
        map,
        "pl-01",
        1,
        1,
        "s-01",
        { text: "Completed evidence", artifacts: ["src/new.ts"] },
        AT,
      );
    });
    const result = await flushPlanSnapshots(project, workId);
    expect(result.failed).toEqual([]);
    expect(result.written).toHaveLength(3);
    expect(
      await readFile(path.join(snapshotDir(), captured.file), "utf8"),
    ).toBe(captured.content);
    expect(captured.content).not.toContain("New goal");
    const completed = (await readMap(project, workId)).planExports!.find(
      (item) => item.event === "completed",
    )!;
    expect(
      await readFile(path.join(snapshotDir(), completed.file), "utf8"),
    ).toContain("Completed evidence");
    expect((await flushPlanSnapshots(project, workId)).written).toEqual([]);
  });
  it("conflicting occupied snapshot stays byte-identical and its intent remains retryable", async () => {
    const intent = (await readMap(project, workId)).planExports![0]!;
    await mkdir(snapshotDir());
    const file = path.join(snapshotDir(), intent.file);
    await writeFile(file, "Human file");
    expect((await flushPlanSnapshots(project, workId)).failed).toEqual([
      { file: intent.file, code: "snapshot-conflict" },
    ]);
    expect(await readFile(file, "utf8")).toBe("Human file");
    expect((await readMap(project, workId)).planExports![0]!.status).toBe(
      "pending",
    );
    await rm(file);
    expect((await flushPlanSnapshots(project, workId)).failed).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(intent.content);
  });
  it("a failed publication retains the exact payload; retry after a later live edit uses captured bytes", async () => {
    const intent = (await readMap(project, workId)).planExports![0]!;
    expect(
      (
        await flushPlanSnapshots(project, workId, {
          beforeCommit: async () => {
            throw new Error("Synthetic disk failure");
          },
        })
      ).failed,
    ).toHaveLength(1);
    await updateMap(project, workId, (map) => {
      map.plans![0]!.goal = "Later live goal";
    });
    expect((await flushPlanSnapshots(project, workId)).failed).toEqual([]);
    expect(await readFile(path.join(snapshotDir(), intent.file), "utf8")).toBe(
      intent.content,
    );
  });
  it("concurrent flushes publish one exact version and never nest shared/map locks", async () => {
    const results = await Promise.all([
      flushPlanSnapshots(project, workId),
      flushPlanSnapshots(project, workId),
    ]);
    expect(results.every((result) => !result.failed.length)).toBe(true);
    expect((await readMap(project, workId)).planExports![0]!.status).toBe(
      "written",
    );
  });
  it("an observed competing publication before exclusive link is preserved as a conflict", async () => {
    const intent = (await readMap(project, workId)).planExports![0]!;
    const result = await flushPlanSnapshots(project, workId, {
      beforeCommit: async (file) => {
        await writeFile(file, "Competing human content");
      },
    });
    expect(result.failed[0]!.code).toBe("snapshot-conflict");
    expect(await readFile(path.join(snapshotDir(), intent.file), "utf8")).toBe(
      "Competing human content",
    );
  });
  it("rejects a redirected snapshots directory and keeps foreign files unchanged", async () => {
    const foreign = path.join(root, "foreign");
    await mkdir(foreign);
    await symlink(foreign, snapshotDir());
    const intent = (await readMap(project, workId)).planExports![0]!;
    const file = path.join(foreign, intent.file);
    await writeFile(file, "Foreign");
    expect((await flushPlanSnapshots(project, workId)).failed).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe("Foreign");
  });
  it("exports cancellation with an independent filename and migrates only the exact generated ignore", async () => {
    const ignore = path.join(project, ".parley", ".gitignore");
    await writeFile(ignore, "*\n");
    await updateMap(project, workId, (map) =>
      cancelRoomPlan(map, "pl-01", 0, HUMAN, AT),
    );
    expect((await flushPlanSnapshots(project, workId)).written).toHaveLength(2);
    expect(await readFile(ignore, "utf8")).toContain("!plans/**");
    const intents = (await readMap(project, workId)).planExports!;
    expect(intents[0]!.content).toContain("status: active");
    expect(intents[1]!.content).toContain("status: cancelled");
  });
});

it("retries exact published bytes when acknowledgement fails before map persistence", async () => {
  const intent = (await readMap(project, workId)).planExports![0]!;
  const index = path.join(process.env.PARLEY_HOME!, "works-index.json");
  const original = await readFile(index, "utf8");
  const result = await flushPlanSnapshots(project, workId, {
    beforeCommit: async () => {
      await writeFile(index, "malformed fixture");
    },
  });
  expect(result.failed).toHaveLength(1);
  expect(await readFile(path.join(snapshotDir(), intent.file), "utf8")).toBe(
    intent.content,
  );
  expect((await readMap(project, workId)).planExports![0]!.status).toBe(
    "pending",
  );
  await writeFile(index, original);
  expect((await flushPlanSnapshots(project, workId)).failed).toEqual([]);
  expect((await readMap(project, workId)).planExports![0]!.status).toBe(
    "written",
  );
});
it("publishes a nested linked-worktree plan in the corresponding main folder while its map stays local", async () => {
  const run = promisify(execFile);
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  await mkdir(main);
  const git = (...args: string[]) =>
    run("git", ["-c", "core.fsmonitor=false", "-C", main, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await git("init", "-b", "main");
  await mkdir(path.join(main, "nested"));
  await writeFile(path.join(main, "nested", "a"), "fixture");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  );
  await git("worktree", "add", "-b", "linked", linked);
  const participant = path.join(linked, "nested");
  const id = (await createWork(participant, { title: "Nested plan" })).work.id;
  await updateMap(participant, id, (map) => {
    addSession(map, { provider: "codex", label: "Lead", task: "" }, AT);
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
        goal: "Nested",
        items: [{ id: 1, title: "Work", owner: "s-01", scope: "a" }],
      },
    });
    resolveProposal(
      map,
      "r-01",
      p.proposalId,
      "accept",
      { rev: p.rev, planId: "pl-01", planRev: 0 },
      AT,
    );
  });
  const intent = (await readMap(participant, id)).planExports![0]!;
  expect((await flushPlanSnapshots(participant, id)).failed).toEqual([]);
  expect(
    await readFile(
      path.join(main, "nested", ".parley", "plans", intent.file),
      "utf8",
    ),
  ).toBe(intent.content);
  await expect(
    readFile(path.join(main, ".parley", "plans", intent.file)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(participant, ".parley", "plans", intent.file)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(workPaths(participant, id).map).toBe(
    path.join(participant, ".parley", "works", id, "map.json"),
  );
});

it("never publishes or removes a human replacement of the invocation temporary file", async () => {
  const intent = (await readMap(project, workId)).planExports![0]!;
  let replacement = "";
  const result = await flushPlanSnapshots(project, workId, {
    beforeCommit: async () => {
      const name = (await readdir(path.join(project, ".parley"))).find(
        (name) => name.startsWith(".plan-") && name.endsWith(".tmp"),
      )!;
      replacement = path.join(project, ".parley", name);
      await rm(replacement);
      await writeFile(replacement, "Human replacement");
    },
  });
  expect(result.failed).toHaveLength(1);
  expect((await readMap(project, workId)).planExports![0]!.status).toBe(
    "pending",
  );
  await expect(
    readFile(path.join(snapshotDir(), intent.file)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(replacement, "utf8")).toBe("Human replacement");
});
