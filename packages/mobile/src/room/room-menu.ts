// The ⋯ menu of the room screen (D1 §9.7, spec §4.2 "Действия меню комнаты с телефона", plan A41b): items and which of
// them are disabled, the archive count, the confirm texts and the sequential runner for Put all to sleep / Wake all.
// No React. An item whose method is missing from the bridge hello (the Mac switch is off) is not in the menu.
import type { SessionCommandOutcome } from '@parley/remote-client';
import type { OwnerConfirm } from '../auth/confirm-owner';
import { hostLine, NOT_CONFIRMED_TOAST } from '../feed/session-menu';

export type RoomMenuId = 'sleepAll' | 'wakeAll' | 'copy' | 'archive' | 'delete';

export interface RoomMember {
  id: string;
  label: string;
  lifecycle: string;
}

export interface RoomFacts {
  id: string;
  title: string;
  mode: string | null;
  /** The room's open decision, if any. */
  hasProposal: boolean;
  members: readonly string[];
  /** `archivedAt != null`: the window offers Reopen there, the phone only Delete. */
  archived: boolean;
}

export interface RoomMenuFacts {
  /** `hello.methods`; `null` — not known yet. */
  methods: readonly string[] | null;
  room: RoomFacts;
  /** The sessions of the work. */
  sessions: readonly RoomMember[];
  /** The other rooms of the work (any state): `archived` ones do not keep an agent busy. */
  otherRooms: ReadonlyArray<{ id: string; members: readonly string[]; archived: boolean }>;
  /** The bridge connection is ready (demo: always). Offline, items with calls are disabled and Face ID is not asked. */
  online: boolean;
  /** An action of this menu is in flight (including the Face ID wait): one action at a time. */
  pending: Pending | null;
}

export type PendingKind = 'sleep' | 'wake' | 'archive' | 'delete';
export interface Pending {
  kind: PendingKind;
  /** Sessions done so far in a run; `null` total — not a run (archive, delete). */
  done: number;
  total: number | null;
}

export interface RoomMenuItem {
  id: RoomMenuId;
  title: string;
  destructive?: boolean;
  disabled?: boolean;
}

export const AUTONOMOUS_REASON = 'Run by the autonomous engine — manage it on your Mac';
export const NO_RUNNING = 'No running agents';
export const NO_SLEEPING = 'No sleeping agents';
export const OFFLINE_REASON = 'Not connected — reconnecting';

const HUMAN = 'human';

/** Members of the room with this lifecycle, in the room's order; unknown ids and the human are skipped. */
export function membersWhere(f: Pick<RoomMenuFacts, 'room' | 'sessions'>, lifecycle: 'active' | 'sleeping'): RoomMember[] {
  const byId = new Map(f.sessions.map((s) => [s.id, s]));
  return [...new Set(f.room.members)].flatMap((id) => {
    const s = id === HUMAN ? undefined : byId.get(id);
    return s !== undefined && s.lifecycle === lifecycle ? [s] : [];
  });
}

/**
 * Agents that "Archive and stop" puts to sleep: active members that are in no other non-archived room of the work
 * (the core `archiveRoom` rule, the window's `archiveStops`).
 */
export function archiveStops(f: RoomMenuFacts): RoomMember[] {
  if (f.room.archived) return [];
  const busyElsewhere = new Set(f.otherRooms.filter((r) => r.id !== f.room.id && !r.archived).flatMap((r) => r.members));
  return membersWhere(f, 'active').filter((s) => !busyElsewhere.has(s.id));
}

export interface RoomMenu {
  /** The sheet title: why something is disabled; `undefined` — nothing to say. */
  title: string | undefined;
  items: RoomMenuItem[];
}

/** The sheet title while an action runs (D1 §9.7): "Putting agents to sleep… 2 of 4", "Archiving…". */
export function pendingTitle(p: Pending): string {
  const of = p.total === null ? '' : ` ${p.done} of ${p.total}`;
  return { sleep: 'Putting agents to sleep…', wake: 'Waking agents…', archive: 'Archiving…', delete: 'Deleting…' }[p.kind] + of;
}

