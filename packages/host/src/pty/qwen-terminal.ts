/**
 * Qwen Code program status from its terminal stream (spec 2026-11-11, 3.4, amendment 2026-11-11): OSC 7501,
 * `ESC ] 7501 ; state=<state>[:kind=<kind>]:app=qwen-code[:msg=<base64>] ST`. Observed with qwen 0.27.2: `state=idle`
 * at a ready prompt and `state=blocked:kind=auth` under the "Connect a Provider" picker; the CLI also writes `working`,
 * `blocked` with `kind=permission|question`, `error` and `clear`.
 *
 * Reports drive readiness and native prompt detection. The transcript supplies conversation history.
 * The stream is parsed by the host, which owns the pty, with the same chunk-safe OSC reader as Codex.
 */

import { createOscReader } from './codex-terminal.js';
import { programStatusOf, type ProgramStatusReport } from './program-status.js';

/** One Qwen OSC 7501 report. Only recognized root states are forwarded. */
export interface QwenStatus {
  state: string;
  /** Only with `state=blocked`: `auth`, `permission`, `question`… */
  kind: string | null;
  /** Decoded `msg`; `null` when absent or unreadable. */
  msg: string | null;
}

export interface QwenTerminalParser {
  /** Parses the next chunk; reports in stream order. Never throws. */
  feed(chunk: string): QwenStatus[];
}

export function qwenStatusOf(body: string): QwenStatus | null {
  const report = programStatusOf(body, 'qwen-code');
  return report === null ? null : qwenStatusFromReport(report);
}

/** Preserve Qwen's message and kind for its existing readiness and prompt consumers only. */
export function qwenStatusFromReport({ status, fields }: ProgramStatusReport): QwenStatus {
  const state = status?.state ?? 'clear';
  let msg: string | null = null;
  const encoded = fields.get('msg');
  if (encoded !== undefined) {
    try {
      msg = Buffer.from(encoded, 'base64').toString('utf8') || null;
    } catch {
      msg = null;
    }
  }
  return { state, kind: state === 'blocked' ? (fields.get('kind') ?? null) : null, msg };
}

export function createQwenTerminalParser(): QwenTerminalParser {
  return createOscReader(qwenStatusOf);
}
