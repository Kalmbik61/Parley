/**
 * Creates the OpenCode session of a NEW Parley session on its server before the TUI starts (spec 2026-11-12, 4.5).
 * The TUI makes the session only on its first prompt (`-s ses_… ` names it), so until then
 * `POST /api/session/{id}/prompt` answers 404 SessionNotFound and the brief could only be typed. `POST /api/session {id}`
 * makes it up front. A failure is logged without the address and the password and the launch goes on: the brief then
 * waits for the session (`sendOpencodePrompt`) and falls back to typing, as before.
 */

import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';

export const OPENCODE_CREATE_TIMEOUT_MS = 5000;

export interface OpencodeCreateTarget {
  url: string;
  password: string;
}

/** `true` — the session exists on the server now (created, or it already was: 409). Never throws. */
export async function createOpencodeSession(
  server: OpencodeCreateTarget,
  sessionId: string,
  ref: SessionRef,
  log: Pick<Log, 'warn'>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = OPENCODE_CREATE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${server.url}/api/session`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: sessionId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok || response.status === 409) return true;
    log.warn('opencode session was not created before the TUI; the brief will wait for it', { ref, reason: `http ${response.status}` });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    log.warn('opencode session was not created before the TUI; the brief will wait for it', {
      ref,
      reason: typeof code === 'string' ? code : (error as Error).name,
    });
  }
  return false;
}
