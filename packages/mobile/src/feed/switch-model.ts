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

/** What the session keeps: only the non-empty parts. */
export function keepsLines(keeps: SwitchOptions['keeps']): string[] {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    keeps.rooms > 0 ? plural(keeps.rooms, 'room', 'rooms') : null,
    keeps.leads.length > 0 ? `Leads ${keeps.leads.join(', ')}` : null,
    keeps.owns.length > 0 ? `Owns ${keeps.owns.join(', ')}` : null,
    keeps.children > 0 ? plural(keeps.children, 'child session', 'child sessions') : null,
    keeps.unread > 0 ? plural(keeps.unread, 'unread letter', 'unread letters') : null,
    keeps.worktree === null ? null : `Worktree ${keeps.worktree}`,
  ].filter((x): x is string => x !== null);
}

/** The line under a target: why it is unavailable, else its limits. */
export function targetNote(t: Target): string | null {
  if (!t.available) return t.needs;
  const parts = [t.limits?.fiveHour == null ? null : `5 h ${t.limits.fiveHour.usedPercent}%`, t.limits?.week == null ? null : `week ${t.limits.week.usedPercent}%`].filter((x): x is string => x !== null);
  return parts.length === 0 ? null : parts.join(' · ');
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
