// "Continue on another provider…" (D1 §9.1, plan A38b): the sheet's rules over `sessions.switchOptions`, and the call
// behind it. No React. One `requestId` per opening of the sheet; no model or effort choice (the role's default),
// no `force` (the window only).
import type { SwitchAgentOutcome, SwitchAgentParams, SwitchOptions } from '@parley/remote-client';
import { hostLine, NOT_CONFIRMED_TOAST } from './session-menu';

export type Target = SwitchOptions['targets'][number];
export type Carry = 'handover' | 'transcript';

export const CARRY_TITLE: Record<Carry, string> = { handover: 'Hand over a summary', transcript: 'Carry the transcript' };
export const HELD_TOAST = 'Waiting for your answer — see the request on this session';
export const QUEUED_TOAST = 'Queued — starts when a slot frees on your Mac';

/** A uuid v4 for `requestId`; Hermes may have no `crypto.randomUUID`. */
export function newRequestId(random: () => number = Math.random): string {
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** The host's suggestion if it is available, else the first available target; `null` — none. */
export function defaultTarget(options: SwitchOptions): string | null {
  const ok = (id: string | null): boolean => id !== null && options.targets.some((t) => t.id === id && t.available);
  if (ok(options.suggested)) return options.suggested;
  return options.targets.find((t) => t.available)?.id ?? null;
}

/** "Carry the transcript" is offered only for a target that has it. */
export const carryChoices = (target: Target | undefined): Carry[] => (target?.transcript === true ? ['handover', 'transcript'] : ['handover']);

/** Blockers: their text, no button. */
export const canContinue = (options: SwitchOptions, target: Target | undefined): boolean => options.blockers.length === 0 && target !== undefined && target.available;

export const NO_TARGETS = 'No other provider on your Mac';
export const NOT_AVAILABLE = 'Not available';

/** Why a target is unavailable: the host sends a code (`cli | key | sign-in | error`), the phone says it in words. */
export function needsText(needs: string | null): string {
  switch (needs) {
    case 'cli':
      return 'Install or update the CLI on your Mac';
    case 'key':
      return 'Add the key on your Mac';
    case 'sign-in':
      return 'Sign in on your Mac';
    default:
      return NOT_AVAILABLE;
  }
}

const capital = (id: string): string => (id === '' ? id : id[0]!.toUpperCase() + id.slice(1));

/** "Now on Claude · usage limit": the provider the session is on, which the host leaves out of the targets. */
export function currentLine(current: SwitchOptions['current'], labelOf: (id: string) => string | null = () => null): string {
  const why = current.available ? null : current.reason === 'limit' ? 'usage limit' : current.reason === 'sign-in' ? 'signed out' : current.reason === 'provider-missing' ? 'not installed' : 'not available';
  return [`Now on ${labelOf(current.provider) ?? capital(current.provider)}`, why].filter((x): x is string => x !== null).join(' · ');
}

/** What the session keeps: only the non-empty parts. `leads` and `owns` are room ids: `roomTitle` turns them into names. */
export function keepsLines(keeps: SwitchOptions['keeps'], roomTitle: (id: string) => string = (id) => id): string[] {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const rooms = (verb: string, ids: string[]): string | null => (ids.length === 0 ? null : `${verb} ${ids.length === 1 ? 'room' : 'rooms'} ${ids.map(roomTitle).join(', ')}`);
  return [
    keeps.rooms > 0 ? plural(keeps.rooms, 'room', 'rooms') : null,
    rooms('Leads', keeps.leads),
    rooms('Owns', keeps.owns),
    keeps.children > 0 ? plural(keeps.children, 'child session', 'child sessions') : null,
    keeps.unread > 0 ? plural(keeps.unread, 'unread letter', 'unread letters') : null,
    keeps.worktree === null ? null : `Worktree ${keeps.worktree}`,
  ].filter((x): x is string => x !== null);
}

/** The line under a target: why it is unavailable, else its limits (percents rounded). */
export function targetNote(t: Target): string | null {
  if (!t.available) return needsText(t.needs);
  const parts = [
    t.limits?.fiveHour == null ? null : `5 h ${Math.round(t.limits.fiveHour.usedPercent)}%`,
    t.limits?.week == null ? null : `week ${Math.round(t.limits.week.usedPercent)}%`,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * One request id per sheet opening, kept across a lost answer: the host answers a repeated id with the same answer, so
 * "Try again" cannot switch twice. A new id only after a definite answer.
 */
export interface SwitchAttempt {
  requestId: string;
  /** The last call got no answer: the sheet stays open with target and carry frozen. */
  lost: boolean;
}

export const newAttempt = (random?: () => number): SwitchAttempt => ({ requestId: newRequestId(random), lost: false });

export const UNCONFIRMED_LINE = "We couldn't confirm it";

/** Answers that say the call may not have reached the host (or that the first switch still runs): the request id is kept. */
const INDEFINITE_CODES: ReadonlySet<string> = new Set(['timeout', 'connection_lost', 'not_connected', 'rate_limited', 'busy']);

/** `started`, `held`, `queued` or a host refusal such as `conflict` / `bad_request` — only these end the attempt. */
export function isDefinite(outcome: SwitchAgentOutcome): boolean {
  if (outcome.outcome === 'lost') return false;
  if (outcome.outcome === 'rejected') return !INDEFINITE_CODES.has(outcome.code);
  return true;
}

/**
 * After a call: a definite answer closes the sheet (toast; the next opening has a new id); anything else keeps it open and
 * frozen with the same id and says why in a line. `line` is that reason.
 */
export function switchStep(attempt: SwitchAttempt, outcome: SwitchAgentOutcome, target: Target, random?: () => number): { attempt: SwitchAttempt; close: boolean; toast: string | null; line: string | null } {
  if (!isDefinite(outcome)) return { attempt: { ...attempt, lost: true }, close: false, toast: null, line: outcome.outcome === 'rejected' ? hostLine(outcome) : UNCONFIRMED_LINE };
  return { attempt: newAttempt(random), close: true, toast: switchToast(outcome, target), line: null };
}

export function switchParams(ref: SwitchAgentParams['ref'], requestId: string, target: Target, carry: Carry): SwitchAgentParams {
  return { ref, requestId, provider: target.id, carry: carryChoices(target).includes(carry) ? carry : 'handover' };
}

/** The toast after the call; `held` and `queued` read like a launch (D1 §9.6). */
export function switchToast(outcome: SwitchAgentOutcome, target: Target): string {
  if (outcome.outcome === 'lost') return NOT_CONFIRMED_TOAST;
  if (outcome.outcome === 'rejected') return hostLine(outcome);
  return outcome.outcome === 'held' ? HELD_TOAST : outcome.outcome === 'queued' ? QUEUED_TOAST : `Continuing on ${target.label}`;
}

/** A call that got no answer outlives the sheet: reopening it shows the frozen target and "Try again" with the same id. */
export interface LostSwitch {
  attempt: SwitchAttempt;
  /** Why the sheet is frozen (the last call's reason; before an answer — "couldn't confirm"). */
  line: string;
  target: Target;
  carry: Carry;
}
const lostSwitches = new Map<string, LostSwitch>();
export const recallLost = (key: string): LostSwitch | undefined => lostSwitches.get(key);
export const rememberLost = (key: string, lost: LostSwitch): void => void lostSwitches.set(key, lost);
export const forgetLost = (key: string): void => void lostSwitches.delete(key);
/** Tests. */
export const clearLost = (): void => lostSwitches.clear();