/** The toast when a run starts. */
export const startToast = (kind: 'sleep' | 'wake', n: number): string => (kind === 'sleep' ? `Putting ${plural(n, 'agent', 'agents')} to sleep…` : `Waking ${plural(n, 'agent', 'agents')}…`);

/** D1 order: Put all to sleep, Wake all, Copy room ID, Archive room…, Delete room…. */
export function roomMenu(f: RoomMenuFacts): RoomMenu {
  const has = (m: string): boolean => f.methods?.includes(m) ?? false;
  const autonomous = f.room.mode === 'autonomous';
  const running = membersWhere(f, 'active').length;
  const sleeping = membersWhere(f, 'sleeping').length;
  // Calls are off while another action runs, offline and in the engine's room; the reasons below only add candidates.
  const off = autonomous || !f.online || f.pending !== null;
  const items: RoomMenuItem[] = [];
  const reasons: string[] = [];
  if (has('sessions.stop')) {
    const disabled = off || running === 0;
    items.push({ id: 'sleepAll', title: 'Put all to sleep', ...(disabled ? { disabled } : {}) });
    if (!off && running === 0) reasons.push(NO_RUNNING);
  }
  if (has('sessions.resume')) {
    const disabled = off || sleeping === 0;
    items.push({ id: 'wakeAll', title: 'Wake all', ...(disabled ? { disabled } : {}) });
    if (!off && sleeping === 0) reasons.push(NO_SLEEPING);
  }
  items.push({ id: 'copy', title: 'Copy room ID' });
  if (has('rooms.archive') && !f.room.archived) items.push({ id: 'archive', title: 'Archive room…', ...(off ? { disabled: true } : {}) });
  if (has('rooms.delete')) items.push({ id: 'delete', title: 'Delete room…', destructive: true, ...(off ? { disabled: true } : {}) });
  const anyDisabled = items.some((i) => i.disabled === true);
  const title =
    f.pending !== null && anyDisabled
      ? pendingTitle(f.pending)
      : !f.online && anyDisabled
        ? OFFLINE_REASON
        : autonomous && anyDisabled
          ? AUTONOMOUS_REASON
          : reasons.length > 0
            ? reasons.join(' · ')
            : undefined;
  return { title, items };
}

