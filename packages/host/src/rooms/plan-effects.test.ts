import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addRoom,
  addSession,
  HUMAN,
  reservePlanEffects,
  resolveProposal,
  setProposal,
  flushDecisionJournal,
} from "@parley/core";
import type { WorkMap } from "@parley/core";
import type { WorksService } from "../works/works-service.js";
import type { PlanEffectsServiceIO } from "./plan-effects.js";
import { createPlanEffectsService } from "./plan-effects.js";
const AT = "2026-10-04T01:00:00.000Z";
const empty = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: "w-01",
    title: "Fixture",
    goal: "",
    status: "active",
    createdAt: AT,
    updatedAt: AT,
  },
  sessions: [],
  rooms: [],
  messages: [],
});
afterEach(() => vi.useRealTimers());
function fixture(map = empty()) {
  let listener: () => void = () => {};
  let present = true;
  let locked = false;
  let writes = 0;
  const works: Pick<WorksService, "snapshot" | "entry" | "onChange"> = {
    snapshot: () => ({
      entries: present ? [{ projectPath: "/project", map }] : [],
      branches: {},
    }),
    entry: () => (present ? { projectPath: "/project", map } : undefined),
    onChange: (fn) => {
      listener = () => fn(works.snapshot(), works.snapshot());
      return () => {
        listener = () => {};
      };
    },
  };
  const flush = vi.fn<PlanEffectsServiceIO["flush"]>(async () => {
    expect(locked).toBe(false);
    return {
      effects: {
        queued: 0,
        pendingSnapshots: 0,
        pendingBacklog: 0,
        conflictCount: 0,
        conflicts: [],
      },
      snapshotFailures: [],
    };
  });
  const io = {
    readMap: vi.fn(async () => structuredClone(map)),
    updateMap: vi.fn(
      async (_p: string, _w: string, body: (m: WorkMap) => void) => {
        locked = true;
        try {
          const draft = structuredClone(map);
          body(draft);
          Object.assign(map, draft);
          writes++;
          listener();
          return structuredClone(map);
        } finally {
          locked = false;
        }
      },
    ),
    flush,
    flushJournal: vi.fn<typeof flushDecisionJournal>(async () => {
      expect(locked).toBe(false);
      const pending = map.decisionExports?.filter(row => row.status === 'pending') ?? [];
      for (const row of pending) row.status = 'written';
      return { written: pending.map(row => row.file), failed: [], diagnostics: [] };
    }),
  };
  const failure = vi.fn();
  const service = createPlanEffectsService(works, {
    io,
    messageRate: async () => 1,
    now: () => Date.now(),
    onFailure: failure,
  });
  return {
    service,
    io,
    failure,
    get writes() {
      return writes;
    },
    changed: () => listener(),
    remove: () => {
      present = false;
      listener();
    },
  };
}
function planned(): WorkMap {
  const map = empty();
  addSession(map, { provider: "codex", label: "Lead", task: "Fixture" }, AT);
  addSession(map, { provider: "codex", label: "Owner", task: "Fixture" }, AT);
  addRoom(
    map,
    {
      creator: HUMAN,
      members: ["s-01", "s-02"],
      title: "Plan",
      mode: "checklist",
      lead: "s-01",
    },
    AT,
  );
  const p = setProposal(map, "r-01", "s-01", "Decision", AT, {
    plan: {
      mode: "checklist",
      goal: "Done",
      items: [1, 2].map((id) => ({
        id,
        title: `Item ${id}`,
        owner: "s-02",
        scope: "src",
      })),
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
  return map;
}
describe("plan effects lifecycle scheduler", () => {
  it("ordinary Free maps are a true no-write/no-flush/no-budget-read operation", async () => {
    const f = fixture();
    f.service.start();
    await f.service.flush("/project", "w-01");
    expect(f.writes).toBe(0);
    expect(f.io.flush).not.toHaveBeenCalled();
    f.changed();
    expect(f.io.updateMap).not.toHaveBeenCalled();
    f.service.stop();
  });
  it("coalesces own map changes, flushes captured snapshots outside map lock and drains one rate queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const f = fixture(planned());
    f.service.start();
    await f.service.flush("/project", "w-01");
    expect(f.writes).toBe(1);
    expect(f.io.flush).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(f.writes).toBe(2);
    f.service.stop();
  });
  it("clears queued timers on project removal and stop without reviving deleted context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const f = fixture(planned());
    await f.service.flush("/project", "w-01");
    f.service.start();
    f.remove();
    const before = f.writes;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(f.writes).toBe(before);
    f.service.stop();
    await expect(f.service.flush("/project", "w-01")).rejects.toThrow(
      "plan context unavailable",
    );
  });
  it("reports only safe fixed failure codes/counts and does not leak native/raw errors", async () => {
    const f = fixture(planned());
    f.io.readMap.mockRejectedValue(
      new Error("PRIVATE filesystem path and payload"),
    );
    await expect(f.service.flush("/project", "w-01")).rejects.toThrow();
    expect(f.failure).toHaveBeenCalledWith({
      projectPath: "/project",
      workId: "w-01",
      code: "plan-effect-failed",
      count: 1,
    });
    expect(JSON.stringify(f.failure.mock.calls)).not.toContain("PRIVATE");
    f.service.stop();
  });
});

it("bounded transient backoff stops after three retries; explicit Retry recovers without repeated notices", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  const f = fixture(planned());
  f.io.flush.mockResolvedValue({
    effects: {
      queued: 1,
      pendingSnapshots: 1,
      pendingBacklog: 0,
      conflictCount: 0,
      conflicts: [],
    },
    snapshotFailures: [
      {
        file: "w-01-r-01-pl-01-rev-0-accepted.md",
        code: "snapshot-write-failed",
      },
    ],
  });
  f.service.start();
  await f.service.flush("/project", "w-01");
  expect(f.io.flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.io.flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.io.flush).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.io.flush).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(f.io.flush).toHaveBeenCalledTimes(4);
  expect(f.failure).toHaveBeenCalledTimes(1);
  await f.service.flush("/project", "w-01");
  expect(f.io.flush).toHaveBeenCalledTimes(5);
  f.service.stop();
});
it("immutable conflicts stop automatic IO while rate-limited letters continue and explicit Retry remains available", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  const f = fixture(planned());
  f.io.flush.mockResolvedValue({
    effects: {
      queued: 1,
      pendingSnapshots: 1,
      pendingBacklog: 0,
      conflictCount: 0,
      conflicts: [],
    },
    snapshotFailures: [
      { file: "w-01-r-01-pl-01-rev-0-accepted.md", code: "snapshot-conflict" },
    ],
  });
  f.service.start();
  await f.service.flush("/project", "w-01");
  expect(f.io.flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(f.io.flush).toHaveBeenCalledTimes(1);
  expect(f.writes).toBe(2);
  await f.service.flush("/project", "w-01");
  expect(f.io.flush).toHaveBeenCalledTimes(2);
  f.service.stop();
});
it("an idle current plan with no pending effects writes nothing and schedules no timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  const map = planned();
  reservePlanEffects(map, 20, AT);
  map.planExports!.forEach((row) => {
    row.status = "written";
  });
  map.decisionExports?.forEach(row => { row.status = "written"; });
  const f = fixture(map);
  f.service.start();
  await f.service.flush("/project", "w-01");
  expect(f.writes).toBe(0);
  expect(f.io.flush).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.service.stop();
});

