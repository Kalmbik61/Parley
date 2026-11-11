// T9a harness, slice H2a: a goal's `data`, built once with the real store, and restored per arm. Nothing here starts a server or a helper.
//
// Layout of one goal's directory `dir`:
//   dir/live/home, dir/live/project   what an arm's server.js reads (the local store); the project path never changes, so ids and rows are the same
//   dir/hosthome                      the store the in-process host answers from: the same rows as live/home, without the local canary
//   dir/snap/home, dir/snap/project   the pristine copy every arm starts from (`cp -c -R`, copy on write)
// The store keys its rows by the project path, so a copy at another path would be another work; the arms therefore restore the SAME paths
// from the snapshot (R2). The functions that touch the store set `PARLEY_HOME` for their own duration and restore it: one build at a time.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HUMAN } from '../packages/core/src/work/types.js';
import { addSession, transitionSession } from '../packages/core/src/work/map.js';
import { addRoom } from '../packages/core/src/work/rooms.js';
import { acceptRoomPlan, setRoomMode } from '../packages/core/src/work/plans.js';
import { setProposal } from '../packages/core/src/work/proposals.js';
import { setBacklogRule } from '../packages/core/src/work/project-preferences.js';
import { suggestBacklog } from '../packages/core/src/work/backlog-suggestions.js';
import { createWork, updateMap } from '../packages/core/src/work/store.js';
import { closeWorkDb } from '../packages/core/src/work/db.js';
import { claimProcessHome } from './parley-token-benchmark-replay-busy.js';
import type { Goal, Obj } from './parley-token-benchmark-replay-schema.js';
import type { Ids } from './parley-token-benchmark-replay-judge.js';

export interface BuiltData {
  readonly dir: string;
  readonly home: string;
  readonly hostHome: string;
  readonly project: string;
  readonly workId: string;
  /** Key -> id as the store assigned them, for `$session` and `$room`. */
  readonly ids: Ids;
  /** The caller: the session id of `data.self`. */
  readonly selfId: string;
}

const paths = (dir: string) => ({ home: path.join(dir, 'live', 'home'), project: path.join(dir, 'live', 'project'), hostHome: path.join(dir, 'hosthome'), snap: path.join(dir, 'snap') });

/** A text field: a string as it is, or `{ $pad: n, with: s }` as `s` repeated to n UTF-8 bytes (exactly n when `s` is ASCII, never beyond n). */
export function padText(spec: { readonly $pad: number; readonly with: string }): string {
  const unit = [...spec.with];
  let out = '';
  let bytes = 0;
  for (let i = 0; bytes < spec.$pad; i++) {
    const ch = unit[i % unit.length]!;
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > spec.$pad) break;
    out += ch;
    bytes += size;
  }
  return out;
}
const text = (v: unknown): string => (typeof v === 'string' ? v : padText(v as { $pad: number; with: string }));

/**
 * Runs `body` with `PARLEY_HOME` pointing at `home`, then closes the database it opened and restores the variable. The variable is the process's one: a second
 * `withHome` while one is running would read and write the first one's store, so it is refused by name (goals run strictly one after another).
 */
export async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const release = claimProcessHome('withHome');
  const was = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  try { return await body(); } finally {
    closeWorkDb();
    if (was === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = was;
    release();
  }
}

const copy = (from: string, to: string): void => {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  execFileSync('cp', ['-c', '-R', from, to]); // APFS clone: the preflight requires macOS
};

/**
 * Builds the goal's data with the real store, in array order, so ids are stable: sessions (lifecycle, task, summary), rooms with their letters,
 * the backlog as suggestions, then plans through the real steps. Returns the ids, and leaves a pristine snapshot beside the live copy.
 */
