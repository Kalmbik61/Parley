/**
 * Source of the OpenCode Chat feed (spec 2026-11-12, 4.11): the messages of one session, read from the session's own
 * `opencode serve` over its loopback API, and Parley's durable copy of them in `<work>/opencode/<session>.json`.
 *
 * - `fetchOpencodeMessages` reads ALL pages (the API is newest first and pages through `cursor.next`);
 * - the cache is capped at `OPENCODE_CACHE_MAX_BYTES`; when the list does not fit, the oldest messages are dropped;
 * - the server password is only ever used in the request header: it is not logged and not written anywhere.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';

/** Where a session's server answers; the supervisor owns both values. */
export interface OpencodeAddress {
  url: string;
  password: string;
}

/** Messages asked per page. */
export const OPENCODE_PAGE_LIMIT = 200;
/** A session longer than this many pages is read as far as that and no further (a broken cursor cannot loop). */
export const OPENCODE_MAX_PAGES = 100;
export const OPENCODE_FETCH_TIMEOUT_MS = 3000;
export const OPENCODE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface OpencodeMessages {
  /** Newest first, as the API gives them. */
  messages: unknown[];
  /** Fingerprint of the raw answers: equal digests mean nothing changed since the last poll. */
  digest: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * All messages of a session. `null` — the server did not answer, refused, or answered something else (the caller keeps
 * what it has). A page shorter than the limit, an empty page, a repeated cursor or `OPENCODE_MAX_PAGES` ends the read.
 */
export async function fetchOpencodeMessages(
  address: OpencodeAddress,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = OPENCODE_FETCH_TIMEOUT_MS,
): Promise<OpencodeMessages | null> {
  const authorization = `Basic ${Buffer.from(`opencode:${address.password}`).toString('base64')}`;
  const hash = createHash('sha256');
  const messages: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < OPENCODE_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(OPENCODE_PAGE_LIMIT) });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await fetchImpl(`${address.url}/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`, {
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return null;
      const text = await response.text();
      hash.update(text);
      const body: unknown = JSON.parse(text);
      const data = isObject(body) ? body['data'] : undefined;
      if (!Array.isArray(data)) return null;
      messages.push(...data);
      const next: unknown = isObject(body) && isObject(body['cursor']) ? body['cursor']['next'] : undefined;
      if (data.length < OPENCODE_PAGE_LIMIT || typeof next !== 'string' || next === '' || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
  } catch {
    return null;
  }
  return { messages, digest: hash.digest('hex') };
}

/** `<work>/opencode/<session>.json` (Parley's own cache; never OpenCode's database). */
export function opencodeCacheFile(ref: SessionRef): string {
  return path.join(workPaths(ref.projectPath, ref.workId).dir, 'opencode', `${ref.sessionId}.json`);
}

/**
 * Stores the messages (newest first) atomically. Over the cap, the oldest messages go first. `dropped` counts them.
 * Throws on a write failure; the caller logs it and goes on.
 */
export async function writeOpencodeCache(
  ref: SessionRef,
  messages: readonly unknown[],
  at: number,
  maxBytes = OPENCODE_CACHE_MAX_BYTES,
): Promise<{ bytes: number; dropped: number }> {
  const encode = (list: readonly unknown[]): string => JSON.stringify({ version: 1, savedAt: new Date(at).toISOString(), messages: list });
  let text = encode(messages);
  let kept = messages.length;
  if (Buffer.byteLength(text) > maxBytes) {
    // Binary search for the longest newest-first prefix that fits.
    let low = 0;
    let high = messages.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(encode(messages.slice(0, middle))) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    kept = low;
    text = encode(messages.slice(0, kept));
  }
  const file = opencodeCacheFile(ref);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { bytes: Buffer.byteLength(text), dropped: messages.length - kept };
}

/** The cached messages (newest first); `null` — no cache, or one that is not ours. */
export async function readOpencodeCache(ref: SessionRef): Promise<unknown[] | null> {
  try {
    const data: unknown = JSON.parse(await readFile(opencodeCacheFile(ref), 'utf8'));
    return isObject(data) && data['version'] === 1 && Array.isArray(data['messages']) ? data['messages'] : null;
  } catch {
    return null;
  }
}
