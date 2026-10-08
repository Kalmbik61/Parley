import {
  DEFAULT_CONFIG,
  loadConfig,
  readMap,
  reservePlanEffects,
  summarizePlanEffects,
  updateMap,
  flushPlanEffects,
  flushDecisionJournal,
} from "@parley/core";
import type { PlanEffectsSummary, WorkMap } from "@parley/core";
import type { WorksService } from "../works/works-service.js";

export interface PlanEffectsServiceIO {
  readMap: typeof readMap;
  updateMap: typeof updateMap;
  flush: typeof flushPlanEffects;
  flushJournal?: typeof flushDecisionJournal;
}
export interface PlanEffectsServiceOptions {
  io?: PlanEffectsServiceIO;
  messageRate?: () => Promise<number>;
  now?: () => number;
  onFailure?(failure: {
    projectPath: string;
    workId: string;
    code:
      | "plan-effect-failed"
      | "snapshot-conflict"
      | "snapshot-unavailable"
      | "backlog-conflict"
      | "backlog-unavailable";
    count: number;
  }): void;
}
export interface PlanEffectsService {
  start(): void;
  stop(): void;
  flush(projectPath: string, workId: string): Promise<PlanEffectsSummary>;
}
interface State {
  projectPath: string;
  workId: string;
  dirty: boolean;
  source: string | null;
  retryAttempt: number;
  retryAt: number | null;
  deliveryAt: number | null;
  snapshotConflicts: Map<
    string,
    { planId: string; rev: number; code: "snapshot-conflict" }
  >;
  snapshotFailures: Map<
    string,
    {
      planId: string;
      rev: number;
      code: "snapshot-conflict" | "snapshot-unavailable";
    }
  >;
  backlogConflicts: Set<string>;
  journalConflicts: Set<string>;
  retryConflicts: boolean;
  running?: Promise<PlanEffectsSummary>;
  timer?: ReturnType<typeof setTimeout>;
}
class NoPlanChange extends Error {}
function sourceIdentity(map: WorkMap): string {
  return JSON.stringify([
    map.work.status,
    map.sessions.map((row) => [row.id, row.lifecycle]),
    map.rooms.map((row) => [
      row.id,
      row.mode,
      row.members,
      row.lead,
      row.proposal?.id,
      row.proposal?.rev,
    ]),
    map.planExports?.map((row) => row.file),
    map.decisionExports?.map((row) => row.file),
    map.planBacklogIntents?.map((row) => row.key),
    map.plans?.map((plan) => [
      plan.id,
      plan.rev,
      plan.status,
      plan.items.map((row) => [
        row.id,
        row.status,
        row.log.length,
        row.owner,
        row.scope,
        row.criteria,
        row.verifier,
      ]),
    ]),
  ]);
}
const hasWork = (map: WorkMap): boolean =>
  !!(
    map.plans?.length ||
    map.planEffects?.length ||
    map.planBacklogIntents?.length ||
    map.planExports?.length ||
    map.decisionExports?.length
  );
