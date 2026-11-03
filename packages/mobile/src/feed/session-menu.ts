// The ⋯ menu of the session screen (D1 §9.1, plan A38b): which items for which state, the confirms and the toasts.
// No React. An item with a method that is missing from the bridge hello (the Mac switch is off) is not in the menu.
import type { SessionCommandOutcome } from '@parley/remote-client';

export type MenuId = 'team' | 'room' | 'resume' | 'stop' | 'sleep' | 'switch' | 'copy' | 'close';

export interface MenuFacts {
  /** `hello.methods`; `null` — not known yet. */
  methods: readonly string[] | null;
  lifecycle: string;
  /** A turn is running. */
  working: boolean;
  /** Agents under this session (the Team sheet); 0 — no Team item. */
  teamAgents: number;
  /** Member of a room: the room's name is not needed here, the screen knows it. */
  inRoom: boolean;
}

export interface MenuItem {
  id: MenuId;
  title: string;
  destructive?: boolean;
}

/** D1 order: Team, Open room, Resume, Stop, Put to sleep, Continue on another provider…, Copy session ID, Close session. */
export function menuItems(f: MenuFacts): MenuItem[] {
  const has = (m: string): boolean => f.methods?.includes(m) ?? false;
  const closed = f.lifecycle === 'closed';
  const sleeping = f.lifecycle === 'sleeping';
  const live = !closed && !sleeping;
  const items: MenuItem[] = [];
  if (f.teamAgents > 0) items.push({ id: 'team', title: `Team (${f.teamAgents})` });
  if (f.inRoom) items.push({ id: 'room', title: 'Open room' });
  if (sleeping && has('sessions.resume')) items.push({ id: 'resume', title: 'Resume' });
  if (live && f.working && has('feed.interrupt')) items.push({ id: 'stop', title: 'Stop' });
  if (live && has('sessions.stop')) items.push({ id: 'sleep', title: 'Put to sleep' });
  if (!closed && has('sessions.switchOptions') && has('sessions.switchAgent')) items.push({ id: 'switch', title: 'Continue on another provider…' });
  items.push({ id: 'copy', title: 'Copy session ID' });
  if (!closed && has('sessions.close')) items.push({ id: 'close', title: 'Close session', destructive: true });
  return items;
}

export interface Confirm {
  title: string;
  message: string;
  button: string;
}

/** System confirms: Put to sleep and Close (D1 §9.1). Stop has none. */
export function confirmOf(id: 'sleep' | 'close', label: string): Confirm {
  return id === 'sleep'
    ? { title: `Put "${label}" to sleep?`, message: 'The agent stops. Resume wakes it with its conversation.', button: 'Put to sleep' }
    : { title: `Close "${label}"?`, message: 'It will no longer receive mail.', button: 'Close session' };
}

export const NOT_CONFIRMED_TOAST = "We couldn't confirm it — check your Mac";

export const RECONNECTING = 'Not sent — reconnecting';

/** The host's text; a call that never left the phone (`not_connected`) is "reconnecting", not a code. */
export const hostLine = (outcome: { code: string; message: string }): string =>
  outcome.code === 'not_connected' ? RECONNECTING : outcome.message.trim() === '' ? outcome.code : outcome.message;

const DONE: Record<'stop' | 'sleep' | 'close', string> = { stop: 'Stopped', sleep: 'Put to sleep', close: 'Closed' };

/** The toast after a command: the done word, or the host's text, or "couldn't confirm". */
export function commandToast(id: 'stop' | 'sleep' | 'close', outcome: SessionCommandOutcome): string {
  if (outcome.outcome === 'ok') return DONE[id];
  return outcome.outcome === 'lost' ? NOT_CONFIRMED_TOAST : hostLine(outcome);
}
