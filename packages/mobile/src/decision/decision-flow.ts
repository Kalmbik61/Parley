// Decision screen logic (D1 §10.1), React-free. The card is what was shown (`shown`, with its `rev`); both actions go
// with that `rev`. A `conflict` swaps in the new text and does NOT re-apply the tap; the human decides again.
import type { RemoteRoom } from '@parley/protocol/remote';
import type { RemoteClient, ResolveProposalParams } from '@parley/remote-client';

export type Proposal = NonNullable<RemoteRoom['proposal']>;

export const RETURN_NOTE_MAX = 4000;

export type DecisionView =
  | { kind: 'pending'; shown: Proposal; conflict: boolean }
  | { kind: 'accepted' | 'returned' }
  /** Answered at the Mac (or never existed): no buttons. */
  | { kind: 'gone' }
  /** The answer went out but its outcome is unknown and the card is still (or not known to be) pending. */
  | { kind: 'unconfirmed'; shown: Proposal };

export type SubmitResult =
  | { kind: 'view'; view: DecisionView }
  | { kind: 'rejected'; message: string };

export const canSendReturn = (note: string): boolean => note.trim().length > 0 && note.length <= RETURN_NOTE_MAX;

export interface SubmitInput {
  projectPath: string;
  workId: string;
  roomId: string;
  shown: Proposal;
  action: 'accept' | 'return';
  note?: string;
}

/** One tap. The call is never repeated here. */
export async function submitDecision(
  client: Pick<RemoteClient, 'resolveProposal'>,
  input: SubmitInput,
): Promise<SubmitResult> {
  const { shown, action } = input;
  const params: ResolveProposalParams = {
    projectPath: input.projectPath,
    workId: input.workId,
    roomId: input.roomId,
    proposalId: shown.id,
    rev: shown.rev,
    action,
    ...(action === 'return' && input.note !== undefined ? { note: input.note } : {}),
  };
  let res;
  try {
    res = await client.resolveProposal(params);
  } catch (error) {
    return { kind: 'rejected', message: error instanceof Error ? error.message : 'request failed' };
  }
  const o = res;
  switch (o.outcome) {
    case 'applied':
      return { kind: 'view', view: { kind: action === 'accept' ? 'accepted' : 'returned' } };
    case 'stale':
      return { kind: 'view', view: { kind: 'gone' } };
    case 'conflict':
      return {
        kind: 'view',
        view: o.proposal === null ? { kind: 'gone' } : { kind: 'pending', shown: o.proposal, conflict: true },
      };
    case 'lost':
      return { kind: 'view', view: o.stillPending === false ? { kind: 'gone' } : { kind: 'unconfirmed', shown } };
  }
}

/** Haptic of D1 §16 for the result of a tap. */
export function hapticFor(result: SubmitResult): 'success' | 'warning' | null {
  if (result.kind === 'rejected') return 'warning';
  switch (result.view.kind) {
    case 'accepted':
      return 'success';
    default:
      return 'warning';
  }
}
