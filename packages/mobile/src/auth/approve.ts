// Face ID gate for approvals (decision 6, spec §11.4, D1 §12a). A guard against someone else's hands on an unlocked
// phone, not an access boundary: the bridge and the host never see it. Every approval asks again — no reuse window.
import type { FeedDecision } from '@parley/core';

/** What is being approved; picks the prompt text. */
export type ApproveKind = 'allow' | 'plan' | 'accept' | 'disable' | 'launch' | 'letter';

export const PROMPTS: Record<ApproveKind, string> = {
  allow: 'Confirm to allow',
  plan: 'Confirm to approve the plan',
  accept: 'Confirm to accept the decision',
  disable: 'Confirm to turn off Face ID for approvals',
  launch: 'Confirm to start from this phone',
  letter: 'Confirm to send the message',
};

/** The slice of `expo-local-authentication` used here. */
export interface LocalAuth {
  authenticateAsync(options: {
    promptMessage: string;
    disableDeviceFallback: boolean;
    /** Face ID → "Try Again / Enter Passcode / Cancel" is the system's; nothing else of ours. */
    cancelLabel?: string;
  }): Promise<{ success: true } | { success: false; error: string }>;
}

export interface ApproveDeps {
  auth: LocalAuth;
  /** The "Require Face ID to allow" setting (default on). */
  isRequired(): boolean | Promise<boolean>;
}

/**
 * `ok`: send the call. `cancelled`: send nothing; the card stays (toast "Face ID cancelled — nothing was sent").
 * `no-passcode`: nothing was sent either, but the phone has no passcode, so the toast says how to fix it.
 */
export type ApproveResult = 'ok' | 'cancelled' | 'no-passcode';
/** Why nothing was sent. */
export type NotSent = Exclude<ApproveResult, 'ok'>;
export type Approve = (kind: ApproveKind) => Promise<ApproveResult>;

/**
 * Not enrolled needs no branch: `disableDeviceFallback: false` makes iOS go straight to the device passcode, and
 * its success counts as Face ID success. A failure of any kind (cancel, lockout, no passcode set) sends nothing.
 * Turning the setting off always asks, whatever the setting says.
 */
export function createApprove({ auth, isRequired }: ApproveDeps): Approve {
  return async (kind) => {
    if (kind !== 'disable' && !(await isRequired())) return 'ok';
    try {
      const res = await auth.authenticateAsync({ promptMessage: PROMPTS[kind], disableDeviceFallback: false });
      if (res.success) return 'ok';
      return res.error === 'passcode_not_set' || res.error === 'not_available' ? 'no-passcode' : 'cancelled';
    } catch {
      return 'cancelled';
    }
  };
}

/** Which approval a `feed.decide` decision needs: Allow (also "Always") and every plan approval; nothing else. */
export function approvalFor(decision: FeedDecision): ApproveKind | null {
  if (decision.kind === 'permission') return decision.behavior === 'allow' ? 'allow' : null;
  if (decision.kind === 'plan') return 'plan';
  return null;
}