export interface Confirm {
  title: string;
  message: string;
  button: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function sleepConfirm(n: number): Confirm {
  return { title: `Put ${plural(n, 'agent', 'agents')} to sleep?`, message: 'They stop. Wake all brings them back with their conversations.', button: 'Put to sleep' };
}

export interface ArchiveOption {
  title: string;
  stopSessions: boolean;
}

export interface ArchiveSheet {
  title: string;
  message: string;
  options: ArchiveOption[];
}

/**
 * The archive sheet. The description mentions the open decision; a live plan is not in the phone snapshot (the plan body
 * stays on the Mac, `planId` rides on the proposal), so the proposal alone decides whether the second sentence is shown.
 */
export function archiveSheet(f: RoomMenuFacts): ArchiveSheet {
  const n = archiveStops(f).length;
  const base = 'The feed stays readable. Nobody can write here until you reopen it on your Mac.';
  return {
    title: `Archive “${f.room.title}”?`,
    message: f.room.hasProposal ? `${base} Its open decision and live plan are closed.` : base,
    options: n > 0 ? [{ title: `Archive and stop ${plural(n, 'agent', 'agents')}`, stopSessions: true }, { title: 'Archive, keep agents running', stopSessions: false }] : [{ title: 'Archive', stopSessions: false }],
  };
}

export function deleteConfirm(f: RoomMenuFacts): Confirm {
  // Sessions that really are in the work, once each (the window counts the sessions standing in the room).
  const known = new Set(f.sessions.map((x) => x.id));
  const n = new Set(f.room.members.filter((id) => known.has(id))).size;
  const base = 'The feed, decision and plans of this room are deleted.';
  return { title: `Delete “${f.room.title}”?`, message: n === 0 ? base : `${base} Its ${n === 1 ? '1 session stays' : `${n} sessions stay`} in the work.`, button: 'Delete' };
}

export const FACE_ID_PROMPT = { archive: 'Archive this room', delete: 'Delete this room' } as const;
export const NO_FACE_ID_TOAST = 'Set up Face ID or a passcode on this iPhone to archive or delete rooms';

export type RunStatus = 'ok' | 'refused' | 'lost' | 'not-sent';
export interface RunResult {
  id: string;
  label: string;
  status: RunStatus;
  /** The reason shown in the result sheet; `null` for ok. */
  text: string | null;
}

/**
 * One call at a time, in order (the host's rate limit and its log see a calm sequence). A call that fails does not stop
 * the rest. `not_connected` means the call never left the phone.
 */
export async function runAll(targets: ReadonlyArray<{ id: string; label: string }>, call: (id: string) => Promise<SessionCommandOutcome>, onProgress?: (done: number, total: number) => void): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const t of targets) {
    let outcome: SessionCommandOutcome;
    try {
      outcome = await call(t.id);
    } catch {
      outcome = { outcome: 'lost' };
    }
    if (outcome.outcome === 'ok') results.push({ ...t, status: 'ok', text: null });
    else if (outcome.outcome === 'lost') results.push({ ...t, status: 'lost', text: NOT_CONFIRMED_TOAST });
    else results.push({ ...t, status: outcome.code === 'not_connected' ? 'not-sent' : 'refused', text: hostLine(outcome) });
    onProgress?.(results.length, targets.length);
  }
  return results;
}

export interface RunSummary {
  /** Everything succeeded: a toast, no sheet. */
  allOk: boolean;
  /** Sheet title ("Put to sleep: 3 of 4" / "Woke 2 of 3"), or the toast text when `allOk`. */
  title: string;
}

export function runSummary(kind: 'sleep' | 'wake', results: readonly RunResult[]): RunSummary {
  const ok = results.filter((r) => r.status === 'ok').length;
  const allOk = ok === results.length;
  const title = kind === 'sleep' ? (allOk ? 'Put to sleep' : `Put to sleep: ${ok} of ${results.length}`) : allOk ? 'Woke all' : `Woke ${ok} of ${results.length}`;
  return { allOk, title };
}

/** Toast after archive / delete. */
export function roomToast(kind: 'archive' | 'delete', outcome: SessionCommandOutcome): string {
  if (outcome.outcome === 'ok') return kind === 'archive' ? 'Archived' : 'Deleted';
  return outcome.outcome === 'lost' ? NOT_CONFIRMED_TOAST : hostLine(outcome);
}

export type GateResult = { kind: 'silent' } | { kind: 'toast'; text: string } | { kind: 'sent'; outcome: SessionCommandOutcome };

/**
 * Face ID before a call (spec §11.4): `send` runs exactly once and only after 'ok'. Cancelled (or a prompt that throws) is
 * silent, 'unavailable' is a toast; a throwing `send` is "not confirmed" — nothing is known about the call.
 */
export async function ownerGate(confirm: () => Promise<OwnerConfirm>, send: () => Promise<SessionCommandOutcome>): Promise<GateResult> {
  let owner: OwnerConfirm;
  try {
    owner = await confirm();
  } catch {
    return { kind: 'silent' };
  }
  if (owner === 'unavailable') return { kind: 'toast', text: NO_FACE_ID_TOAST };
  if (owner !== 'ok') return { kind: 'silent' };
  try {
    return { kind: 'sent', outcome: await send() };
  } catch {
    return { kind: 'sent', outcome: { outcome: 'lost' } };
  }
}
