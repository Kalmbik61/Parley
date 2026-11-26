import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOST_ERROR_REASONS, type SessionRef } from '@parley/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostError } from '../errors.js';
import { createKimiUnloadRecovery, type KimiUnloadRecoveryOptions } from './unload-recovery.js';

const cwd = '/private/tmp/fixture';
const sessionId = 'session_00000000-0000-4000-8000-000000000001';
const ref: SessionRef = { projectPath: '/private/tmp/fixture-project', workId: 'w-01', sessionId: 's-01' };
const toolA = 'mcp__figma-dev-mode-mcp-server__add_code_connect_map';
const toolB = 'mcp__parley__get_map';
const toolC = 'mcp__parley__report';
const toolD = 'mcp__parley__send_message';
let home: string, file: string;
const header = JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' }) + '\n';
const binding = () => ({ home, cwd });

const announcement = (removed: string[]) => JSON.stringify({
  type: 'context.append_message', agentId: 'main', time: 100,
  message: { role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'loadable-tools' },
    content: [{ type: 'text', text: '<system-reminder>removed</system-reminder>', meta: { kind: 'tool_lifecycle', added: [], removed } }] },
}) + '\n';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-recovery-'));
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  file = path.join(home, 'sessions', `wd_fixture_${hash}`, sessionId, 'agents', 'main', 'wire.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function rig(overrides: Partial<KimiUnloadRecoveryOptions> = {}) {
  const calls: string[] = [];
  const notices: Array<{ kind: string; text: string }> = [];
  const state = { live: true };
  const recovery = createKimiUnloadRecovery({
    stop: async () => { calls.push('stop'); state.live = false; },
    resume: async () => { calls.push('resume'); state.live = true; },
    live: () => state.live,
    notice: (_ref, kind, text) => { notices.push({ kind, text }); },
    locale: () => undefined,
    log: { warn: vi.fn() },
    ...overrides,
  });
  return { recovery, calls, notices, state };
}
const wireRows = () => readFile(file, 'utf8').then(text => text.split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line)));
const backups = () => readdir(path.dirname(file)).then(names => names.filter(name => name.startsWith('wire.jsonl.bak-')));

it('stops, repairs, resumes and notifies; a clean turn end verifies the repair', async () => {
  await writeFile(file, header + announcement([toolA]) + announcement([toolB]));
  const { recovery, calls, notices } = rig();
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => calls).toEqual(['stop', 'resume']);
  expect(await wireRows()).toEqual([JSON.parse(announcement([toolB]))]);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.kind).toBe('kimi-unload-repaired');
  expect(notices[0]!.text).toContain(toolA);
  expect(notices[0]!.text).toContain((await backups())[0]!);
  // The next turn completes: the episode is forgotten, a later poison starts fresh.
  recovery.turnEnd(ref, binding(), sessionId, undefined);
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolB });
  await expect.poll(() => calls).toEqual(['stop', 'resume', 'stop', 'resume']);
  expect(await wireRows()).toEqual([]);
  expect(notices.map(notice => notice.kind)).toEqual(['kimi-unload-repaired', 'kimi-unload-repaired']);
});

it('bounds attempts by the number of poisoned announcements even when the CLI re-emits deltas', async () => {
  await writeFile(file, header + announcement([toolA]) + announcement([toolB]));
  const { recovery, calls, notices } = rig();
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => calls).toEqual(['stop', 'resume']);
  // The resume path re-emits a removal delta (audit risk): a new announcement, a new failure.
  await appendFile(file, announcement([toolC]));
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolC });
  await expect.poll(() => calls).toEqual(['stop', 'resume', 'stop', 'resume']);
  await appendFile(file, announcement([toolD]));
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolD });
  await expect.poll(() => notices).toHaveLength(3);
  expect(notices[2]!.kind).toBe('kimi-unload-blocked');
  expect(notices[2]!.text).toContain('attempt limit');
  expect(calls).toEqual(['stop', 'resume', 'stop', 'resume']);
  expect(await wireRows()).toEqual([JSON.parse(announcement([toolB])), JSON.parse(announcement([toolD]))]);
});

it('blocks instead of looping when the same tool fails after its announcement was removed', async () => {
  await writeFile(file, header + announcement([toolA]));
  const { recovery, calls, notices } = rig();
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => calls).toEqual(['stop', 'resume']);
  await appendFile(file, announcement([toolA]));
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => notices).toHaveLength(2);
  expect(notices[1]!.kind).toBe('kimi-unload-blocked');
  expect(notices[1]!.text).toContain('same tool');
  expect(calls).toEqual(['stop', 'resume']);
  expect(await backups()).toHaveLength(1);
});

it('blocks when the process is live again at the write boundary and does not resume', async () => {
  await writeFile(file, header + announcement([toolA]));
  const { recovery, calls, notices } = rig({ stop: async () => { calls.push('stop'); } });
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => notices).toHaveLength(1);
  expect(notices[0]!.kind).toBe('kimi-unload-blocked');
  expect(notices[0]!.text).toContain('live');
  expect(calls).toEqual(['stop']);
  expect(await wireRows()).toEqual([JSON.parse(announcement([toolA]))]);
});

it('keeps the backup and reports the blocker when the resume fails', async () => {
  await writeFile(file, header + announcement([toolA]));
  const { recovery, calls, notices } = rig({
    resume: async () => { calls.push('resume'); throw new Error('provider is not signed in'); },
  });
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => notices).toHaveLength(2);
  expect(notices.map(notice => notice.kind)).toEqual(['kimi-unload-repaired', 'kimi-unload-blocked']);
  expect(notices[1]!.text).toContain('provider is not signed in');
  expect(calls).toEqual(['stop', 'resume']);
  expect(await wireRows()).toEqual([]);
  expect(await backups()).toHaveLength(1);
});

it('blocks when no post-compaction announcement names the tool', async () => {
  await writeFile(file, header + announcement([toolB]));
  const { recovery, calls, notices } = rig();
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => notices).toHaveLength(1);
  expect(notices[0]!.kind).toBe('kimi-unload-blocked');
  expect(notices[0]!.text).toContain('no post-compaction');
  expect(calls).toEqual(['stop']);
  expect(await backups()).toHaveLength(0);
});

it('skips quietly while a model change owns the session and retries on the next failed turn', async () => {
  await writeFile(file, header + announcement([toolA]));
  let busy = true;
  const { recovery, calls, notices } = rig({
    serialize: async (_ref, run) => {
      if (busy) throw new HostError('conflict', 'Another model or effort change of this session is in progress', { reason: HOST_ERROR_REASONS.busy });
      return run();
    },
  });
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => calls).toEqual([]);
  expect(notices).toHaveLength(0);
  busy = false;
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  await expect.poll(() => calls).toEqual(['stop', 'resume']);
  expect(notices.map(notice => notice.kind)).toEqual(['kimi-unload-repaired']);
});

it('runs one recovery at a time while the first is in flight', async () => {
  await writeFile(file, header + announcement([toolA]) + announcement([toolB]));
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  const { recovery, calls, notices } = rig({
    stop: async () => { calls.push('stop'); await gate; stopped = true; },
    live: () => !stopped,
  });
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolA });
  recovery.turnEnd(ref, binding(), sessionId, { tool: toolB });
  await expect.poll(() => calls).toEqual(['stop']);
  release();
  await expect.poll(() => calls).toEqual(['stop', 'resume']);
  expect(notices).toHaveLength(1);
  expect(await wireRows()).toEqual([JSON.parse(announcement([toolB]))]);
});
