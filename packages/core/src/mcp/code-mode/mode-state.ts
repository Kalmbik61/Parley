// What a session is running, as far as Parley's own files say (plan T12a, Delta 2; human m-6892). One source for the indicator and `get_map`:
// the launch decision and the exposure record, through `exposureStatus`. Display only: nothing here decides, grants or writes. A read never
// throws: a file that cannot be read makes the answer `unknown`, and the session and its launch go on as they were.

import { readExposureRecord } from './exposure-record.js';
import { exposureStatus, readLaunchDecision } from './launch-decision.js';

/**
 * Why a launch is classic, or why its state is unknown: a closed list, so a label never carries free text. One short sentence each, for a
 * tooltip or an accessible name. A reason the launcher writes that is not here shows as `unknown`, never raw.
 */
export const CODE_MODE_REASONS = Object.freeze({
  'confined-attempt': 'This session runs in a confined workspace, which Code Mode does not support yet.',
  'not-parley-launched': 'This session was not launched by Parley with its agent channel.',
  'provider-unproven': "Code Mode is not yet proven for this session's provider.",
  'client-version': 'The agent client version has not been reviewed for Code Mode.',
  'instructions-undeliverable': 'This launch cannot carry the Code Mode instructions.',
  'helper-unavailable': 'The Code Mode sandbox is not available in this installation.',
  registry: 'The tool list does not match what this build can move to Code Mode.',
  detector: 'A rule or hook that targets Parley tools is set for this session.',
  'uninspected-source': 'A settings or hook source for this session could not be inspected.',
  role: "This session's role names an operation Code Mode would route differently.",
  playbook: "This session's playbook names an operation Code Mode would route differently.",
  skills: 'An installed skill names an operation Code Mode would route differently.',
  'held-run': 'An earlier Code Mode run in this session may still be finishing or was not accounted for.',
  'not-requested': 'Code Mode is turned off in Parley settings.',
  'decision-write-failed': 'Parley could not record the launch decision.',
  failed: 'Code Mode was asked for, but its server did not start.',
  unconfirmed: 'Code Mode was asked for, but its server has not confirmed it yet.',
} as const);

export type CodeModeReason = keyof typeof CODE_MODE_REASONS;

export type CodeModeMode = 'code-mode' | 'classic' | 'unknown';

export interface CodeModeState {
  readonly mode: CodeModeMode;
  /** One of `CODE_MODE_REASONS`, or null. Never free text. */
  readonly reason: CodeModeReason | null;
}

const UNKNOWN: CodeModeState = Object.freeze({ mode: 'unknown', reason: null });

/** `uninspected-source:<class>` names its class for the decision file; the label shows the class-free reason. */
function knownReason(raw: string | null): CodeModeReason | null {
  if (raw === null) return null;
  const head = /^uninspected-source:[a-z0-9]+(-[a-z0-9]+)*$/.test(raw) ? 'uninspected-source' : raw;
  return Object.hasOwn(CODE_MODE_REASONS, head) ? (head as CodeModeReason) : null;
}

/**
 * The state of a session's current launch:
 * - no decision, or one that is torn, untrusted or not understood: `unknown`;
 * - classic, by the launcher: `classic` with its reason, `unknown` when that reason is not one of ours;
 * - replacement, and this launch's server recorded replacement: `code-mode`;
 * - replacement, and this launch's server recorded failure: `unknown` with `failed`: the process exited, so nothing says what runs;
 * - replacement with no record of this launch yet: `unknown` with `unconfirmed`.
 */
export function codeModeStateOf(workDir: string, sessionId: string): CodeModeState {
  try {
    const read = readLaunchDecision(workDir, sessionId);
    if (read.kind !== 'decision') return UNKNOWN;
    const { decision } = read;
    if (decision.effective === 'classic') {
      const reason = knownReason(decision.reason);
      return reason === null ? UNKNOWN : Object.freeze({ mode: 'classic', reason });
    }
    const status = exposureStatus(decision, readExposureRecord(workDir, sessionId));
    if (status.status === 'ok') return Object.freeze({ mode: 'code-mode', reason: null });
    if (status.status === 'failed') return Object.freeze({ mode: 'unknown', reason: 'failed' });
    return Object.freeze({ mode: 'unknown', reason: 'unconfirmed' });
  } catch {
    return UNKNOWN;
  }
}
