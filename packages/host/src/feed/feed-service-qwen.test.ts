/** Qwen Code feed (spec 2026-11-11, 3.5): the transcript owns the items; hooks feed state only. */

import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@parley/core';
import { fakeFeedDeps, fakeClient, hookRequest, REF } from '../../test/feed-fakes.js';
import type { FakeFeedDeps } from '../../test/feed-fakes.js';
import { createLogIndex } from '../activity/log-index.js';
import { createFeedService } from './feed-service.js';
import type { FeedService } from './feed-service.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../core/src/feed/qwen/__fixtures__/session-main.jsonl');
const ID = '66666666-6666-4666-8666-666666666666';

let fakes: FakeFeedDeps;
let service: FeedService;
let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feed-qwen-'));
  file = path.join(dir, `${ID}.jsonl`);
  await copyFile(FIXTURE, file);
  fakes = fakeFeedDeps([{ ref: REF, provider: 'qwen' }]);
  fakes.setLogFile(file);
  service = createFeedService(fakes.deps, {});
});
afterEach(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

const kinds = (items: readonly FeedItem[], kind: FeedItem['kind']): FeedItem[] => items.filter((item) => item.kind === kind);

describe('feed of a Qwen Code session', () => {
  it('the snapshot is built from the transcript: prompts, text, tools with the inner MCP name and a failed call', async () => {
    const snapshot = await service.snapshot(REF);
    expect(kinds(snapshot.items, 'prompt').map((i) => (i.kind === 'prompt' ? i.text : ''))).toEqual(['mcpflow', 'shellflow']);
    const tools = snapshot.items.filter((i) => i.kind === 'tool');
    expect(tools.find((t) => t.kind === 'tool' && t.toolUseId === 'call_1')).toMatchObject({ name: 'mcp__parley__echo', status: 'done' });
    expect(tools.find((t) => t.kind === 'tool' && t.toolUseId === 'call_e1')).toMatchObject({ status: 'failed' });
    expect(snapshot.decisions).toBe('terminal');
  });

  it('an appended transcript record reaches subscribers after a hook prompts the read', async () => {
    const client = fakeClient();
    service.subscribe(REF, client);
    await service.snapshot(REF);
    const line = `${JSON.stringify({ uuid: 'zz1', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'assistant', model: 'm', message: { parts: [{ text: 'appended answer' }] } })}\n`;
    await appendFile(file, line);
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID }));
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(REF);
      expect(kinds(snapshot.items, 'text').some((i) => i.kind === 'text' && i.text === 'appended answer')).toBe(true);
    });
  });

  it('hooks create no items and no permission cards, and are answered at once', async () => {
    await service.snapshot(REF);
    const before = (await service.snapshot(REF)).items.length;
    const prompt = hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: ID, prompt: 'SECRET-HOOK-PROMPT' });
    const permission = hookRequest({ hook_event_name: 'PermissionRequest', session_id: ID, tool_name: 'run_shell_command', tool_input: { command: 'rm -rf /' } });
    const pre = hookRequest({ hook_event_name: 'PreToolUse', session_id: ID, tool_name: 'run_shell_command', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    for (const request of [prompt, permission, pre]) service.onHook(request);
    const after = await service.snapshot(REF);
    expect(after.items.length).toBe(before);
    expect(JSON.stringify(after.items)).not.toContain('SECRET-HOOK-PROMPT');
    expect(after.items.some((i) => i.kind === 'permission')).toBe(false);
    for (const request of [prompt, permission, pre]) expect(request.responses).toEqual([{}]);
  });

  it('a transcript replayed after the same records were applied gives no duplicates', async () => {
    const first = (await service.snapshot(REF)).items.length;
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await service.snapshot(REF)).items.length).toBe(first);
  });

  it('has no subagent transcripts and never reads the Claude layout', async () => {
    await expect(service.snapshot(REF, 'agent-1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('feed of a Qwen Code session through the real log index and binding', () => {
  it('the transcript the index trusts (binding: path, sessionId, cwd) feeds the snapshot RPC', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'feed-qwen-root-'));
    const bound = path.join(root, '-work-project', 'chats', `${ID}.jsonl`);
    await mkdir(path.dirname(bound), { recursive: true });
    await copyFile(FIXTURE, bound);
    const index = createLogIndex({ claudeRoot: path.join(root, 'none-c'), codexRoot: path.join(root, 'none-x'), qwenRoot: root }, { cache: null });
    try {
      await index.start();
      const session = { id: 's-01', provider: 'qwen', providerSessionId: ID, qwenTranscript: { path: bound, cwd: '/work/project' } } as never;
      const wrong = { id: 's-01', provider: 'qwen', providerSessionId: ID, qwenTranscript: { path: bound, cwd: '/other' } } as never;
      expect(index.index(wrong)).toBeUndefined();
      await service.stop();
      const deps = fakeFeedDeps([{ ref: REF, provider: 'qwen' }]);
      (deps.deps.activity as { logFile: unknown }).logFile = () => index.index(session)?.file ?? null;
      service = createFeedService(deps.deps, {});
      const snapshot = await service.snapshot(REF);
      expect(snapshot.items.map((i) => i.kind)).toContain('tool');
      expect(snapshot.items.filter((i) => i.kind === 'prompt')).toHaveLength(2);
      expect(snapshot.decisions).toBe('terminal');
    } finally {
      index.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
