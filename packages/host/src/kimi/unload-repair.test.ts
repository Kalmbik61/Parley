import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { repairKimiUnloadPoison } from './unload-repair.js';

const cwd = '/private/tmp/fixture';
const sessionId = 'session_00000000-0000-4000-8000-000000000001';
const toolA = 'mcp__figma-dev-mode-mcp-server__add_code_connect_map';
const toolB = 'mcp__parley__get_map';
let home: string, file: string;
const header = JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' }) + '\n';

const announcement = (removed: string[], added: string[] = []) => ({
  type: 'context.append_message', agentId: 'main', time: 100,
  message: { role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'loadable-tools' },
    content: [{ type: 'text', text: '<system-reminder>\n<tools_removed>\n' + removed.join('\n') + '\n</tools_removed>\n</system-reminder>',
      meta: { kind: 'tool_lifecycle', added, removed } }] },
});
const poisonEnd = (tool: string, position = 168) => ({
  type: 'turn.ended', agentId: 'main', turnId: 'turn-1', reason: 'failed', time: 101, durationMs: 3000,
  error: { code: 'provider.api_error', name: 'APIStatusError', retryable: false,
    details: { requestId: null, statusCode: 400, traceId: 'fixture' },
    message: `unload_tools at message position ${position}: tool "${tool}" is not declared or has already been unloaded` },
});

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-kimi-repair-')));
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  file = path.join(home, 'sessions', `wd_fixture_${hash}`, sessionId, 'agents', 'main', 'wire.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const binding = () => ({ home, cwd, sessionId });
const stopped = { live: () => false };
const linesOf = (rows: object[]) => rows.map(row => JSON.stringify(row) + '\n');
async function writeWire(rows: object[]): Promise<string[]> {
  const lines = linesOf(rows);
  await writeFile(file, header + lines.join(''));
  return lines;
}
const backups = async () => (await readdir(path.dirname(file))).filter(name => name.startsWith('wire.jsonl.bak-'));

it('removes exactly the announcements naming the tool, backs up the original, keeps every other byte', async () => {
  const rows = [
    { type: 'environment.set_binding', agentId: 'main', cwd },
    { type: 'turn.prompt', agentId: 'main', time: 1, input: [{ type: 'text', text: 'первый ход' }] },
    { type: 'context.append_message', agentId: 'main', time: 2, message: { id: 'msg_1', role: 'user', origin: { kind: 'user' },
      content: [{ type: 'text', text: 'текст с юникодом 中 🎉' }] } },
    { type: 'context.apply_compaction', agentId: 'main', time: 3, compactedCount: 10 },
    announcement([toolA, 'mcp__figma-dev-mode-mcp-server__get_screenshot'], ['mcp__figma-bridge__set_reactions']),
    poisonEnd(toolA),
    announcement([toolB]),
    poisonEnd(toolB),
    { type: 'turn.ended', agentId: 'main', reason: 'completed', time: 102 },
  ];
  const lines = await writeWire(rows);
  const original = await readFile(file);
  const result = await repairKimiUnloadPoison(binding(), toolA, stopped);
  expect(result).toMatchObject({ status: 'repaired', removed: 1, poisoned: 2 });
  if (result.status !== 'repaired') throw new Error('unreachable');
  // Exactly the one announcement naming toolA is gone; the toolB announcement and all other rows stay byte-identical.
  const kept = Buffer.concat([Buffer.from(header), ...lines.filter((_, index) => index !== 4).map(line => Buffer.from(line))]);
  expect(await readFile(file)).toEqual(kept);
  expect(await readFile(result.backup)).toEqual(original);
  expect(path.dirname(result.backup)).toBe(path.dirname(file));
  expect(await backups()).toHaveLength(1);
});

it('keeps announcements at or before the last compaction even when they name the tool', async () => {
  const rows = [
    announcement([toolA]),
    { type: 'context.apply_compaction', agentId: 'main', time: 3, compactedCount: 10 },
    { type: 'turn.prompt', agentId: 'main', time: 4, input: [] },
  ];
  const lines = await writeWire(rows);
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'clean', poisoned: 0 });
  expect(await readFile(file)).toEqual(Buffer.from(header + lines.join('')));
  expect(await backups()).toHaveLength(0);
  // The same tool after the last compaction is repaired; the earlier announcement stays.
  await writeFile(file, header + lines.join('') + linesOf([announcement([toolA])]).join(''));
  const result = await repairKimiUnloadPoison(binding(), toolA, stopped);
  expect(result).toMatchObject({ status: 'repaired', removed: 1, poisoned: 1 });
  expect(await readFile(file)).toEqual(Buffer.from(header + lines.join('')));
});