/** Coalesces lifecycle events; map reservations finish before any snapshot/backlog filesystem operation. */
export function createPlanEffectsService(
  works: Pick<WorksService, "snapshot" | "entry" | "onChange">,
  options: PlanEffectsServiceOptions = {},
): PlanEffectsService {
  const io = options.io ?? { readMap, updateMap, flush: flushPlanEffects };
  const flushJournal = io.flushJournal ?? flushDecisionJournal;
  const now = options.now ?? Date.now;
  const messageRate =
    options.messageRate ??
    (async () =>
      (await loadConfig()).config.messageRate ?? DEFAULT_CONFIG.messageRate);
  const states = new Map<string, State>();
  const noticed = new Set<string>();
  let stopped = false;
  let off: (() => void) | undefined;
  function notify(
    state: State,
    code: Parameters<
      NonNullable<PlanEffectsServiceOptions["onFailure"]>
    >[0]["code"],
    count: number,
  ): void {
    const key = `${state.projectPath}\0${state.workId}\0${code}`;
    if (
      stopped ||
      !works.entry(state.projectPath, state.workId) ||
      noticed.has(key)
    )
      return;
    if (noticed.size >= 1000) return;
    noticed.add(key);
    options.onFailure?.({
      projectPath: state.projectPath,
      workId: state.workId,
      code,
      count,
    });
  }
  function clearTimer(state: State): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      delete state.timer;
    }
  }
  function schedule(state: State, at: number | null): void {
    clearTimer(state);
    if (stopped || at === null || !works.entry(state.projectPath, state.workId))
      return;
    state.timer = setTimeout(
      () => {
        delete state.timer;
        void flush(state.projectPath, state.workId).catch(() => {});
      },
      Math.min(60 * 60 * 1000, Math.max(1, at - now())),
    );
  }
  async function process(state: State): Promise<PlanEffectsSummary> {
    let result: PlanEffectsSummary = {
      queued: 0,
      pendingSnapshots: 0,
      pendingBacklog: 0,
      conflictCount: 0,
      conflicts: [],
    };
    do {
      state.dirty = false;
      if (stopped || !works.entry(state.projectPath, state.workId))
        return result;
      const map = await io.readMap(state.projectPath, state.workId);
      if (!hasWork(map)) return summarizePlanEffects(map);
      const source = sourceIdentity(map);
      if (source !== state.source) {
        state.source = source;
        state.retryAttempt = 0;
        state.retryAt = null;
      }
      const rate = await messageRate();
      if (stopped || !works.entry(state.projectPath, state.workId))
        return result;
      const at = new Date(now()).toISOString();
      const preview = structuredClone(map);
      let reservation = reservePlanEffects(preview, rate, at);
      let current = map;
      if (reservation.changed) {
        try {
          current = await io.updateMap(
            state.projectPath,
            state.workId,
            (draft) => {
              reservation = reservePlanEffects(draft, rate, at);
              if (!reservation.changed) throw new NoPlanChange();
            },
            { touch: false },
          );
        } catch (error) {
          if (!(error instanceof NoPlanChange)) throw error;
          current = await io.readMap(state.projectPath, state.workId);
        }
      }
      if (stopped || !works.entry(state.projectPath, state.workId))
        return summarizePlanEffects(current);
      state.source = sourceIdentity(current);
      state.deliveryAt = reservation.nextDueAt;
      if (!state.retryConflicts) {
        for (const row of current.planBacklogIntents ?? [])
          if (row.status === "conflict") state.backlogConflicts.add(row.key);
      }
      state.retryConflicts = false;
      const pendingJournal = current.decisionExports?.some(
        row => row.status === "pending" && !state.journalConflicts.has(row.file),
      );
      const pendingIO = pendingJournal ||
        current.planExports?.some(
          (row) =>
            row.status === "pending" && !state.snapshotConflicts.has(row.file),
        ) ||
        current.planBacklogIntents?.some(
          (row) =>
            row.status !== "written" && !state.backlogConflicts.has(row.key),
        );
      if (
        state.retryAttempt < 4 &&
        (state.retryAt === null || state.retryAt <= now()) &&
        pendingIO
      ) {
        const flushed = await io.flush(state.projectPath, state.workId, {
          excludedSnapshotFiles: new Set(state.snapshotConflicts.keys()),
          excludedBacklogKeys: state.backlogConflicts,
        });
        result = flushed.effects;
        for (const intent of current.planExports ?? [])
          if (!state.snapshotConflicts.has(intent.file))
            state.snapshotFailures.delete(intent.file);
        for (const failure of flushed.snapshotFailures) {
          const captured = current.planExports?.find(
            (row) => row.file === failure.file,
          );
          if (captured)
            state.snapshotFailures.set(failure.file, {
              planId: captured.planId,
              rev: captured.rev,
              code:
                failure.code === "snapshot-write-failed"
                  ? "snapshot-unavailable"
                  : "snapshot-conflict",
            });
          if (
            failure.code !== "snapshot-conflict" &&
            failure.code !== "snapshot-invalid"
          )
            continue;
          const intent = current.planExports?.find(
            (row) => row.file === failure.file,
          );
          if (intent)
            state.snapshotConflicts.set(failure.file, {
              planId: intent.planId,
              rev: intent.rev,
              code: "snapshot-conflict",
            });
        }
        for (const failure of flushed.backlogFailures ?? []) {
          if (failure.code !== "backlog-conflict") continue;
          const intent = current.planBacklogIntents?.find(
            (row) =>
              row.planId === failure.planId &&
              row.rev === failure.rev &&
              row.backlogId === failure.backlogId,
          );
          if (intent) state.backlogConflicts.add(intent.key);
        }
        // Snapshot publication precedes its accepted decision journal reference.
        // Both complete after updateMap released its lock, through this one retry authority.
        const journal = pendingJournal
          ? await flushJournal(state.projectPath, state.workId, { excludedFiles: state.journalConflicts })
          : { failed: [] };
        for (const failure of journal.failed)
          if (failure.code !== "journal-unavailable") state.journalConflicts.add(failure.file);
        if (journal.failed.length) notify(state, "plan-effect-failed", journal.failed.length);
        const transient = journal.failed.some(row => row.code === "journal-unavailable") ||
          flushed.snapshotFailures.some(
            (row) => row.code === "snapshot-write-failed",
          ) ||
          (flushed.backlogFailures ?? []).some(
            (row) => row.code === "backlog-unavailable",
          );
        if (transient) {
          state.retryAttempt++;
          state.retryAt =
            state.retryAttempt < 4
              ? now() + 5000 * 2 ** (state.retryAttempt - 1)
              : null;
        } else {
          state.retryAttempt = 0;
          state.retryAt = null;
        }
        for (const code of [
          "snapshot-conflict",
          "snapshot-unavailable",
        ] as const) {
          const failures = flushed.snapshotFailures.filter(
            (row) =>
              (row.code === "snapshot-conflict") ===
              (code === "snapshot-conflict"),
          );
          if (failures.length) notify(state, code, failures.length);
        }
        for (const code of [
          "backlog-conflict",
          "backlog-unavailable",
        ] as const) {
          const failures = result.conflicts.filter((row) => row.code === code);
          if (failures.length) notify(state, code, result.conflictCount);
        }
      } else result = summarizePlanEffects(current);
      const snapshots = [...state.snapshotFailures.values()];
      result = {
        ...result,
        conflictCount: result.conflictCount + snapshots.length,
        conflicts: [...result.conflicts, ...snapshots].slice(0, 100),
      };
      schedule(
        state,
        reservation.nextDueAt === null
          ? state.retryAt
          : state.retryAt === null
            ? reservation.nextDueAt
            : Math.min(reservation.nextDueAt, state.retryAt),
      );
    } while (state.dirty && !stopped);
    return result;
  }
  function flush(
    projectPath: string,
    workId: string,
    manual = false,
  ): Promise<PlanEffectsSummary> {
    if (stopped || !works.entry(projectPath, workId))
      return Promise.reject(new Error("plan context unavailable"));
    const key = `${projectPath}\0${workId}`;
    let state = states.get(key);
    if (!state) {
      state = {
        projectPath,
        workId,
        dirty: false,
        source: null,
        retryAttempt: 0,
        retryAt: null,
        deliveryAt: null,
        snapshotConflicts: new Map(),
        snapshotFailures: new Map(),
        backlogConflicts: new Set(),
        journalConflicts: new Set(),
        retryConflicts: false,
      };
      states.set(key, state);
    }
    if (manual) {
      state.retryAttempt = 0;
      state.retryAt = null;
      state.snapshotConflicts.clear();
      state.snapshotFailures.clear();
      state.backlogConflicts.clear();
      state.journalConflicts.clear();
      state.retryConflicts = true;
    }
    state.dirty = true;
    if (state.running) return state.running;
    const active = state;
    active.running = process(active)
      .catch(() => {
        notify(active, "plan-effect-failed", 1);
        {
          active.retryAttempt++;
          active.retryAt =
            active.retryAttempt < 4
              ? now() + 5000 * 2 ** (active.retryAttempt - 1)
              : null;
          if (active.deliveryAt !== null && active.deliveryAt <= now())
            active.deliveryAt = null;
          schedule(
            active,
            active.deliveryAt === null
              ? active.retryAt
              : active.retryAt === null
                ? active.deliveryAt
                : Math.min(active.deliveryAt, active.retryAt),
          );
        }
        throw new Error("Plan effects are unavailable.");
      })
      .finally(() => {
        delete active.running;
      });
    return active.running;
  }
  function scan(): void {
    const entries = works.snapshot().entries;
    const keys = new Set(
      entries.map((entry) => `${entry.projectPath}\0${entry.map.work.id}`),
    );
    for (const [key, state] of states)
      if (!keys.has(key)) {
        clearTimer(state);
        states.delete(key);
      }
    for (const entry of entries)
      if (hasWork(entry.map))
        void flush(entry.projectPath, entry.map.work.id).catch(() => {});
  }
  return {
    start() {
      if (off || stopped) return;
      off = works.onChange(scan);
      scan();
    },
    stop() {
      stopped = true;
      off?.();
      off = undefined;
      for (const state of states.values()) clearTimer(state);
      states.clear();
      noticed.clear();
    },
    flush: (projectPath, workId) => flush(projectPath, workId, true),
  };
}