export async function buildGoalData(goal: Goal, dir: string): Promise<BuiltData> {
  if (goal.data === null) throw new Error(`goal ${goal.id} has no data: only run goals are built`);
  const data = goal.data;
  const p = paths(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.project, { recursive: true });
  const sessionIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  let workId = '';
  await withHome(p.home, async () => {
    workId = (await createWork(p.project, { title: goal.id })).work.id;
    // `ask`: every backlog entry stays a pending suggestion, so `backlog_list` returns each with its kind, why and details whatever the kind is.
    await setBacklogRule(p.project, 'ask');
    await updateMap(p.project, workId, (map, letters) => {
      for (const s of data.sessions) {
        const row = addSession(map, { provider: s['provider'] as 'claude' | 'codex', label: text(s['label']), task: s['task'] === undefined ? 'fixture' : text(s['task']) });
        sessionIds[String(s['key'])] = row.id;
        if (s['lifecycle'] === 'active') transitionSession(map, row.id, 'active');
        else if (s['lifecycle'] === 'closed') transitionSession(map, row.id, 'closed');
        if (s['summary'] !== undefined && s['summary'] !== null) { row.summary = text(s['summary']); row.summarySource = 'agent'; }
      }
      const idOf = (key: unknown): string => key === 'human' ? HUMAN : sessionIds[String(key)]!;
      for (const r of data.rooms) {
        const memberIds = (r['members'] as string[]).map(idOf);
        const room = addRoom(map, { creator: HUMAN, title: text(r['title']), lead: idOf(r['lead']), members: memberIds });
        roomIds[String(r['key'])] = room.id;
        for (const m of (r['messages'] as Obj[] | undefined) ?? []) letters.add({ roomId: room.id, from: idOf(m['from']), to: [], text: text(m['text']), kind: m['kind'] as 'note' | 'question' | 'decision' });
      }
      for (const pl of data.plans) {
        const roomId = roomIds[String(pl['room'])]!;
        const lead = idOf(data.rooms.find((r) => r['key'] === pl['room'])!['lead']);
        const status = String(pl['status']);
        if (status !== 'proposed' && status !== 'active') throw new Error(`plan ${String(pl['key'])}: status ${status} is not built by the harness (no frozen goal uses it)`);
        const mode = pl['mode'] as 'checklist' | 'verified';
        setRoomMode(map, letters, roomId, HUMAN, mode, 'fixture');
        const items = (pl['items'] as Obj[]).map((it) => ({
          id: it['id'] as number, title: text(it['title']), owner: idOf(it['owner']), scope: text(it['scope']),
          ...(it['after'] === undefined ? {} : { after: it['after'] as number[] }),
          ...(it['criteria'] === undefined ? {} : { criteria: (it['criteria'] as unknown[]).map(text) }),
          ...(it['verifier'] === undefined ? {} : { verifier: idOf(it['verifier']) }),
        }));
        setProposal(map, roomId, lead, text(pl['goal']), new Date().toISOString(), { plan: { mode, goal: text(pl['goal']), items } });
        if (status === 'active') acceptRoomPlan(map, letters, map.rooms.find((r) => r.id === roomId)!.proposal!.plan!, new Date().toISOString());
      }
    });
    const self = sessionIds[data.self]!;
    for (const b of data.backlog) {
      const r = await suggestBacklog(p.project, { kind: b['kind'] as 'bug' | 'debt' | 'idea', title: text(b['title']), why: text(b['why']), ...(b['details'] === undefined ? {} : { details: text(b['details']) }), workId, sessionId: self });
      if (r.status !== 'pending') throw new Error(`backlog entry ${text(b['title']).slice(0, 40)}: ${r.status}, not a pending suggestion`);
    }
  });
  copy(path.join(dir, 'live'), p.snap);
  return Object.freeze({ dir, home: p.home, hostHome: p.hostHome, project: p.project, workId, ids: { sessions: sessionIds, rooms: roomIds }, selfId: sessionIds[data.self]! });
}

/**
 * Puts the pristine snapshot back before an arm: the local store and project at their fixed paths, and the host's store beside them. `canary`
 * is written into the caller's summary in the LOCAL store only: a host that answers from its own copy never holds it, so a read that returns it
 * came from a local fallback.
 */
export async function restoreForArm(built: BuiltData, canary: string | null): Promise<void> {
  const p = paths(built.dir);
  copy(path.join(p.snap, 'home'), p.home);
  copy(path.join(p.snap, 'project'), p.project);
  copy(path.join(p.snap, 'home'), p.hostHome);
  if (canary !== null) {
    await withHome(p.home, async () => {
      await updateMap(p.project, built.workId, (map) => {
        const row = map.sessions.find((s) => s.id === built.selfId)!;
        row.summary = canary;
        row.summarySource = 'agent';
      });
    });
  }
}
