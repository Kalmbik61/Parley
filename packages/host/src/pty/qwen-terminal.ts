/**
 * Qwen Code program status from its terminal stream (spec 2026-11-11, 3.4, amendment 2026-11-11): OSC 7501,
 * `ESC ] 7501 ; state=<state>[:kind=<kind>]:app=qwen-code[:msg=<base64>] ST`. Observed with qwen 0.27.2: `state=idle`
 * at a ready prompt and `state=blocked:kind=auth` under the "Connect a Provider" picker; the CLI also writes `working`,
 * `blocked` with `kind=permission|question`, `error` and `clear`.
 *
 * Only readiness and the startup screens are read from it: the turn state, Chat and the journal stay with the hooks.
 * The stream is parsed by the host, which owns the pty, with the same chunk-safe OSC reader as Codex.
 */

import { createOscReader } from './codex-terminal.js';

/** One OSC 7501 report. `state` and `kind` are kept as written: an unknown value changes nothing downstream. */
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

const PROGRAM_STATUS = '7501;';

/** OSC body → status; `null` — another OSC, another app or no state. */
export function qwenStatusOf(body: string): QwenStatus | null {
  if (!body.startsWith(PROGRAM_STATUS)) return null;
  const fields = new Map<string, string>();
  for (const pair of body.slice(PROGRAM_STATUS.length).split(':')) {
    const at = pair.indexOf('=');
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const state = fields.get('state');
  if (state === undefined || state === '') return null;
  // `state=clear` carries no app; every other report names it.
  if (state !== 'clear' && fields.get('app') !== 'qwen-code') return null;
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