it('is idempotent: a second repair finds nothing and writes nothing', async () => {
  await writeWire([announcement([toolA]), poisonEnd(toolA)]);
  const first = await repairKimiUnloadPoison(binding(), toolA, stopped);
  expect(first).toMatchObject({ status: 'repaired', removed: 1 });
  const repaired = await readFile(file);
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'clean', poisoned: 0 });
  expect(await readFile(file)).toEqual(repaired);
  expect(await backups()).toHaveLength(1);
});

it('refuses a live process without touching the wire or creating a backup', async () => {
  const lines = await writeWire([announcement([toolA]), poisonEnd(toolA)]);
  expect(await repairKimiUnloadPoison(binding(), toolA, { live: () => true })).toEqual({ status: 'refused', reason: 'live' });
  expect(await readFile(file)).toEqual(Buffer.from(header + lines.join('')));
  expect(await backups()).toHaveLength(0);
});

it('refuses when the wire changes between the read and the write', async () => {
  const lines = await writeWire([announcement([toolA]), poisonEnd(toolA)]);
  const extra = linesOf([{ type: 'turn.prompt', agentId: 'main', time: 200, input: [] }]).join('');
  let calls = 0;
  const live = () => {
    calls += 1;
    // The second guard call stands in for a concurrent writer landing after the read.
    if (calls === 2) appendFileSync(file, extra);
    return false;
  };
  expect(await repairKimiUnloadPoison(binding(), toolA, { live })).toEqual({ status: 'refused', reason: 'changed' });
  expect(await readFile(file)).toEqual(Buffer.from(header + lines.join('') + extra));
  // The backup taken before the refusal is kept.
  expect(await backups()).toHaveLength(1);
});

it('refuses an unsafe or malformed wire without touching it', async () => {
  const good = linesOf([announcement([toolA])]).join('');
  await writeFile(file, header + good + '{"type":"turn.ended",');
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  await writeFile(file, JSON.stringify({ type: 'metadata', protocol_version: '1.4', min_protocol_version: '1.4' }) + '\n' + good);
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  await writeFile(file, header + good.trimEnd());
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  await writeFile(file, '');
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  expect(await repairKimiUnloadPoison({ home, cwd, sessionId: 'session_not-a-stock-id' }, toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  expect(await backups()).toHaveLength(0);
});

it('refuses a missing or symlinked wire', async () => {
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  const target = path.join(home, 'elsewhere.jsonl');
  await writeFile(target, header + linesOf([announcement([toolA])]).join(''));
  await symlink(target, file);
  expect(await repairKimiUnloadPoison(binding(), toolA, stopped)).toEqual({ status: 'refused', reason: 'invalid' });
  expect(existsSync(target)).toBe(true);
  expect(await backups()).toHaveLength(0);
});

it('ignores added-only announcements, non-string removals and other agents', async () => {
  const addedOnly = announcement([], ['mcp__figma-bridge__set_reactions']);
  const mixed = { type: 'context.append_message', agentId: 'main', time: 100, message: { role: 'user', origin: { kind: 'injection' },
    content: [{ type: 'text', text: 'x', meta: { kind: 'tool_lifecycle', added: [], removed: [42, null, toolA] } }] } };
  const child = { ...announcement([toolA]), agentId: 'child' };
  const lines = await writeWire([addedOnly, child, mixed]);
  expect(await repairKimiUnloadPoison(binding(), toolB, stopped)).toEqual({ status: 'clean', poisoned: 1 });
  const result = await repairKimiUnloadPoison(binding(), toolA, stopped);
  expect(result).toMatchObject({ status: 'repaired', removed: 1, poisoned: 1 });
  // Only the main-agent mixed row goes; the added-only and child rows stay.
  expect(await readFile(file)).toEqual(Buffer.from(header + [lines[0]!, lines[1]!].join('')));
});