it("a confirmed immutable conflict excludes only its intent and new captured files flush immediately", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  const map = planned();
  const original = map.planExports![0]!;
  const f = fixture(map);
  f.io.flush.mockImplementation(async (_p, _w, options) => ({
    effects: {
      queued: 1,
      pendingSnapshots: 1,
      pendingBacklog: 0,
      conflictCount: 0,
      conflicts: [],
    },
    snapshotFailures: options?.excludedSnapshotFiles?.has(original.file)
      ? []
      : [{ file: original.file, code: "snapshot-conflict" }],
  }));
  f.service.start();
  let result = await f.service.flush("/project", "w-01");
  expect(result.conflicts).toContainEqual({
    planId: original.planId,
    rev: original.rev,
    code: "snapshot-conflict",
  });
  const calls = f.io.flush.mock.calls.length;
  await vi.advanceTimersByTimeAsync(40000);
  expect(f.io.flush).toHaveBeenCalledTimes(calls);
  map.planExports!.push({
    ...original,
    file: original.file.replace("rev-0", "rev-1"),
    rev: 1,
  });
  f.changed();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.io.flush).toHaveBeenCalledTimes(calls + 1);
  expect(f.io.flush.mock.calls.at(-1)![2]!.excludedSnapshotFiles).toEqual(
    new Set([original.file]),
  );
  result = await f.service.flush("/project", "w-01");
  expect(f.io.flush.mock.calls.at(-1)![2]!.excludedSnapshotFiles!.size).toBe(0);
  expect(result.conflictCount).toBe(1);
  f.service.stop();
});


