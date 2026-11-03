// Consent cards (D1 §7.3): folder trust and provider switch. Words follow the window's `shared/strings.ts`.
// The app lock replaced Face ID on single actions. No React.
import type { ConsentCard, FolderTrustCard, ProjectMcpCard } from '@parley/protocol';
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

/** The only card shape (spec 2026-11-02, 7.2) the app draws; a card without `version` or with another one is answered at the Mac. */
export const PROJECT_MCP_VERSION = 1;
export const projectMcpDrawable = (card: ProjectMcpCard): boolean => (card as { version?: unknown }).version === PROJECT_MCP_VERSION;
export const MCP_CHANGED = 'The server list changed — review again';
export const MCP_AT_MAC = 'Answer at your Mac';

export function mcpTitle(card: ProjectMcpCard): string {
  return `Enable MCP servers for ${folderName(card.repo)}?`;
}

/** The `{name, fingerprint}` pairs of the servers the human switched on, in the card's order; a name not in the card is dropped. */
export function enabledPairs(card: ProjectMcpCard, on: ReadonlySet<string>): Array<{ name: string; fingerprint: string }> {
  return card.servers.filter((s) => on.has(s.name)).map((s) => ({ name: s.name, fingerprint: s.fingerprint }));
}

/** A change of the list (a name or a fingerprint) resets the switches: they were set for another card. */
export const mcpShapeKey = (card: ProjectMcpCard): string => `${card.revision}\n` + card.servers.map((s) => `${s.name}\0${s.fingerprint}`).join('\n');

export function switchText(who: string, target: string, provider: string, reason: string): string {
  return `${who} asks to continue ${target} on ${provider}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Allow stops ${target} now and continues it there.`;
}

/** Cards shown in Inbox: pending ones, newest first (by `at`). */
export function pendingConsents(items: readonly ConsentCard[]): ConsentCard[] {
  return items.filter((c) => c.state === 'pending').sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** `consents.decide` is in the bridge hello; an unknown hello (`null`) lets the buttons show until it arrives. */
export const canDecideConsent = (methods: readonly string[] | null): boolean => methods === null || methods.includes('consents.decide');

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

export function allowedText(card: ConsentCard, enabled = 0): string {
  switch (card.kind) {
    case 'folder-trust':
      return 'Allowed — the agent starts now';
    case 'project-mcp':
      return enabled === 0 ? 'No servers enabled — the agent starts now' : `Enabled ${enabled} ${enabled === 1 ? 'server' : 'servers'} — the agent starts now`;
    case 'agent-switch':
      return `Allowed — continuing on ${card.providerLabel}`;
  }
}

function uiOf(card: ConsentCard, decision: 'allow' | 'deny', o: DecideConsentOutcome, enabled: number): ConsentUi {
  switch (o.outcome) {
    case 'applied':
      return decision === 'allow' ? { kind: 'allowed', text: allowedText(card, enabled) } : { kind: 'denied', text: card.kind === 'project-mcp' ? 'Rejected — no servers enabled' : 'Denied' };
    case 'stale':
      return { kind: 'already-answered' };
    case 'lost':
      return o.stillPending === false ? { kind: 'no-longer-pending' } : { kind: 'unconfirmed' };
    case 'rejected':
      // `bad_request` on a project-mcp card: the list changed under the human; the client has re-read the card.
      if (card.kind === 'project-mcp' && o.code === 'bad_request') return { kind: 'error', text: MCP_CHANGED };
      return { kind: 'error', text: o.message.trim() === '' ? o.code : o.message };
  }
}

/** One decision. Never retried. */
export async function runConsent(
  client: Pick<RemoteClient, 'decideConsent'>,
  card: ConsentCard,
  decision: 'allow' | 'deny',
  /** `project-mcp` + `allow`: the pairs of the servers switched on. */
  enabled?: ReadonlyArray<{ name: string; fingerprint: string }>,
): Promise<ConsentUi> {
  if (card.kind !== 'project-mcp') return uiOf(card, decision, await client.decideConsent(card.id, decision), 0);
  // The card's `revision` goes with both answers; the host refuses a stale one with `bad_request`.
  const pairs = decision === 'allow' ? (enabled ?? []) : undefined;
  const outcome = await client.decideConsent(card.id, decision, { ...(pairs === undefined ? {} : { enabled: pairs }), revision: card.revision });
  return uiOf(card, decision, outcome, pairs?.length ?? 0);
}

/** Whether a pending card belongs on this session's screen: a provider switch of this session, or a project-MCP request of the same
 *  work in the same project (a phone "New session" has no requester sessionId; ids repeat across projects, so the project is always checked). */
export function cardBelongsToSession(card: ConsentCard, ref: { projectPath: string; workId: string; sessionId: string }): boolean {
  if (card.kind === 'agent-switch') return card.ref.projectPath === ref.projectPath && card.ref.sessionId === ref.sessionId && card.ref.workId === ref.workId;
  // Project MCP (Claude) and folder trust (Codex) hold a launch of the work: same project, same work.
  if (card.kind !== 'project-mcp' && card.kind !== 'folder-trust') return false;
  return card.projectPath === ref.projectPath && card.requestedBy.workId === ref.workId;
}
