// New session / New room (D1 §8.4, plan A26): the form rules and the calls behind the Face ID gate. No React here, so
// every rule is tested; the screen only draws it. The data layer is `remote-client` (A12b): it never retries a
// changing call and finds out after a lost answer by re-reading the snapshot.
import type {
  CreateRoomOutcome,
  CreateSessionOutcome,
  RemoteClient,
  RemoteState,
  RoomRef,
  SessionRef,
} from '@parley/remote-client';
import { selectLaunchCapabilities } from '@parley/remote-client';
import type { RemoteSession, RemoteWork } from '@parley/protocol/remote';
import type { Approve, NotSent } from '../auth/approve';

export const LABEL_MAX = 64;
export const TITLE_MAX = 128;
export const MEMBERS_MAX = 16;
export const TEXT_MAX_BYTES = 16 * 1024;
export const DEFAULT_SESSION_NAME = 'New session';
export const DEFAULT_AGENT_NAME = 'New agent';

export type RoomMode = 'free' | 'checklist' | 'verified';
export const ROOM_MODES: ReadonlyArray<{ mode: RoomMode; title: string; hint: string }> = [
  { mode: 'free', title: 'Free', hint: 'The lead brings you a decision when the agents agree' },
  { mode: 'checklist', title: 'Checklist', hint: 'The lead proposes a plan of items; you accept it, then the room works through it' },
  { mode: 'verified', title: 'Verified', hint: 'Like Checklist, and a verifier checks each item' },
];
export const AUTONOMOUS_NOTE = 'Autonomous rooms are created on your Mac';

export const OFF_ON_MAC = 'Creating sessions and rooms from the phone is turned off on your Mac.';
export const NOT_CONFIRMED = "We couldn't confirm it — check Works before trying again.";
export const MAY_BE_STARTING = 'It may still be starting — check Works.';

const encoder = new TextEncoder();
export const utf8Length = (text: string): number => encoder.encode(text).length;

// ---- what the sheet offers ----

export interface Workspace {
  projectPath: string;
  workId: string;
  title: string;
  projectName: string;
  status: RemoteWork['status'];
}

const folder = (projectPath: string): string => projectPath.split('/').filter((p) => p !== '').at(-1) ?? projectPath;

/** Existing, not archived works of the projection, grouped by project in the snapshot's order. Active ones first. */
export function workspaces(state: Pick<RemoteState, 'snapshot'>): Workspace[] {
  const all = (state.snapshot?.works ?? [])
    .filter((w) => w.status !== 'archived')
    .map((w) => ({ projectPath: w.projectPath, workId: w.id, title: w.title, projectName: folder(w.projectPath), status: w.status }));
  return [...all.filter((w) => w.status === 'active'), ...all.filter((w) => w.status !== 'active')];
}

/** The work the sheet opens on: the one it was opened from, else the first active. */
export function defaultWorkspace(list: readonly Workspace[], from: { projectPath: string; workId: string } | null): Workspace | null {
  const same = from === null ? undefined : list.find((w) => w.projectPath === from.projectPath && w.workId === from.workId);
  return same ?? list[0] ?? null;
}

/** The plus button exists only when the bridge hello offers a launch method (the Mac switch is on). */
export function canShowNew(state: Pick<RemoteState, 'methods'>): boolean {
  const c = selectLaunchCapabilities(state);
  return c.canCreateSession || c.canCreateRoom;
}

/** Sessions that can be room members: alive, not closed, not part of a swarm. */
export function roomCandidates(work: RemoteWork): RemoteSession[] {
  const inSwarm = new Set(work.swarms.flatMap((s) => s.members.map((m) => m.sessionId)));
  return work.sessions.filter((s) => s.lifecycle !== 'closed' && !inSwarm.has(s.id));
}

export interface ProviderChoice {
  id: string;
  label: string;
  available: boolean;
  /** Why it is off, in the host's words as far as the projection tells. */
  reason: string | null;
  models: Array<{ id: string; label: string }>;
}

const NEEDS: Record<string, string> = { cli: 'is not installed on your Mac', key: 'has no API key on your Mac', 'sign-in': "isn't signed in on your Mac" };

export function providerChoices(state: Pick<RemoteState, 'providers'>): ProviderChoice[] {
  return (state.providers?.providers ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    available: p.available,
    reason: p.available ? null : `${p.label} ${(p.needs && NEEDS[p.needs]) || 'is not ready on your Mac'}`,
    models: (p.models ?? []).map((m) => ({ id: m.id, label: m.label })),
  }));
}

// ---- forms ----

export interface RoleChoice {
  source: 'builtin' | 'claude' | 'codex';
  name: string;
}

export interface SessionForm {
  projectPath: string;
  workId: string;
  provider: string;
  model: string | null;
  role: RoleChoice | null;
  name: string;
  task: string;
  worktree: boolean;
}