it('accepted Free decision journals use the same post-map-lock authority and no plan reservation writes', async () => {
  const map = planned(); delete map.plans; delete map.planExports;
  const f = fixture(map);
  await f.service.flush('/project', map.work.id);
  expect(f.io.flushJournal).toHaveBeenCalledOnce();
  expect(f.writes).toBe(0);
  expect(map.decisionExports?.[0]?.status).toBe('written');
  f.service.stop();
});

it('journal disk failure retains acceptance and uses bounded existing retries, with one safe notice', async () => {
  vi.useFakeTimers(); const map = planned(); delete map.plans; delete map.planExports;
  const f = fixture(map); const intent = map.decisionExports![0]!;
  f.io.flushJournal.mockResolvedValue({ written: [], failed: [{file: intent.file, code: 'journal-unavailable'}], diagnostics: [] });
  f.service.start(); await vi.advanceTimersByTimeAsync(1);
  expect(f.io.flushJournal).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000);
  expect(f.io.flushJournal).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(100000);
  expect(f.io.flushJournal).toHaveBeenCalledTimes(4);
  expect(intent.status).toBe('pending'); expect(map.rooms[0]?.proposal).toBeNull();
  expect(f.failure).toHaveBeenCalledOnce();
  expect(f.failure).toHaveBeenCalledWith({projectPath:'/project',workId:map.work.id,code:'plan-effect-failed',count:1});
  f.service.stop();
});

it('semantic journal conflict is excluded per captured file while a new decision continues and manual Retry reuses originals', async () => {
  const map = planned(); delete map.plans; delete map.planExports;
  const f = fixture(map); const old = map.decisionExports![0]!;
  f.io.flushJournal.mockResolvedValueOnce({ written: [], failed:[{file:old.file,code:'journal-conflict'}],diagnostics:[] });
  await f.service.flush('/project',map.work.id);
  // A meaningful new accepted event keeps the old captured bytes instead of rebasing them.
  const next = {...old, file:old.file.replace('.md','-next.md'), messageId:'m-99'};
  map.decisionExports!.push(next);
  f.io.flushJournal.mockImplementation(async (_project,_work,options) => {
    expect(options?.excludedFiles?.has(old.file)).toBe(true);
    next.status='written';return {written:[next.file],failed:[],diagnostics:[]};
  });
  f.service.start(); await new Promise(resolve=>setTimeout(resolve,1));
  expect(next.status).toBe('written'); expect(old.status).toBe('pending');
  f.io.flushJournal.mockImplementation(async (_project,_work,options) => {
    expect(options?.excludedFiles?.size).toBe(0);old.status='written';return {written:[old.file],failed:[],diagnostics:[]};
  });
  await f.service.flush('/project',map.work.id);expect(old.status).toBe('written');f.service.stop();
});
