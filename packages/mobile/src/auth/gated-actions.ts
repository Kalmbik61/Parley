// Actions behind the gate. Cancel or failure sends nothing: the card stays as it was.
import type { FeedDecision } from '@parley/core';
import type { DecideOutcome, RemoteClient, ResolveOutcome, ResolveProposalParams, SessionRef } from '@parley/remote-client';
import { approvalFor, type Approve } from './approve';

export type Gated<T> = { cancelled: true } | { cancelled: false; outcome: T };

/** `feed.decide`: Face ID only for Allow (also "Always") and plan approval; Deny, answers, plan rejection do not ask. */
export async function gatedDecide(
  client: Pick<RemoteClient, 'decide'>,
  approve: Approve,
  ref: SessionRef,
  cardId: string,
  decision: FeedDecision,
): Promise<Gated<DecideOutcome>> {
  const kind = approvalFor(decision);
  if (kind !== null && (await approve(kind)) !== 'ok') return { cancelled: true };
  return { cancelled: false, outcome: await client.decide(ref, cardId, decision) };
}

/** `rooms.resolveProposal`: Face ID for `accept` only; Return for rework never asks. Goes with the shown `rev`. */
export async function gatedResolve(
  client: Pick<RemoteClient, 'resolveProposal'>,
  approve: Approve,
  params: ResolveProposalParams,
): Promise<Gated<ResolveOutcome>> {
  if (params.action === 'accept' && (await approve('accept')) !== 'ok') return { cancelled: true };
  return { cancelled: false, outcome: await client.resolveProposal(params) };
}
