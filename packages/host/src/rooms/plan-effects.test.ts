import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addRoom,
  addSession,
  HUMAN,
  PARLEY,
  reservePlanEffects,
  resolveProposal,
  setProposal,
  updatePlanItem,
  flushDecisionJournal,
} from "@parley/core";
import type { WorkMap } from "@parley/core";
import type { ActivityService } from "../activity/activity-service.js";
import type { WorksService } from "../works/works-service.js";
import type { PlanEffectsServiceIO } from "./plan-effects.js";
import { createPlanEffectsService, watchTurnEnds } from "./plan-effects.js";
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
function fixture(map = empty(), rate = 1) {
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
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createPlanEffectsService(works, {
    io,
    messageRate: async () => rate,
    now: () => Date.now(),
    onFailure: failure,
    log,
  });
  return {
    service,
    io,
    failure,
    log,
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
function planned(count = 2): WorkMap {
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
      items: Array.from({ length: count }, (_, index) => index + 1).map((id) => ({
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

describe("turnEnded: a read assignment that the session did not start", () => {
  const READ = "2026-10-04T01:00:10.000Z";
  const END = "2026-10-04T01:01:00.000Z";
  const ref = { projectPath: "/project", workId: "w-01", sessionId: "s-02" };
  const STALLED =
    "S02 read assignment pl-01 rev 0 item 1 (ready) and ended its turn without starting, progress, result or blocker. Nudge it in the room or amend the plan.";
  /** Поручения разосланы, адресат их прочёл по `check_inbox`. */
  function readAssignments(count = 1): WorkMap {
    const map = planned(count);
    reservePlanEffects(map, 20, AT);
    for (const letter of map.messages.filter((row) => row.from === PARLEY))
      letter.readBy["s-02"] = READ;
    return map;
  }
  const toLead = (map: WorkMap) =>
    map.messages.filter((row) => row.from === PARLEY && row.to[0] === "s-01");

  it("appends the stalled effect and reserves the lead's letter in one write", async () => {
    const map = readAssignments();
    const f = fixture(map, 20);
    await f.service.turnEnded(ref, END);
    expect(f.writes).toBe(1);
    const letters = toLead(map);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      kind: "note",
      roomId: "r-01",
      text: STALLED,
    });
    expect(
      map.planEffects!.filter((row) => row.kind === "stalled"),
    ).toMatchObject([
      { status: "sent", target: "s-01", messageId: letters[0]!.id },
    ]);
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it("adds no second letter for a second turn end or after a restart over the same map", async () => {
    const map = readAssignments();
    const f = fixture(map, 20);
    await f.service.turnEnded(ref, END);
    await f.service.turnEnded(ref, "2026-10-04T01:02:00.000Z");
    const restarted = fixture(map, 20);
    await restarted.service.turnEnded(ref, "2026-10-04T01:03:00.000Z");
    expect(toLead(map)).toHaveLength(1);
    expect(f.writes).toBe(1);
    expect(restarted.writes).toBe(0);
  });

  it("leaves the map alone when nothing was read, the session started the item, or it has no assignments", async () => {
    const unread = planned(1);
    reservePlanEffects(unread, 20, AT);
    const a = fixture(unread, 20);
    await a.service.turnEnded(ref, END);
    expect(a.writes).toBe(0);
    expect(toLead(unread)).toHaveLength(0);

    const started = readAssignments();
    updatePlanItem(
      started,
      "pl-01",
      0,
      1,
      "s-02",
      "in_progress",
      undefined,
      "2026-10-04T01:00:30.000Z",
    );
    const b = fixture(started, 20);
    await b.service.turnEnded(ref, END);
    expect(b.writes).toBe(0);
    expect(toLead(started)).toHaveLength(0);

    const c = fixture(readAssignments(), 20);
    await c.service.turnEnded({ ...ref, sessionId: "s-01" }, END);
    expect(c.io.updateMap).not.toHaveBeenCalled();
    const free = fixture(empty(), 20);
    await free.service.turnEnded(ref, END);
    expect(free.io.updateMap).not.toHaveBeenCalled();
  });

  it("logs a failing write and never rejects into the activity listener", async () => {
    const f = fixture(readAssignments(), 20);
    f.io.updateMap.mockRejectedValueOnce(new Error("PRIVATE path"));
    await expect(f.service.turnEnded(ref, END)).resolves.toBeUndefined();
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it("does nothing after stop", async () => {
    const f = fixture(readAssignments(), 20);
    f.service.stop();
    await f.service.turnEnded(ref, END);
    expect(f.io.updateMap).not.toHaveBeenCalled();
  });
});

describe("watchTurnEnds", () => {
  const ref = { projectPath: "/project", workId: "w-01", sessionId: "s-02" };
  const live = (turnEndedAt: string | null) =>
    ({ activity: { turnEndedAt }, metrics: null }) as never;
  function rig(paused = () => false) {
    let emit: (target: typeof ref, value: never) => void = () => {};
    let off = 0;
    const activity = {
      onChange: (fn: typeof emit) => {
        emit = fn;
        return () => {
          off++;
        };
      },
    } as unknown as Pick<ActivityService, "onChange">;
    const service = { turnEnded: vi.fn(async () => {}) };
    const stop = watchTurnEnds(activity, service, paused);
    return {
      emit: (r: typeof ref, v: string | null) => emit(r, live(v)),
      service,
      stop,
      off: () => off,
    };
  }

  it("calls turnEnded only when the turn end advances for that session", () => {
    const r = rig();
    r.emit(ref, null);
    expect(r.service.turnEnded).not.toHaveBeenCalled();
    r.emit(ref, "2026-10-04T01:01:00.000Z");
    r.emit(ref, "2026-10-04T01:01:00.000Z");
    r.emit(ref, "2026-10-04T01:00:00.000Z");
    r.emit(ref, null);
    expect(r.service.turnEnded).toHaveBeenCalledTimes(1);
    expect(r.service.turnEnded).toHaveBeenLastCalledWith(
      ref,
      "2026-10-04T01:01:00.000Z",
    );
    r.emit(ref, "2026-10-04T01:02:00.000Z");
    expect(r.service.turnEnded).toHaveBeenCalledTimes(2);
    r.emit({ ...ref, sessionId: "s-03" }, "2026-10-04T01:01:00.000Z");
    expect(r.service.turnEnded).toHaveBeenCalledTimes(3);
  });

  it("does nothing while the wake service is paused", () => {
    let paused = true;
    const r = rig(() => paused);
    r.emit(ref, "2026-10-04T01:01:00.000Z");
    expect(r.service.turnEnded).not.toHaveBeenCalled();
    paused = false;
    r.emit(ref, "2026-10-04T01:02:00.000Z");
    expect(r.service.turnEnded).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes", () => {
    const r = rig();
    r.stop();
    expect(r.off()).toBe(1);
  });
});
