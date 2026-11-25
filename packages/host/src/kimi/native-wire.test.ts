import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKimiWire, projectKimiWire, proveKimiEmptyStartup } from './native-wire.js';

const cwd = '/private/tmp/fixture';
const sessionId = 'session_00000000-0000-4000-8000-000000000001';
let home: string, file: string;
const header = JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' }) + '\n';
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-wire-'));
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  file = path.join(home, 'sessions', `wd_fixture_${hash}`, sessionId, 'agents', 'main', 'wire.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('reads only complete UTF-8 lines and refuses to replay a replacement', async () => {
  const row = Buffer.from(JSON.stringify({ type: 'turn.ended', agentId: 'main', label: '中' }) + '\n');
  const split = row.indexOf(Buffer.from('中')) + 1;
  await writeFile(file, Buffer.concat([Buffer.from(header), row.subarray(0, split)]));
  const reader = await createKimiWire({ home, cwd, sessionId });
  expect(await reader.read()).toEqual({ rows: [] });
  await appendFile(file, row.subarray(split));
  expect(await reader.read()).toEqual({ rows: [{ type: 'turn.ended', agentId: 'main', label: '中' }] });
  expect(await reader.read()).toEqual({ rows: [] });
  await rename(file, file + '.old');
  await writeFile(file, header + row.toString());
  expect(await reader.read()).toEqual({ rows: [], limitation: 'replaced' });
});

it('does not guess an ID or cwd from sibling wires and rejects a malformed path', async () => {
  await writeFile(file, header + '{"type":"turn.ended","agentId":"main"}\n');
  const elsewhere = await createKimiWire({ home, cwd: '/private/tmp/unrelated', sessionId });
  expect(await elsewhere.read()).toEqual({ rows: [] });
  await expect(createKimiWire({ home, cwd, sessionId: '../agents' })).rejects.toThrow(/invalid/i);
});

it('does not replay a truncated wire even if its original path still exists', async () => {
  await writeFile(file, header + '{"type":"turn.ended","agentId":"main"}\n');
  const reader = await createKimiWire({ home, cwd, sessionId });
  expect((await reader.read()).rows).toHaveLength(1);
  await writeFile(file, header);
  expect(await reader.read()).toEqual({ rows: [], limitation: 'truncated' });
  await appendFile(file, '{"type":"turn.ended","agentId":"main"}\n');
  expect(await reader.read()).toEqual({ rows: [], limitation: 'truncated' });
});

it('requires a complete empty startup wire and an exact enabled Parley catalog', async () => {
  const prove = () => proveKimiEmptyStartup({ home, cwd, sessionId }, ['get_map', 'check_inbox']);
  const discovery = { type: 'mcp.tools_discovered', agentId: 'main', serverName: 'parley',
    tools: [{ name: 'get_map' }, { name: 'check_inbox' }], enabledNames: ['check_inbox', 'get_map'] };
  const row = JSON.stringify(discovery);
  expect(await prove()).toBe('waiting');
  await writeFile(file, header + row);
  expect(await prove()).toBe('waiting');
  await appendFile(file, '\n');
  expect(await prove()).toBe('ready');
  await appendFile(file, '{"type":"turn.prompt"}\n');
  expect(await prove()).toBe('unsafe');
  await writeFile(file, header + JSON.stringify({ ...discovery, enabledNames: ['get_map'] }) + '\n');
  expect(await prove()).toBe('unsafe');
  await writeFile(file, header + row + '\n{"type":"unknown"}\n');
  expect(await prove()).toBe('unsafe');
});

it('projects only positively attributed human parts, closed blocks, and turn ends', () => {
  const row = { agentId: 'main', time: 12 };
  expect(projectKimiWire({ ...row, type: 'turn.prompt', input: [{ type: 'text', text: 'not projected twice' }] })).toBeUndefined();
  expect(projectKimiWire({ ...row, type: 'context.append_message', message: { id: 'm', role: 'user', origin: { kind: 'user' }, content: [
    { type: 'text', text: 'hidden', meta: { source: 'user prompt submit hook' } },
    { type: 'text', text: 'Actual prompt' },
  ] } })).toMatchObject({ kind: 'prompt', id: 'm', text: 'Actual prompt' });
  expect(projectKimiWire({ ...row, type: 'context.append_message', message: { role: 'user', origin: { kind: 'injection' }, content: [
    { type: 'text', text: 'not the human' },
  ] } })).toBeUndefined();
  expect(projectKimiWire({ ...row, type: 'context.append_message', message: { role: 'user', content: [
    { type: 'text', text: 'unknown provenance' },
  ] } })).toMatchObject({ kind: 'unsupported' });
  expect(projectKimiWire({ ...row, type: 'context.append_loop_event', event: {
    type: 'content.part', uuid: 'part', stepUuid: 'step', part: { type: 'text', text: 'Closed block' },
  } })).toMatchObject({ kind: 'text', id: 'part', text: 'Closed block' });
  expect(projectKimiWire({ ...row, type: 'context.append_loop_event', event: { type: 'step.end' } })).toBeUndefined();
  expect(projectKimiWire({ ...row, type: 'turn.ended', reason: 'completed' })).toMatchObject({ kind: 'end', reason: 'completed' });
});
