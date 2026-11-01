// Consent cards (D1 §7.3): folder trust and provider switch. Words follow the window's `shared/strings.ts`.
// The app lock replaced Face ID on single actions. No React.
import type { ConsentCard, FolderTrustCard } from '@parley/protocol';
import type { DecideConsentOutcome, RemoteClient } from '@parley/remote-client';

export const TRUST_BODY =
  "Codex in this folder and its worktrees starts without its own trust screen, gets write access to the working folder (workspace-write) and runs the repository's own .codex/ configuration — config, hooks, rules and MCP servers. The consent lasts until you revoke it in Settings → Projects. For Claude Code nothing changes yet.";
export const TRUST_LINE = "Agents start here without the terminal's trust screen and can change files in this folder.";

export const folderName = (folder: string): string => folder.split('/').filter((p) => p !== '').at(-1) ?? folder;

export function trustTitle(card: FolderTrustCard): string {
  return `Trust ${folderName(card.folder)} for agents?`;
}

const VIA: Record<FolderTrustCard['requestedBy']['source'], string> = { agent: 'create_session', resume: 'resume', launch: 'launch' };

export function trustRequestedBy(card: FolderTrustCard): string {
  const by = card.requestedBy;
  if (by.label === undefined || by.label === '') return 'Requested by a launch on your Mac';
  return `Requested by ${by.label} · ${VIA[by.source]}`;
}

export function switchText(who: string, target: string, provider: string, reason: string): string {
  return `${who} asks to continue ${target} on ${provider}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Allow stops ${target} now and continues it there.`;
}

/** Cards shown in Inbox: pending ones, newest first (by `at`). */
export function pendingConsents(items: readonly ConsentCard[]): ConsentCard[] {
  return items.filter((c) => c.state === 'pending').sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export type ConsentUi =
  | { kind: 'allowed'; text: string }
  | { kind: 'denied'; text: string }
  | { kind: 'already-answered' }
  | { kind: 'no-longer-pending' }
  | { kind: 'unconfirmed' }
  | { kind: 'error'; text: string };

export const CONSENT_TEXT = {
  'already-answered': 'Already answered at your Mac',
  'no-longer-pending': 'This request is no longer pending',
  unconfirmed: "We couldn't confirm your answer",
} as const;

export function allowedText(card: ConsentCard): string {
  return card.kind === 'folder-trust' ? 'Allowed — the agent starts now' : `Allowed — continuing on ${card.providerLabel}`;
}

function uiOf(card: ConsentCard, decision: 'allow' | 'deny', o: DecideConsentOutcome): ConsentUi {
  switch (o.outcome) {
    case 'applied':
      return decision === 'allow' ? { kind: 'allowed', text: allowedText(card) } : { kind: 'denied', text: 'Denied' };
    case 'stale':
      return { kind: 'already-answered' };
    case 'lost':
      return o.stillPending === false ? { kind: 'no-longer-pending' } : { kind: 'unconfirmed' };
    case 'rejected':
      return { kind: 'error', text: o.message.trim() === '' ? o.code : o.message };
  }
}

/** One decision. Never retried. */
export async function runConsent(
  client: Pick<RemoteClient, 'decideConsent'>,
  card: ConsentCard,
  decision: 'allow' | 'deny',
): Promise<ConsentUi> {
  return uiOf(card, decision, await client.decideConsent(card.id, decision));
}