/** What the session is called: the typed name, else the role, else "New session" — never past 64 characters. */
export function sessionName(form: Pick<SessionForm, 'name' | 'role'>, fallback: string = DEFAULT_SESSION_NAME): string {
  const typed = form.name.trim();
  return (typed !== '' ? typed : (form.role?.name ?? fallback)).slice(0, LABEL_MAX);
}

/** Why the start button is off; `null` — it is on. */
export function sessionProblem(form: SessionForm, providers: readonly ProviderChoice[]): string | null {
  if (form.task.trim() === '') return 'Write what the agent should do';
  if (utf8Length(form.task) > TEXT_MAX_BYTES) return 'The task is too long';
  if (form.name.trim().length > LABEL_MAX) return 'The name is too long';
  const provider = providers.find((p) => p.id === form.provider);
  if (provider === undefined) return 'Choose an agent';
  if (!provider.available) return provider.reason ?? 'This agent is not ready';
  return null;
}

/** A new agent of a room: it starts quietly, without a task. */
export interface NewAgent {
  key: string;
  provider: string;
  model: string | null;
  role: RoleChoice | null;
}

export interface RoomForm {
  projectPath: string;
  workId: string;
  title: string;
  mode: RoomMode;
  /** Ids of existing sessions of the work. */
  members: string[];
  agents: NewAgent[];
  /** An existing session id, a `NewAgent.key`, or `null` — the first member leads. */
  lead: string | null;
}

export const memberCount = (form: Pick<RoomForm, 'members' | 'agents'>): number => form.members.length + form.agents.length;

export function roomProblem(form: RoomForm, providers: readonly ProviderChoice[]): string | null {
  if (form.title.trim() === '') return 'Name the room';
  if (form.title.trim().length > TITLE_MAX) return 'The room name is too long';
  const n = memberCount(form);
  if (n < 1) return 'Add at least one agent';
  if (n > MEMBERS_MAX) return `A room holds at most ${MEMBERS_MAX} agents`;
  for (const agent of form.agents) {
    const provider = providers.find((p) => p.id === agent.provider);
    if (provider === undefined || !provider.available) return provider?.reason ?? 'Choose an agent';
  }
  return null;
}

export const LETTER_PLACEHOLDER = 'First message';

export function letterProblem(text: string): string | null {
  if (text.trim() === '') return 'Write the first message';
  if (utf8Length(text) > TEXT_MAX_BYTES) return 'The message is too long';
  return null;
}

// ---- results and their words ----

export type LaunchFailure =
  | { kind: 'refused'; code: string; message: string }
  /** The answer was lost and the re-read found nothing yet (sessions/rooms) or could not run. */
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'unknown'; message: string };

/** The host's own words, except for the Mac switch, which gets one fixed sentence. */
export function refusalMessage(code: string, message: string): string {
  if (code === 'unknown_method') return OFF_ON_MAC;
  return message.trim() === '' ? code : message;
}

function failure(outcome: Exclude<CreateSessionOutcome | CreateRoomOutcome, { outcome: 'created' }>): LaunchFailure {
  if (outcome.outcome === 'rejected') return { kind: 'refused', code: outcome.code, message: refusalMessage(outcome.code, outcome.message) };
  if (outcome.outcome === 'unknown') return { kind: 'unknown', message: MAY_BE_STARTING };
  return { kind: 'unconfirmed', message: NOT_CONFIRMED };
}

/** `reason`: Face ID cancelled, or the phone has no passcode (the toast says how to fix it). */
export type Cancelled = { kind: 'cancelled'; reason: NotSent };

export type SessionLaunch = Cancelled | { kind: 'created'; ref: SessionRef } | LaunchFailure;

type Launcher = Pick<RemoteClient, 'createSession' | 'createRoom' | 'sendRoomMessage'>;

/** Face ID first (nothing is sent if it fails), then `sessions.create`. */
export async function launchSession(client: Launcher, approve: Approve, form: SessionForm): Promise<SessionLaunch> {
  const asked = await approve('launch');
  if (asked !== 'ok') return { kind: 'cancelled', reason: asked };
  const outcome = await client.createSession({
    projectPath: form.projectPath,
    workId: form.workId,
    provider: form.provider,
    label: sessionName(form),
    task: form.task,
    ...(form.model !== null && form.model !== '' ? { model: form.model } : {}),
    ...(form.role !== null ? { role: form.role } : {}),
    ...(form.worktree ? { worktree: true } : {}),
  });
  return outcome.outcome === 'created' ? { kind: 'created', ref: outcome.ref } : failure(outcome);
}

/** A new agent of the form that already runs on the Mac. */
export interface StartedAgent {
  key: string;
  sessionId: string;
}

export type RoomLaunch =
  | Cancelled
  | { kind: 'created'; ref: RoomRef; agents: number }
  /** Failed on the way: `startedAgents` are already running and show in the work; `afterPartial` keeps them for a retry. */
  | { kind: 'partial'; started: number; startedAgents: StartedAgent[]; message: string; failure: LaunchFailure };

