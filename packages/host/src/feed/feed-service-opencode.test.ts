/**
 * OpenCode 2.x feed (spec 2026-11-12, 4.11, plan O8): the messages of the session's own server own the items; Parley's cache
 * keeps them when no server runs. A fake `opencode serve` (HTTP, Basic auth) stands in for the real one.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedFromOpencodeMessages, turnActive, type FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { fakeClient, fakeFeedDeps } from '../../test/feed-fakes.js';
import type { FakeFeedDeps } from '../../test/feed-fakes.js';
import { createFeedService } from './feed-service.js';
import type { FeedService } from './feed-service.js';
import { opencodeCacheFile, readOpencodeCache } from './opencode-source.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../../core/src/feed/opencode/__fixtures__');
const PASSWORD = 'lab-secret-not-real';
const OPENCODE_ID = 'ses_parley000000000000000001';

let dir = '';
let ref: SessionRef;
let fakes: FakeFeedDeps;
let service: FeedService | undefined;
let server: Server | undefined;
let messages: unknown[] = [];
let alive = true;
const requests: string[] = [];

async function fixtureMessages(name: string): Promise<unknown[]> {
  return (JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as { data: unknown[] }).data;
}

async function listen(): Promise<{ url: string; password: string }> {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`) return void res.writeHead(401).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: messages, cursor: {} }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, password: PASSWORD };
}

let address: { url: string; password: string };

function start(withServer: boolean): FeedService {
  fakes = fakeFeedDeps([{ ref, provider: 'opencode', providerSessionId: OPENCODE_ID }]);
  service = createFeedService(fakes.deps, { opencodeServer: () => (withServer && alive ? address : undefined) });
  return service;
}

const turnOpen = (items: readonly FeedItem[]): boolean => turnActive(items);
const mailClient = () => fakeClient(undefined, { features: ['feed-mail'] });
const strip = (items: readonly FeedItem[]): unknown => JSON.parse(JSON.stringify(items));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feed-opencode-'));
  ref = { projectPath: dir, workId: 'w-1', sessionId: 's-1' };
  messages = await fixtureMessages('lab-turn.json');
  alive = true;
  requests.length = 0;
  address = await listen();
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('feed of an OpenCode session', () => {
  it('a live poll gives the items of the core reducer, with terminal approvals', async () => {
    const snapshot = await start(true).snapshot(ref, undefined, undefined, mailClient());
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(strip(snapshot.items)).toEqual(strip(feedFromOpencodeMessages(messages).state.items));
    // The Code Mode call that reads the inbox also gives the Part M mail item.
    expect(snapshot.items.some((item) => item.kind === 'mail')).toBe(true);
    expect(snapshot.decisions).toBe('terminal');
    expect(requests.every((url) => url.startsWith(`/api/session/${OPENCODE_ID}/message`))).toBe(true);
  });

  it('a new message reaches a subscriber on the early poll, and an unchanged answer changes nothing', async () => {
    const s = start(true);
    const client = fakeClient();
    s.subscribe(ref, client);
    await s.snapshot(ref);
    const before = (await s.snapshot(ref)).revision;

    messages = [
      { id: 'msg_zz_idle', time: { created: 1_794_484_999_000 }, type: 'idle', outcome: 'succeeded' },
      { id: 'msg_zz_user', time: { created: 1_794_484_998_000 }, type: 'user', text: 'a later question' },
      ...messages,
    ];
    await s.opencodePoll(ref);
    const after = await s.snapshot(ref);
    expect(after.items.some((item) => item.kind === 'prompt' && item.text === 'a later question')).toBe(true);
    expect(after.revision).toBeGreaterThan(before);

    await s.opencodePoll(ref);
    await s.opencodePoll(ref);
    expect((await s.snapshot(ref)).revision).toBe(after.revision);
  });

  it('the cache follows every change: after a poll it holds the server\'s messages', async () => {
    const s = start(true);
    await s.snapshot(ref);
    expect(await readOpencodeCache(ref)).toEqual(messages);
    messages = [{ id: 'msg_zz_idle', time: { created: 1_794_484_999_000 }, type: 'idle', outcome: 'succeeded' }, ...messages];
    await s.opencodePoll(ref);
    expect((await readOpencodeCache(ref))?.length).toBe(messages.length);
  });

  it('a reseed from the cache after a fake restart gives the same items; no request goes anywhere', async () => {
    const live = await start(true).snapshot(ref, undefined, undefined, mailClient());
    await service!.stop();
    requests.length = 0;
    alive = false;

    const restored = await start(false).snapshot(ref, undefined, undefined, mailClient());
    expect(restored.items.some((item) => item.kind === 'mail')).toBe(true);
    expect(strip(restored.items)).toEqual(strip(live.items));
    expect(requests).toEqual([]);
  });

  it('a cache that ends in an open turn is closed as interrupted when no server runs', async () => {
    messages = await fixtureMessages('messages-main.json');
    expect(turnOpen(feedFromOpencodeMessages(messages).state.items)).toBe(true);
    await start(true).snapshot(ref);
    await service!.stop();
    const restored = await start(false).snapshot(ref);
    expect(restored.items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
  });

  it('no server and no cache: an empty feed, and the next poll fills it once the server is there', async () => {
    alive = false;
    const s = start(true);
    expect((await s.snapshot(ref)).items).toEqual([]);
    alive = true;
    await s.opencodePoll(ref);
    expect((await s.snapshot(ref)).items.length).toBeGreaterThan(0);
  });

  it('the last poll before a stop stores the server\'s messages, with or without a feed in memory', async () => {
    const s = start(true);
    expect(await readOpencodeCache(ref)).toBeNull();
    await s.opencodeLastPoll(ref, address);
    expect(await readOpencodeCache(ref)).toEqual(messages);

    // With a feed in memory, the same call also moves the feed.
    await s.snapshot(ref);
    messages = [{ id: 'msg_zz_user', time: { created: 1_794_484_998_000 }, type: 'user', text: 'said just before the stop' }, ...messages];
    await s.opencodeLastPoll(ref, address);
    expect((await readOpencodeCache(ref))?.length).toBe(messages.length);
    expect((await s.snapshot(ref)).items.some((item) => item.kind === 'prompt' && item.text === 'said just before the stop')).toBe(true);
  });

  it('the last poll never throws: a dead server, a wrong password and a session without an id leave the cache alone', async () => {
    const s = start(true);
    await s.opencodeLastPoll(ref, { url: 'http://127.0.0.1:1', password: PASSWORD });
    await s.opencodeLastPoll(ref, { ...address, password: 'wrong' });
    expect(await readOpencodeCache(ref)).toBeNull();
    fakes = fakeFeedDeps([{ ref }]);
    const bare = createFeedService(fakes.deps, { opencodeServer: () => address });
    await bare.opencodeLastPoll(ref, address);
    await bare.stop();
    expect(await readOpencodeCache(ref)).toBeNull();
  });

  it('a subagent snapshot is not found, and nothing writes the password anywhere', async () => {
    const s = start(true);
    await expect(s.snapshot(ref, 'agent1')).rejects.toMatchObject({ code: 'not_found' });
    await s.snapshot(ref);
    expect(await readFile(opencodeCacheFile(ref), 'utf8')).not.toContain(PASSWORD);
    expect(JSON.stringify(vi.mocked(fakes.log.info).mock.calls) + JSON.stringify(vi.mocked(fakes.log.warn).mock.calls)).not.toContain(PASSWORD);
  });
});
