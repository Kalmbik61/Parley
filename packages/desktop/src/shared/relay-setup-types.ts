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

/** What the wizard changes on the person's web server (spec 8.3); `null` when it changes none. */
export interface RelayPlanWeb {
  summary: string;
  network: string | null;
  edits: Array<{
    server: string;
    file: string;
    action: 'add' | 'replace' | 'append' | 'remove' | 'remove-block';
    content: string | null;
    backup: string;
    check: string;
    reload: string;
  }>;
}

export interface RelayPlanView {
  intent: SetupIntent;
  steps: RelayPlanStepView[];
  notes: string[];
  /** Why the plan cannot be run; no «Run» then. */
  blocked: string | null;
  address: string | null;
  proxy: { snippet: string; certificateHint: string } | null;
  web: RelayPlanWeb | null;
}

export type RelaySetupPhase =
  | { phase: 'hostkey'; host: string; port: number; keyType: string; fingerprint: string }
  /** Terminal: the server's key differs from the one on record. There is no «continue anyway». */
  | { phase: 'hostkey-changed'; host: string; port: number; known: string; presented: string }
  | { phase: 'need-passphrase'; wrong: boolean }
  | { phase: 'need-sudo' }
  | { phase: 'auth-failed' }
  | { phase: 'unsupported'; os: string; manualUrl: string }
  | { phase: 'plan'; plan: RelayPlanView; os: string }
  | { phase: 'running' }
  /** Installed, but the page behind the proxy has to be set up by the person; «Check» finishes. */
  | { phase: 'proxy-pending'; address: string; snippet: string; certificateHint: string }
  | { phase: 'done'; address: string; configured: boolean }
  | { phase: 'removed'; docker: 'kept' }
  | { phase: 'failed'; step: string | null; message: string }
  /** The person cancelled (not an error). `step` is where the run stopped; `health` → «Check» tests again. */
  | { phase: 'cancelled'; step: string | null; message: string };

export interface RelaySetupCalls {
  keys: { params: Record<string, never>; result: { files: string[]; agent: boolean } };
  begin: { params: RelaySetupRequest; result: RelaySetupPhase };
  trust: { params: Record<string, never>; result: RelaySetupPhase };
  provide: { params: { passphrase?: string; sudoPassword?: string }; result: RelaySetupPhase };
  plan: { params: { removeData: boolean }; result: RelaySetupPhase };
  /** Answers at once with `{ phase: 'running' }`; the outcome arrives as a `phase` event and through `state`. */
  run: { params: { removeData: boolean }; result: RelaySetupPhase };
  check: { params: Record<string, never>; result: RelaySetupPhase };
  cancel: { params: Record<string, never>; result: null };
  /** The run record kept in main (spec 8.1), or `null`. */
  state: { params: Record<string, never>; result: RelayRunView | null };
  /** Forgets the record; refused while the run is going. */
  dismiss: { params: Record<string, never>; result: null };
}
export type RelaySetupCallName = keyof RelaySetupCalls;
export const RELAY_SETUP_CALL_NAMES: readonly RelaySetupCallName[] = ['keys', 'begin', 'trust', 'provide', 'plan', 'run', 'check', 'cancel', 'state', 'dismiss'];

/** Progress of the relay image download: layers always, bytes when the Docker Engine API reports them. */
export interface RelayPullProgress {
  layersDone: number;
  layersTotal: number;
  bytesDone: number | null;
  bytesTotal: number | null;
}

export type RelayStepStatus = 'running' | 'skipped' | 'done' | 'failed' | 'stopped';

/** What happens during a run, without the sequence number (the service numbers the events). */
export type RelaySetupEventBody =
  | { event: 'step'; id: string; title: string; status: RelayStepStatus }
  | { event: 'line'; step: string; text: string }
  | { event: 'progress'; step: string; progress: RelayPullProgress }
  /** A cancel arrived during a step that cannot be interrupted: the run stops after it. */
  | { event: 'cancelling' }
  /** The outcome of a run, and of «Check» afterwards. */
  | { event: 'phase'; phase: RelaySetupPhase };

/** Every event carries the number of the record's change it caused: `RelayRunView.seq` after it equals this. */
export type RelaySetupEvent = RelaySetupEventBody & { seq: number };

/** The run record (spec 8.1). Lives in main: a reloaded window reads it again. Holds no secrets. */
export interface RelayRunView {
  /** Number of the last applied event. One counter for the whole service: it never restarts for a new record. */
  seq: number;
  intent: SetupIntent;
  host: string;
  plan: RelayPlanView;
  /** At most 200 lines per step (the log file keeps all of them). */
  steps: Array<{ id: string; title: string; status: 'pending' | RelayStepStatus; lines: string[] }>;
  /** Of the step that is downloading now; cleared when that step ends. */
  progress: (RelayPullProgress & { step: string }) | null;
  cancelling: boolean;
  /** `{ phase: 'running' }` during the run, the outcome after it. */
  phase: RelaySetupPhase;
}

export const RELAY_MANUAL_URL = 'https://github.com/Kalmbik61/Parley/blob/master/packages/relay/README.md';
