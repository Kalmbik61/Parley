/**
 * Delivery of the host's own prompts to an OpenCode session through its server API (spec 2026-11-12, 4.5, DO5, plan O7):
 * the deferred brief, the mail pointer and the limit-return text go with `POST /api/session/{id}/prompt {text}` instead of
 * being typed into the pty. The server queues a prompt while a turn runs, so this needs no screen parsing.
 *
 * The host types into the pty only when the API **definitely** did not take the prompt:
 * - the connection was refused before anything was sent (`ECONNREFUSED`), or
 * - the server answered 4xx.
 * An **ambiguous** outcome (a timeout, a reset after sending, a 5xx) is settled by reading the session's inbox and latest
 * messages: if the text is queued or present, nothing more is sent; if both lists answered without it, the API is tried
 * once more; only a server that is gone (refused) gets the text typed. A look that got no answer (a frozen server) proves
 * nothing: it is repeated a few times and never followed by a second POST, which would sit in the same socket buffers and
 * run twice on resume. A server that stays ambiguous is left alone: typing then could duplicate.
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
  /** How long a 404 (the TUI has not made the session yet) is waited out before the text is typed; and the pause between tries. */
  notYetMs?: number;
  notYetPauseMs?: number;
  /** Looks at the inbox and messages after an ambiguous answer while they give no answer; and the pause between them. */
  looks?: number;
  lookPauseMs?: number;
  now?: () => number;
}

export const OPENCODE_PROMPT_TIMEOUT_MS = 5000;
/** A 404 means the session is not on the server yet (a new TUI makes it on its first prompt): wait this long for it. */
export const OPENCODE_NOT_YET_MS = 5000;
export const OPENCODE_NOT_YET_PAUSE_MS = 400;
/**
 * A frozen server: each look can take two request timeouts (10 s). A server that never answers: the 5 s POST and two looks
 * 2 s apart, about 27 s (the old POST, look, POST, look took 30 s). The longest path: POST 5 s, an unanswered look 10 s,
 * pause 2 s, a look that finds the text absent 10 s, the retry POST 5 s, then two looks again 22 s: about 54 s.
 */
export const OPENCODE_LOOKS = 2;
export const OPENCODE_LOOK_PAUSE_MS = 2000;
/** Messages younger than the attempt (less this slack for clock differences) count as "ours" when the outcome is checked. */
const SLACK_MS = 2000;
const LATEST_MESSAGES = 20;

type PostResult = 'accepted' | 'rejected' | 'refused' | 'ambiguous' | 'not-yet';
/**
 * `absent` — both lists answered (with any status) and neither has the text; `unknown` — a list got no answer at all (a
 * timeout, a network error other than refused) and the other lacks it; `gone` — the connection was refused.
 */
type LookResult = 'present' | 'absent' | 'gone' | 'unknown';

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
/** An API delivery: `viaApi()` is true once the server itself took the prompt (not the typed fallback, not a cancel). */
export interface OpencodeAttempt extends Attempt {
  viaApi(): boolean;
}

