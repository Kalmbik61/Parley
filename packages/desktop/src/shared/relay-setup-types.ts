/**
 * Relay setup wizard: types shared by main and the renderer (mobile spec 6.7, plan A18a).
 * The renderer SENDS credentials (it is the window that asks for them) and never receives them back: everything
 * below that flows to the window is plan text, step progress and server output with the run's secrets masked.
 */

export type SetupIntent = 'install' | 'rollback' | 'remove';

export type SetupAuthInput = { kind: 'key'; file: string } | { kind: 'agent' } | { kind: 'password' };

/** What the form sends. Validated in main before anything is connected (`input.ts`). */
export interface RelaySetupRequest {
  host: string;
  port: number | string;
  user: string;
  auth: SetupAuthInput;
  secrets: { password?: string; passphrase?: string; sudoPassword?: string };
  domain?: string;
  intent: SetupIntent;
}

export interface RelayPlanStepView {
  id: string;
  title: string;
  check: string | null;
  commands: string[];
}

export interface RelayPlanView {
  intent: SetupIntent;
  steps: RelayPlanStepView[];
  notes: string[];
  /** Why the plan cannot be run; no «Run» then. */
  blocked: string | null;
  address: string | null;
  proxy: { snippet: string; certificateHint: string } | null;
}

export type RelaySetupPhase =
  | { phase: 'hostkey'; host: string; port: number; keyType: string; fingerprint: string }
  /** Terminal: the server's key differs from the one on record. There is no «continue anyway». */
  | { phase: 'hostkey-changed'; host: string; port: number; known: string; presented: string }
  | { phase: 'need-passphrase' }
  | { phase: 'need-sudo' }
  | { phase: 'auth-failed' }
  | { phase: 'unsupported'; os: string; manualUrl: string }
  | { phase: 'plan'; plan: RelayPlanView; os: string }
  | { phase: 'running' }
  /** Installed, but the page behind the proxy has to be set up by the person; «Check» finishes. */
  | { phase: 'proxy-pending'; address: string; snippet: string; certificateHint: string }
  | { phase: 'done'; address: string; configured: boolean }
  | { phase: 'removed'; docker: 'kept' }
  | { phase: 'failed'; step: string | null; message: string };

export interface RelaySetupCalls {
  keys: { params: Record<string, never>; result: { files: string[]; agent: boolean } };
  begin: { params: RelaySetupRequest; result: RelaySetupPhase };
  trust: { params: Record<string, never>; result: RelaySetupPhase };
  provide: { params: { passphrase?: string; sudoPassword?: string }; result: RelaySetupPhase };
  plan: { params: { removeData: boolean }; result: RelaySetupPhase };
  run: { params: { removeData: boolean }; result: RelaySetupPhase };
  check: { params: Record<string, never>; result: RelaySetupPhase };
  cancel: { params: Record<string, never>; result: null };
}
export type RelaySetupCallName = keyof RelaySetupCalls;
export const RELAY_SETUP_CALL_NAMES: readonly RelaySetupCallName[] = ['keys', 'begin', 'trust', 'provide', 'plan', 'run', 'check', 'cancel'];

export type RelaySetupEvent =
  | { event: 'step'; id: string; title: string; status: 'running' | 'skipped' | 'done' | 'failed' }
  | { event: 'line'; step: string; text: string };

export const RELAY_MANUAL_URL = 'https://github.com/Kalmbik61/Parley/blob/master/packages/relay/README.md';