/**
 * The form after a partial failure: started agents become members (by session id) and leave the new-agent list, so a
 * retry only creates what is missing and never starts the same agent twice (critic final, A1). A lead that was a new
 * agent becomes its session.
 */
export function afterPartial(form: RoomForm, startedAgents: readonly StartedAgent[]): RoomForm {
  const ids = new Map(startedAgents.map((a) => [a.key, a.sessionId]));
  return {
    ...form,
    members: [...form.members, ...startedAgents.map((a) => a.sessionId)],
    agents: form.agents.filter((a) => !ids.has(a.key)),
    lead: form.lead !== null && ids.has(form.lead) ? ids.get(form.lead)! : form.lead,
  };
}

/** The words for a room that could not be finished after some agents had started. */
export function partialMessage(started: number, reason: string): string {
  return started === 0 ? reason : `${started} ${started === 1 ? 'agent' : 'agents'} started, the room was not created: ${reason}`;
}

/**
 * One Face ID for the whole "Create room": new agents start quietly (no task), then the room is created quietly with
 * the chosen mode. The first message is a second step with its own Face ID (`sendFirstLetter`).
 */
export async function launchRoom(client: Launcher, approve: Approve, form: RoomForm): Promise<RoomLaunch> {
  const asked = await approve('launch');
  if (asked !== 'ok') return { kind: 'cancelled', reason: asked };
  const started = new Map<string, string>();
  const startedAgents = (): StartedAgent[] => [...started].map(([key, sessionId]) => ({ key, sessionId }));
  for (const agent of form.agents) {
    const outcome = await client.createSession({
      projectPath: form.projectPath,
      workId: form.workId,
      provider: agent.provider,
      label: sessionName({ name: '', role: agent.role }, DEFAULT_AGENT_NAME),
      task: '',
      ...(agent.model !== null && agent.model !== '' ? { model: agent.model } : {}),
      ...(agent.role !== null ? { role: agent.role } : {}),
    });
    if (outcome.outcome !== 'created') {
      const f = failure(outcome);
      return { kind: 'partial', started: started.size, startedAgents: startedAgents(), message: partialMessage(started.size, f.message), failure: f };
    }
    started.set(agent.key, outcome.ref.sessionId);
  }
  const members = [...form.members, ...form.agents.map((a) => started.get(a.key)!)];
  const lead = form.lead === null ? undefined : (started.get(form.lead) ?? form.lead);
  const outcome = await client.createRoom({
    projectPath: form.projectPath,
    workId: form.workId,
    title: form.title.trim(),
    members,
    quiet: true,
    mode: form.mode,
    ...(lead !== undefined && members.includes(lead) ? { lead } : {}),
  });
  if (outcome.outcome === 'created') return { kind: 'created', ref: outcome.ref, agents: members.length };
  const f = failure(outcome);
  return { kind: 'partial', started: started.size, startedAgents: startedAgents(), message: partialMessage(started.size, f.message), failure: f };
}

export type LetterLaunch = Cancelled | { kind: 'sent' } | LaunchFailure;

/** The task of a quiet room: Face ID again (every send asks), then `rooms.send`. The draft stays in the store until sent. */
export async function sendFirstLetter(client: Launcher, approve: Approve, room: RoomRef, text: string): Promise<LetterLaunch> {
  const asked = await approve('letter');
  if (asked !== 'ok') return { kind: 'cancelled', reason: asked };
  const outcome = await client.sendRoomMessage({ ...room, text, kind: 'note' });
  if (outcome.outcome === 'sent') return { kind: 'sent' };
  if (outcome.outcome === 'rejected') return { kind: 'refused', code: outcome.code, message: refusalMessage(outcome.code, outcome.message) };
  return { kind: 'unconfirmed', message: NOT_CONFIRMED };
}

export type LaunchStep = 'session' | 'room' | 'letter';

/**
 * Why the action cannot go at all: a method it needs is not in the bridge hello any more (the Mac switch was turned off
 * while the sheet was open, or the versions drifted). Face ID is not asked for a call that will not go.
 */
export function methodMissing(state: Pick<RemoteState, 'methods'>, step: LaunchStep, newAgents = 0): string | null {
  const c = selectLaunchCapabilities(state);
  const ok = step === 'session' ? c.canCreateSession : step === 'letter' ? c.canSendRoomMessage : c.canCreateRoom && (newAgents === 0 || c.canCreateSession);
  return ok ? null : OFF_ON_MAC;
}

/** Whether the sheet holds something worth a "Discard this draft?" on swipe-down. */
export function hasDraft(mode: 'session' | 'room', session: Pick<SessionForm, 'task' | 'name'>, room: Pick<RoomForm, 'title' | 'members' | 'agents'>, letter: string): boolean {
  if (letter.trim() !== '') return true;
  return mode === 'session' ? session.task.trim() !== '' || session.name.trim() !== '' : room.title.trim() !== '';
}
