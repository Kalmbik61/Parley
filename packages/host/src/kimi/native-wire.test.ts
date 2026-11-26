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
  expect(await prove()).toBe('unavailable');
  await writeFile(file, header + row + '\n{"type":"unknown"}\n');
  expect(await prove()).toBe('unsafe');
});

it('separates an empty conversation from Parley and third-party MCP availability', async () => {
  const failure = { type: 'mcp.server_failed', agentId: 'main', serverName: 'other', transport: 'stdio', error: 'Connection closed' };
  const recovered = { type: 'mcp.server_failure_resolved', agentId: 'main', serverName: 'other', transport: 'stdio', resolution: 'recovered' };
  const discovery = { type: 'mcp.tools_discovered', agentId: 'main', serverName: 'parley',
    tools: [{ name: 'get_map' }], enabledNames: ['get_map'] };
  async function prove(...rows: object[]) {
    await writeFile(file, header + rows.map(row => JSON.stringify(row) + '\n').join(''));
    return proveKimiEmptyStartup({ home, cwd, sessionId }, ['get_map']);
  }
  expect(await prove(failure)).toBe('empty');
  expect(await prove(failure, discovery, { ...failure, serverName: 'another', transport: 'http' })).toBe('ready');
  expect(await prove(failure, discovery, recovered)).toBe('ready');
  expect(await prove({ ...failure, error: undefined }, discovery)).toBe('ready');
  const parleyDown = { ...failure, serverName: 'parley' };
  const parleyUp = { ...recovered, serverName: 'parley' };
  expect(await prove(discovery, parleyDown)).toBe('unavailable');
  expect(await prove(parleyDown, parleyUp)).toBe('unavailable');
  expect(await prove(parleyDown, discovery, parleyUp)).toBe('ready');
  expect(await prove(parleyDown, { type: 'turn.prompt' })).toBe('unsafe');
  expect(await prove(discovery, { ...failure, serverName: undefined })).toBe('ready');
  expect(await prove(discovery, { ...parleyDown, agentId: 'child' })).toBe('ready');
  expect(await prove(failure, { ...discovery, enabledNames: [] })).toBe('unavailable');
  expect(await prove(discovery, failure, { type: 'turn.prompt' })).toBe('unsafe');
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

it('detects the 2.8.1 unload_tools poison and rejects lookalike failures', () => {
  const tool = 'mcp__figma-dev-mode-mcp-server__add_code_connect_map';
  const error = { code: 'provider.api_error', name: 'APIStatusError', retryable: false,
    details: { requestId: null, statusCode: 400, traceId: 'f6188d4db48049d065441bbad337ca65' },
    message: `unload_tools at message position 168: tool "${tool}" is not declared or has already been unloaded` };
  const row = { type: 'turn.ended', agentId: 'main', time: 12, reason: 'failed', error };
  expect(projectKimiWire(row)).toEqual({ kind: 'end', reason: 'failed', at: 12, poison: { tool } });
  // The real wire also carries other 400 provider.api_error failures: they must not match.
  const schemaError = { ...error, message: "tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'root': schema exceeds maximum allowed size>" };
  expect(projectKimiWire({ ...row, error: schemaError })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, reason: 'completed' })).toEqual({ kind: 'end', reason: 'completed', at: 12 });
  expect(projectKimiWire({ ...row, reason: 'cancelled' })).toEqual({ kind: 'end', reason: 'cancelled', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, code: 'provider.other_error' } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, details: { ...error.details, statusCode: 500 } } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, details: { ...error.details, statusCode: '400' } } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, message: `unload_tools at message position 168: tool "${tool}" is not declared` } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, message: error.message.replace('position 168', 'position') } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, message: error.message.replace(tool, 'x'.repeat(513)) } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: { ...error, message: undefined } })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, error: undefined })).toEqual({ kind: 'end', reason: 'failed', at: 12 });
  expect(projectKimiWire({ ...row, agentId: 'child' })).toBeUndefined();
});

it('projects only human steering as a prompt with the durable message identity', () => {
  const row = {
    type: 'prompt.steered', agentId: 'main', time: 111, activePromptId: 'msg_initial',
    promptIds: ['msg_followup'], messageId: 'msg_followup', content: [{ type: 'text', text: 'change direction' }],
  };
  expect(projectKimiWire(row)).toEqual({ kind: 'steer', id: 'msg_followup', text: 'change direction', at: 111 });
  expect(projectKimiWire({ ...row, messageId: 'task:bash-fixture:completed' })).toBeUndefined();
  expect(projectKimiWire({ ...row, agentId: 'child' })).toBeUndefined();
});