export function sendOpencodePrompt(deps: OpencodePromptDeps, ref: SessionRef, text: string, fallback: (text: string) => Attempt): OpencodeAttempt {
  const clean = cleanMultiline(text);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OPENCODE_PROMPT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let cancelled = false;
  /** Ends the pause between looks early on `cancel()`. */
  let wakePause: (() => void) | null = null;
  let typing: Attempt | null = null;
  let accepted = false;

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
      if (response.status === 404) return 'not-yet';
      if (response.status >= 400 && response.status < 500) return 'rejected';
      return 'ambiguous';
    } catch (error) {
      // Refused: the request never left, the server did not see it. Anything else may have been sent.
      return errorCode(error) === 'ECONNREFUSED' ? 'refused' : 'ambiguous';
    }
  }

  /** The body; `null` — the server answered, but not with a readable 200; `'silent'` — no answer at all; `'gone'` — refused. */
  async function getJson(address: OpencodeAddress, url: string): Promise<unknown | 'gone' | 'silent' | null> {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: headers(address), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return errorCode(error) === 'ECONNREFUSED' ? 'gone' : 'silent';
    }
    if (response.status !== 200) return null;
    // A body that is not JSON was still an answer; a body that stopped coming (the timeout) was not.
    return response.json().catch((error: unknown) => (error instanceof SyntaxError ? null : 'silent'));
  }

  /** Is our text queued in the inbox or already among the latest messages? See `LookResult`. */
  async function present(address: OpencodeAddress, id: string): Promise<LookResult> {
    const since = startedAt - SLACK_MS;
    const fresh = (item: Record<string, unknown>): boolean => {
      const time = isObject(item['time']) ? item['time']['created'] : undefined;
      return typeof time !== 'number' || time >= since;
    };
    let known = true;
    const inbox = await getJson(address, `${base(address, id)}/inbox`);
    if (inbox === 'gone') return 'gone';
    if (inbox === 'silent') known = false;
    else if (isObject(inbox) && Array.isArray(inbox['data'])) {
      for (const item of inbox['data']) {
        if (isObject(item) && fresh(item) && isObject(item['payload']) && item['payload']['text'] === clean) return 'present';
      }
    }
    // Cancelled during the inbox read: no further request.
    if (cancelled) return 'unknown';
    const latest = await getJson(address, `${base(address, id)}/message?limit=${LATEST_MESSAGES}`);
    if (latest === 'gone') return 'gone';
    if (latest === 'silent') known = false;
    else if (isObject(latest) && Array.isArray(latest['data'])) {
      for (const item of latest['data']) {
        if (isObject(item) && item['type'] === 'user' && fresh(item) && item['text'] === clean) return 'present';
      }
    }
    return known ? 'absent' : 'unknown';
  }

  /** `present`, repeated a bounded number of times while the server gives no answer; stops on `cancel()`. */
  async function look(address: OpencodeAddress, id: string): Promise<LookResult> {
    const tries = deps.looks ?? OPENCODE_LOOKS;
    let result: LookResult = 'unknown';
    for (let attempt = 0; attempt < tries && !cancelled; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deps.lookPauseMs ?? OPENCODE_LOOK_PAUSE_MS);
          wakePause = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wakePause = null;
        if (cancelled) break;
      }
      result = await present(address, id);
      if (result !== 'unknown') break;
    }
    return result;
  }

  const type = async (reason: string): Promise<AttemptOutcome> => {
    if (cancelled) return 'cancelled';
    deps.log?.info('opencode prompt: typed into the terminal', { ref, reason });
    typing = fallback(text);
    return typing.done;
  };

  /** The server took the prompt (accepted, or found queued after an ambiguous answer). */
  const acceptedNow = (): AttemptOutcome => {
    accepted = true;
    return 'submitted';
  };

  async function run(): Promise<AttemptOutcome> {
    const id = deps.sessionId(ref);
    const first = deps.server(ref);
    // No server (never started, already stopped) or no session id: the API cannot take it.
    if (first === undefined || id === null) return type('no-server');

    let result = await post(first, id);
    // 404: the server does not know the session yet. Nothing was accepted, so asking again cannot double it; a race with
    // the TUI creating the session must not end in typing. After the wait the text is typed as for any rejection.
    if (result === 'not-yet') {
      const until = now() + (deps.notYetMs ?? OPENCODE_NOT_YET_MS);
      while (result === 'not-yet' && now() < until) {
        await new Promise((resolve) => setTimeout(resolve, deps.notYetPauseMs ?? OPENCODE_NOT_YET_PAUSE_MS));
        if (cancelled) return 'cancelled';
        const again = deps.server(ref);
        if (again === undefined) return type('server-gone');
        result = await post(again, id);
      }
      if (result === 'not-yet') return type('session-not-found');
    }
    if (cancelled) return 'cancelled';
    if (result === 'accepted') return acceptedNow();
    if (result === 'rejected' || result === 'refused') return type(result);

    // Ambiguous: did the server queue it anyway?
    const address = deps.server(ref);
    if (address === undefined) return type('server-gone');
    const seen = await look(address, id);
    if (cancelled) return 'cancelled';
    if (seen === 'present') return acceptedNow();
    if (seen === 'gone') return type('server-gone');
    // The server gave no answer: a second POST could run twice on resume. Leave it unconfirmed.
    if (seen === 'unknown') return unconfirmed();

    // Definitely not queued: one retry.
    result = await post(address, id);
    if (result === 'not-yet') return type('session-not-found');
    if (cancelled) return 'cancelled';
    if (result === 'accepted') return acceptedNow();
    if (result === 'rejected' || result === 'refused') return type(result);

    // Ambiguous again: look once more. Still nothing and the server answers: leave it, typing could double it.
    const again = await look(address, id);
    if (cancelled) return 'cancelled';
    if (again === 'present') return acceptedNow();
    if (again === 'gone') return type('server-gone');
    return unconfirmed();
  }

  function unconfirmed(): AttemptOutcome {
    deps.log?.warn('opencode prompt: the server did not confirm the prompt; nothing was typed', { ref });
    return 'cancelled';
  }

  return {
    cancel() {
      cancelled = true;
      wakePause?.();
      typing?.cancel();
    },
    viaApi: () => accepted,
    done: run(),
  };
}
