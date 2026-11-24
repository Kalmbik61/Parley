/** OpenCode message source: all pages, the digest, the cache and its cap (spec 2026-11-12, 4.11). */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import {
  OPENCODE_CACHE_MAX_BYTES,
  OPENCODE_PAGE_LIMIT,
  fetchOpencodeMessages,
  opencodeCacheFile,
  readOpencodeCache,
  writeOpencodeCache,
} from './opencode-source.js';

const PASSWORD = 'lab-secret-not-real';
let dir = '';
let ref: SessionRef;
let server: Server | undefined;
const requests: Array<{ url: string; authorization: string | undefined }> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'opencode-source-'));
  ref = { projectPath: dir, workId: 'w-1', sessionId: 's-1' };
  requests.length = 0;
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A fake `opencode serve`: `total` messages, newest first, paged by an opaque cursor that holds the offset. */
async function serve(total: number, status = 200): Promise<{ url: string; password: string }> {
  const all = Array.from({ length: total }, (_, index) => ({ id: `msg_${String(total - index).padStart(6, '0')}`, type: 'idle' }));
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (status !== 200) return void res.writeHead(status).end();
    const url = new URL(req.url ?? '', 'http://x');
    const offset = url.searchParams.has('cursor') ? Number(Buffer.from(url.searchParams.get('cursor')!, 'base64url').toString()) : 0;
    const limit = Number(url.searchParams.get('limit'));
    const data = all.slice(offset, offset + limit);
    res.setHeader('content-type', 'application/json');
    // Like the real API: `next` is present even on the last page.
    res.end(JSON.stringify({ data, cursor: { next: Buffer.from(String(offset + limit)).toString('base64url') } }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, password: PASSWORD };
}

describe('fetchOpencodeMessages', () => {
  it('reads every page, newest first, with Basic auth and the limit; the last short page ends the read', async () => {
    const address = await serve(OPENCODE_PAGE_LIMIT * 2 + 37);
    const got = await fetchOpencodeMessages(address, 'ses_abc');
    expect(got?.messages).toHaveLength(OPENCODE_PAGE_LIMIT * 2 + 37);
    expect((got?.messages[0] as { id: string }).id).toBe(`msg_${String(OPENCODE_PAGE_LIMIT * 2 + 37).padStart(6, '0')}`);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toBe(`/api/session/ses_abc/message?limit=${OPENCODE_PAGE_LIMIT}`);
    expect(requests[1]?.url).toContain('cursor=');
    expect(requests.every((request) => request.authorization === `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`)).toBe(true);
  });

  it('an exact multiple of the limit asks once more and the empty page ends the read', async () => {
    const address = await serve(OPENCODE_PAGE_LIMIT);
    expect((await fetchOpencodeMessages(address, 'ses_abc'))?.messages).toHaveLength(OPENCODE_PAGE_LIMIT);
    expect(requests).toHaveLength(2);
  });

  it('the digest changes with the content and stays for the same answers', async () => {
    const address = await serve(5);
    const first = await fetchOpencodeMessages(address, 'ses_abc');
    const again = await fetchOpencodeMessages(address, 'ses_abc');
    expect(first?.digest).toBe(again?.digest);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const other = await fetchOpencodeMessages(await serve(6), 'ses_abc');
    expect(other?.digest).not.toBe(first?.digest);
  });

  it('a refusal, a dead server and a wrong shape give null', async () => {
    expect(await fetchOpencodeMessages(await serve(3, 401), 'ses_abc')).toBeNull();
    expect(await fetchOpencodeMessages({ url: 'http://127.0.0.1:1', password: PASSWORD }, 'ses_abc', fetch, 500)).toBeNull();
    const odd = (async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchOpencodeMessages({ url: 'http://x', password: PASSWORD }, 'ses_abc', odd)).toBeNull();
  });

  it('the password is never in the cache file name or content', async () => {
    const address = await serve(2);
    const got = await fetchOpencodeMessages(address, 'ses_abc');
    await writeOpencodeCache(ref, got!.messages, 1_700_000_000_000);
    expect(await readFile(opencodeCacheFile(ref), 'utf8')).not.toContain(PASSWORD);
  });
});

describe('the OpenCode cache', () => {
  it('lives in <work>/opencode/<session>.json, is written atomically and reads back', async () => {
    const messages = [{ id: 'msg_2', type: 'idle' }, { id: 'msg_1', type: 'user' }];
    await writeOpencodeCache(ref, messages, 1_700_000_000_000);
    expect(opencodeCacheFile(ref)).toBe(path.join(dir, '.parley', 'works', 'w-1', 'opencode', 's-1.json'));
    expect(await readOpencodeCache(ref)).toEqual(messages);
    expect(await readdir(path.dirname(opencodeCacheFile(ref)))).toEqual(['s-1.json']);
  });

  it('no file, broken JSON and a foreign file are null', async () => {
    expect(await readOpencodeCache(ref)).toBeNull();
    await writeOpencodeCache(ref, [], 0);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opencodeCacheFile(ref), '{nope');
    expect(await readOpencodeCache(ref)).toBeNull();
    await writeFile(opencodeCacheFile(ref), JSON.stringify({ version: 2, messages: [] }));
    expect(await readOpencodeCache(ref)).toBeNull();
  });

  it('the cap is enforced: the oldest messages go first, the file stays within the cap, the newest are kept', async () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({ id: `msg_${String(200 - index).padStart(4, '0')}`, text: 'x'.repeat(1000) }));
    const cap = 50 * 1024;
    const result = await writeOpencodeCache(ref, messages, 0, cap);
    const stored = (await readFile(opencodeCacheFile(ref), 'utf8'));
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(cap);
    expect(result.bytes).toBe(Buffer.byteLength(stored));
    expect(result.dropped).toBeGreaterThan(100);
    const kept = (await readOpencodeCache(ref)) as Array<{ id: string }>;
    expect(kept).toHaveLength(200 - result.dropped);
    expect(kept[0]?.id).toBe('msg_0200');
    expect(kept.at(-1)?.id).toBe(messages[kept.length - 1]!.id);
  });

  it('under the cap nothing is dropped; the default cap is 8 MiB', async () => {
    expect(OPENCODE_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect((await writeOpencodeCache(ref, [{ id: 'a' }], 0)).dropped).toBe(0);
  });
});