it('projects a main-agent model step as activity without exposing reasoning as Chat text', () => {
  const row = { type: 'context.append_loop_event', agentId: 'main', time: 112 };
  const step = { type: 'step.begin', uuid: '598524f9-81df-4631-875c-1120b035a121' };
  expect(projectKimiWire({ ...row, event: step })).toEqual({ kind: 'working', at: 112 });
  expect(projectKimiWire({ ...row, agentId: 'child', event: step })).toBeUndefined();
  expect(projectKimiWire({ ...row, event: { type: 'content.part', uuid: 'part', part: { type: 'think', text: 'private' } } })).toBeUndefined();
});

it('recognizes the stock 2.8 bulk-steer UUID without accepting task IDs or mismatched evidence', () => {
  const id = '84673fd7-c881-4344-a4c4-136b70d408ab';
  const row = {
    type: 'prompt.steered', agentId: 'main', time: 112, activePromptId: 'msg_first',
    promptIds: [id], messageId: id, content: [{ type: 'text', text: 'change direction' }],
  };
  expect(projectKimiWire(row)).toEqual({ kind: 'steer', id, text: 'change direction', at: 112 });
  expect(projectKimiWire({ ...row, promptIds: ['msg_other'] })).toBeUndefined();
  const task = 'task:agent-fixture:completed';
  expect(projectKimiWire({ ...row, promptIds: [task], messageId: task })).toBeUndefined();
});

it('projects stock lifecycle without agentId but never infers an agent from task rows', () => {
  const spawned = { type: 'subagent.spawned', subagentId: 'agent-0', subagentName: 'explore',
    description: 'Inspect fixture', model: 'fixture-model', runInBackground: true, parentToolCallId: 'call-1',
    parentAgentId: 'main', callerAgentId: 'main', time: 31 };
  expect(projectKimiWire(spawned)).toMatchObject({ kind: 'subagent', phase: 'spawned', id: 'agent-0',
    name: 'explore', description: 'Inspect fixture', model: 'fixture-model', background: true, toolUseId: 'call-1', at: 31 });
  for (const [phase, evidence, result] of [
    ['started', {}, undefined], ['completed', { resultSummary: 'Done' }, 'Done'],
    ['failed', { error: 'Failed' }, 'Failed'], ['cancelled', {}, undefined],
  ] as const) {
    expect(projectKimiWire({ type: 'subagent.' + phase, subagentId: 'agent-0', time: 32, ...evidence }))
      .toMatchObject({ kind: 'subagent', phase, id: 'agent-0', at: 32, ...(result === undefined ? {} : { result }) });
  }
  for (const id of [null, '', 'main', '../agent-0']) expect(projectKimiWire({ ...spawned, subagentId: id })).toBeUndefined();
  expect(projectKimiWire({ ...spawned, type: 'subagent.unknown' })).toBeUndefined();
  expect(projectKimiWire({ ...spawned, type: 'task.started', info: { kind: 'bash' } })).toBeUndefined();
});

it('bounds cold catch-up at the opening file size and leaves concurrent appends to the live reader', async () => {
  const padding = JSON.stringify({ type: 'fixture.padding', text: 'x'.repeat(256 * 1024) }) + '\n';
  const terminal = '{"type":"subagent.completed","subagentId":"agent-0","resultSummary":"Done"}\n';
  await writeFile(file, header + padding);
  const cold = await createKimiWire({ home, cwd, sessionId }, { snapshot: true });
  expect(await cold.read()).toMatchObject({ more: true });
  await appendFile(file, terminal);
  expect((await cold.read()).rows.map(row => row.type)).toEqual(['fixture.padding']);
  expect(await cold.read()).toEqual({ rows: [] });
  const live = await createKimiWire({ home, cwd, sessionId });
  expect(await live.read()).toMatchObject({ more: true });
  expect((await live.read()).rows.map(row => row.type)).toEqual(['fixture.padding', 'subagent.completed']);
});

it('tails lifecycle but not conversation rows from a discovered child created after its spawn', async () => {
  await writeFile(file, header + '{"type":"subagent.spawned","subagentId":"agent-0","subagentName":"explore","runInBackground":true}\n');
  const live = await createKimiWire({ home, cwd, sessionId });
  expect((await live.read()).rows.map(row => row.type)).toEqual(['subagent.spawned']);
  const child = path.join(path.dirname(path.dirname(file)), 'agent-0', 'wire.jsonl');
  await mkdir(path.dirname(child));
  await writeFile(child, header +
    '{"type":"subagent.spawned","subagentId":"agent-1","subagentName":"explore","parentAgentId":"agent-0","runInBackground":true}\n' +
    '{"type":"turn.ended","agentId":"agent-0","reason":"completed"}\n');
  expect((await live.read()).rows).toMatchObject([{ type: 'subagent.spawned', subagentId: 'agent-1' }]);
  await appendFile(child, '{"type":"subagent.cancelled","subagentId":"agent-1"}\n');
  // A poll services one discovered child per turn.
  const rows = [...(await live.read()).rows, ...(await live.read()).rows];
  expect(rows).toMatchObject([{ type: 'subagent.cancelled', subagentId: 'agent-1' }]);
});
