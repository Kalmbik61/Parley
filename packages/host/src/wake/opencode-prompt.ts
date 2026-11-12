/**
 * Delivery of the host's own prompts to an OpenCode session through its server API (spec 2026-11-12, 4.5, DO5, plan O7):
 * the deferred brief, the mail pointer and the limit-return text go with `POST /api/session/{id}/prompt {text}` instead of
 * being typed into the pty. The server queues a prompt while a turn runs, so this needs no screen parsing.
 *
 * The host types into the pty only when the API **definitely** did not take the prompt:
 * - the connection was refused before anything was sent (`ECONNREFUSED`), or
 * - the server answered 4xx.
 * An **ambiguous** outcome (a timeout, a reset after sending, a 5xx) is settled by reading the session's inbox and latest
 * messages: if the text is queued or present, nothing more is sent; otherwise the API is tried once more; only a server
 * that is gone (refused) gets the text typed. A server that stays ambiguous is left alone: typing then could duplicate.
 *
 * The password is only used in the request header; nothing here logs it or the address.
 */

import { cleanMultiline } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { OpencodeAddress } from '../feed/opencode-source.js';
import type { Log } from '../log.js';
import type { Attempt, AttemptOutcome } from '../pty/type-and-submit.js';

export interface OpencodePromptDeps {
  server(ref: SessionRef): OpencodeAddress | undefined;
  /** The OpenCode session id Parley gave the session (`ses_<uuid>`); `null` before the first launch. */
  sessionId(ref: SessionRef): string | null;
  log?: Pick<Log, 'warn' | 'info'>;
  fetchImpl?: typeof fetch;
  /** Per request; a slower answer is ambiguous. */
  timeoutMs?: number;
  now?: () => number;
}

export const OPENCODE_PROMPT_TIMEOUT_MS = 5000;
/** Messages younger than the attempt (less this slack for clock differences) count as "ours" when the outcome is checked. */
const SLACK_MS = 2000;
const LATEST_MESSAGES = 20;

type PostResult = 'accepted' | 'rejected' | 'refused' | 'ambiguous';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function errorCode(error: unknown): string | null {
  if (!isObject(error)) return null;
  const cause = error['cause'];
  if (isObject(cause) && typeof cause['code'] === 'string') return cause['code'];
  return typeof error['code'] === 'string' ? error['code'] : null;
}

/**
 * Sends `text` to the session's server. `fallback` types the text into the pty (the host's usual typing); it is called
 * at most once, only when the API definitely did not take the prompt or the server is gone.
 */
export function sendOpencodePrompt(deps: OpencodePromptDeps, ref: SessionRef, text: string, fallback: (text: string) => Attempt): Attempt {
  const clean = cleanMultiline(text);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OPENCODE_PROMPT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let cancelled = false;
  let typing: Attempt | null = null;

  const headers = (address: OpencodeAddress): Record<string, string> => ({
    authorization: `Basic ${Buffer.from(`opencode:${address.password}`).toString('base64')}`,
    accept: 'application/json',
  });
  const base = (address: OpencodeAddress, id: string): string => `${address.url}/api/session/${encodeURIComponent(id)}`;

  async function post(address: OpencodeAddress, id: string): Promise<PostResult> {
    try {
      const response = await fetchImpl(`${base(address, id)}/prompt`, {
        method: 'POST',
        headers: { ...headers(address), 'content-type': 'application/json' },
        body: JSON.stringify({ text: clean }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) return 'accepted';
      if (response.status >= 400 && response.status < 500) return 'rejected';
      return 'ambiguous';
    } catch (error) {
      // Refused: the request never left, the server did not see it. Anything else may have been sent.
      return errorCode(error) === 'ECONNREFUSED' ? 'refused' : 'ambiguous';
    }
  }

  async function getJson(address: OpencodeAddress, url: string): Promise<unknown | 'gone' | null> {
    try {
      const response = await fetchImpl(url, { headers: headers(address), signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) return null;
      return await response.json();
    } catch (error) {
      return errorCode(error) === 'ECONNREFUSED' ? 'gone' : null;
    }
  }

  /** Is our text queued in the inbox or already among the latest messages? `'gone'` — the server does not answer at all. */
  async function present(address: OpencodeAddress, id: string): Promise<boolean | 'gone'> {
    const since = startedAt - SLACK_MS;
    const fresh = (item: Record<string, unknown>): boolean => {
      const time = isObject(item['time']) ? item['time']['created'] : undefined;
      return typeof time !== 'number' || time >= since;
    };
    const inbox = await getJson(address, `${base(address, id)}/inbox`);
    if (inbox === 'gone') return 'gone';
    if (isObject(inbox) && Array.isArray(inbox['data'])) {
      for (const item of inbox['data']) {
        if (isObject(item) && fresh(item) && isObject(item['payload']) && item['payload']['text'] === clean) return true;
      }
    }
    const latest = await getJson(address, `${base(address, id)}/message?limit=${LATEST_MESSAGES}`);
    if (latest === 'gone') return 'gone';
    if (isObject(latest) && Array.isArray(latest['data'])) {
      for (const item of latest['data']) {
        if (isObject(item) && item['type'] === 'user' && fresh(item) && item['text'] === clean) return true;
      }
    }
    return false;
  }

  const type = async (reason: string): Promise<AttemptOutcome> => {
    if (cancelled) return 'cancelled';
    deps.log?.info('opencode prompt: typed into the terminal', { ref, reason });
    typing = fallback(text);
    return typing.done;
  };

  async function run(): Promise<AttemptOutcome> {
    const id = deps.sessionId(ref);
    const first = deps.server(ref);
    // No server (never started, already stopped) or no session id: the API cannot take it.
    if (first === undefined || id === null) return type('no-server');

    let result = await post(first, id);
    if (cancelled) return 'cancelled';
    if (result === 'accepted') return 'submitted';
    if (result === 'rejected' || result === 'refused') return type(result);

    // Ambiguous: did the server queue it anyway?
    const address = deps.server(ref);
    if (address === undefined) return type('server-gone');
    const seen = await present(address, id);
    if (cancelled) return 'cancelled';
    if (seen === true) return 'submitted';
    if (seen === 'gone') return type('server-gone');

    // Not queued: one retry.
    result = await post(address, id);
    if (cancelled) return 'cancelled';
    if (result === 'accepted') return 'submitted';
    if (result === 'rejected' || result === 'refused') return type(result);

    // Ambiguous again: look once more. Still nothing and the server answers: leave it, typing could double it.
    const again = await present(address, id);
    if (cancelled) return 'cancelled';
    if (again === true) return 'submitted';
    if (again === 'gone') return type('server-gone');
    deps.log?.warn('opencode prompt: the server did not confirm the prompt; nothing was typed', { ref });
    return 'cancelled';
  }

  return {
    cancel() {
      cancelled = true;
      typing?.cancel();
    },
    done: run(),
  };
}
