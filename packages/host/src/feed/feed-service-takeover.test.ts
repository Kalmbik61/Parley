/** Provider takeover keeps the open Chat subscribed to the authoritative transcript. Synthetic records only. */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FeedItem, RawRecord } from '@parley/core';
import type { EventData } from '@parley/protocol';
import { fakeClient, fakeFeedDeps, hookRequest, REF } from '../../test/feed-fakes.js';
import { createFeedService, type FeedService } from './feed-service.js';
import * as codexSource from './codex-source.js';

const AT = '2026-11-11T14:00:00.000Z';
const qwenLine = (uuid: string, type: string, text: string): string => `${JSON.stringify({
  uuid, sessionId: 'qwen-session', timestamp: AT, type,
  provenance: type === 'user' ? 'real_user' : 'assistant_output', message: { parts: [{ text }] },
})}\n`;
const claudeRecords: RawRecord[] = [
  { type: 'user', uuid: 'old-user', timestamp: AT, message: { role: 'user', content: 'old prompt' } },
  { type: 'assistant', uuid: 'shared', timestamp: AT, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'old answer' }] } },
];
let dir: string;
let file: string;
let fakes: ReturnType<typeof fakeFeedDeps>;
let service: FeedService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feed-takeover-'));
  file = path.join(dir, 'qwen.jsonl');
  await writeFile(file, qwenLine('new-user', 'user', 'Qwen history') + qwenLine('shared', 'assistant', 'Qwen answer'));
  fakes = fakeFeedDeps([{ ref: REF, provider: 'claude' }]);
  service = createFeedService(fakes.deps, { batchMs: 1, roots: () => [dir] });
});
afterEach(async () => {
  await service.stop();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function watch() {
  const client = fakeClient();
  service.subscribe(REF, client);
  let items: FeedItem[] = [];
  let revision = 0;
  let consumed = 0;
  const deltas: EventData<'feed.changed'>[] = [];
  return {
    client, deltas,
    initial(snapshot: Awaited<ReturnType<FeedService['snapshot']>>) {
      items = snapshot.items;
      revision = snapshot.revision;
      consumed = client.sent.length;
    },
    read() {
      for (const event of client.sent.slice(consumed)) {
        if (!('event' in event) || event.event !== 'feed.changed') continue;
        const delta = event.data as EventData<'feed.changed'>;
        expect(delta.revision).toBe(revision + 1);
        // Desktop chat/store.ts applies upserts in place, then removals. Preserve that ordering (not Map merge).
        const next = [...items];
        const index = new Map(next.map((item, at) => [item.id, at]));
        for (const item of delta.upsert) {
          const at = index.get(item.id);
          if (at === undefined) {
            index.set(item.id, next.length);
            next.push(item);
          } else next[at] = item;
        }
        const removed = new Set(delta.removed);
        items = next.filter((item) => !removed.has(item.id));
        revision = delta.revision;
        deltas.push(delta);
      }
      consumed = client.sent.length;
      return items;
    },
  };
}

it.each(['seeded', 'live'] as const)('replaces a warm %s Claude source for the existing subscriber, including colliding ids', async (warm) => {
  const oldFile = path.join(dir, 'claude.jsonl');
  await writeFile(oldFile, claudeRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fakes.setLogFile(oldFile);
  const view = watch();
  await service.snapshot(REF);
  if (warm === 'live') service.onHook(hookRequest({ hook_event_name: 'MessageDisplay', session_id: 'claude-session', message_id: 'live', index: 0, delta: 'old live answer', final: true }));
  const before = await service.snapshot(REF);
  expect(before.items.some((item) => item.id === 'text:shared:1')).toBe(true);
  view.initial(before);
  fakes.setLogFile(file);
  // No start event or new subscribe is required: works owns the provider identity.
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  await vi.waitFor(() => expect(view.read().filter((item) => item.kind === 'prompt').map((item) => item.text)).toEqual(['Qwen history']));
  expect(view.read().filter((item) => item.kind === 'text').map((item) => item.text)).toEqual(['Qwen answer']);
  expect(view.deltas.flatMap((delta) => delta.upsert).filter((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toHaveLength(1);
  expect(service.subscriberCount()).toBe(1);
  await appendFile(file, qwenLine('reply', 'assistant', 'live Qwen reply'));
  // Polling must have been installed for the subscription that was opened on Claude. No hook or snapshot drives it.
  await vi.waitFor(() => expect(view.read().some((item) => item.kind === 'text' && item.text === 'live Qwen reply')).toBe(true), { timeout: 4000 });
  expect(view.read()).toEqual((await service.snapshot(REF)).items);
});

it('retries a delayed Qwen transcript for the already subscribed client', async () => {
  const view = watch();
  service.onHook(hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: 'old', prompt: 'old live prompt' }));
  view.initial(await service.snapshot(REF));
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  await vi.waitFor(() => expect(view.read()).toEqual([]));
  fakes.setLogFile(file);
  await vi.waitFor(() => expect(view.read().some((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toBe(true), { timeout: 4000 });
  expect(view.read()).toEqual((await service.snapshot(REF)).items);
});

it('carries pending ring removals across takeover and discards the old unflushed upserts', async () => {
  await service.stop();
  service = createFeedService(fakes.deps, { maxItems: 2, batchMs: 100 });
  const view = watch();
  const prompt = (text: string) => hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: 'old', prompt: text });
  service.onHook(prompt('visible old prompt'));
  const before = await service.snapshot(REF);
  expect(before.items).toHaveLength(1);
  view.initial(before);
  // The next prompt trims the visible one, but its removed id has not reached the client yet.
  service.onHook(prompt('pending old prompt'));
  fakes.setLogFile(file);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  await vi.waitFor(() => expect(view.read().filter((item) => item.kind === 'prompt').map((item) => item.text)).toEqual(['Qwen history']));
  expect(view.deltas.flatMap((delta) => delta.removed)).toContain(before.items[0]?.id);
  expect(view.deltas.flatMap((delta) => delta.upsert).some((item) => item.kind === 'prompt' && item.text === 'pending old prompt')).toBe(false);
  expect(view.read()).toEqual((await service.snapshot(REF)).items);
});

it('publishes replacement history when a snapshot sees the provider before the works notification', async () => {
  await service.stop();
  vi.spyOn(fakes.deps.works, 'onChange').mockImplementation(() => () => {});
  service = createFeedService(fakes.deps, { batchMs: 1 });
  const view = watch();
  service.onHook(hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: 'old', prompt: 'old prompt' }));
  view.initial(await service.snapshot(REF));
  fakes.setLogFile(file);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  const snapshot = await service.snapshot(REF);
  expect(snapshot.items.some((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toBe(true);
  await vi.waitFor(() => expect(view.read()).toEqual(snapshot.items));
});

it('discards an in-flight Claude cold read and seeds Qwen once the read releases', async () => {
  const oldFile = path.join(dir, 'claude.jsonl');
  await writeFile(oldFile, 'synthetic transcript\n');
  fakes.setLogFile(oldFile);
  await service.stop();
  let release!: (records: RawRecord[]) => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  service = createFeedService(fakes.deps, { roots: () => [dir], batchMs: 1, readRecords: () => {
    reading();
    return new Promise((resolve) => { release = resolve; });
  } });
  const view = watch();
  const pending = service.snapshot(REF);
  await started;
  fakes.setLogFile(file);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  release(claudeRecords);
  expect((await pending).items.some((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toBe(true);
  await vi.waitFor(() => expect(view.read().some((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toBe(true));
  const snapshot = await service.snapshot(REF);
  expect(snapshot.items.some((item) => item.kind === 'text' && item.text === 'old answer')).toBe(false);
  expect(view.read()).toEqual(snapshot.items);
});

it('ignores an old source poll that finishes after Qwen takeover', async () => {
  let release!: () => void;
  let reading!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { reading = resolve; });
  let polling: Promise<unknown> | undefined;
  const create = codexSource.createRolloutTail;
  vi.spyOn(codexSource, 'createRolloutTail').mockImplementation((...args) => {
    const tail = create(...args);
    let count = 0;
    return { ...tail, read() {
      const run = (async () => {
        const records = await tail.read();
        if (++count === 2) { reading(); await held; }
        return records;
      })();
      if (count > 0) polling = run;
      return run;
    } };
  });
  const oldFile = path.join(dir, 'codex.jsonl');
  const command = (n: number) => `${JSON.stringify({ timestamp: AT, ordinal: n, type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'CommandExecution', id: `old-${n}`, command: ['echo synthetic'], status: 'completed', exit_code: 0 },
  } })}\n`;
  try {
    fakes.setSessions([{ ref: REF, provider: 'codex' }]);
    await writeFile(oldFile, command(1));
    fakes.setLogFile(oldFile);
    const view = watch();
    const before = await service.snapshot(REF);
    expect(before.items.some((item) => item.kind === 'tool')).toBe(true);
    view.initial(before);
    await appendFile(oldFile, command(2));
    fakes.emitLog();
    await started;
    fakes.setLogFile(file);
    fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
    await vi.waitFor(() => expect(view.read().some((item) => item.kind === 'prompt' && item.text === 'Qwen history')).toBe(true));
    release();
    await polling;
    expect(view.read().some((item) => item.kind === 'tool')).toBe(false);
    expect(view.read()).toEqual((await service.snapshot(REF)).items);
  } finally { release(); }
});

it('keeps an already cold Qwen source subscribed through a same-provider resume', async () => {
  fakes.setLogFile(file);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  const view = watch();
  const before = await service.snapshot(REF);
  view.initial(before);
  fakes.emitExit(REF);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  fakes.emitStart(REF);
  await appendFile(file, qwenLine('resumed', 'assistant', 'resumed reply'));
  fakes.emitLog();
  await vi.waitFor(() => expect(view.read().some((item) => item.kind === 'text' && item.text === 'resumed reply')).toBe(true));
  for (const item of before.items) expect(view.read().filter((candidate) => candidate.id === item.id)).toHaveLength(1);
  expect(view.read()).toEqual((await service.snapshot(REF)).items);
});

it('keeps early Kimi output when the session is registered and rejects it after Qwen takes over', async () => {
  fakes.setSessions([]);
  service.kimiOutput(REF, { kind: 'prompt', text: 'early prompt' });
  fakes.setSessions([{ ref: REF, provider: 'kimi' }]);
  expect((await service.snapshot(REF)).items).toContainEqual(expect.objectContaining({ kind: 'prompt', text: 'early prompt' }));

  fakes.setLogFile(file);
  fakes.setSessions([{ ref: REF, provider: 'qwen' }]);
  service.kimiOutput(REF, { kind: 'text', messageId: 'late', text: 'late Kimi reply' });
  const snapshot = await service.snapshot(REF);
  expect(snapshot.items.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual(['Qwen answer']);
});
