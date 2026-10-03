import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodexSnapshot } from './codex.js';
import type { SnapshotContext } from './snapshot.js';
let root: string; let context: SnapshotContext;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p15-codex-'))); context = {
 projectPath: root, homeDir: path.join(root, 'home'), env: { HOME: path.join(root, 'home') }, binaries: { claude: null, codex: '/fixture/codex' }, codex: { configLayers: [], roots: [] },
}; await mkdir(context.homeDir); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Codex safe snapshot', () => {
 it('projects metadata without declaring auth metadata Connected or fabricating plugin/MCP scope', async () => {
  const calls: string[][] = [];
  const result = await readCodexSnapshot(context, { readNative: async (binary, args) => {
   expect(binary).toBe('/fixture/codex'); calls.push([...args]);
   return { status: 'valid', data: args[0] === 'mcp' ? [
    { name: 'http', enabled: true, auth_status: 'bearer_token', transport: { url: 'https://user:FIXTURE_SECRET@example.com/private?key=FIXTURE_SECRET', http_headers: { Authorization: 'FIXTURE_SECRET' } } },
    { name: 'stdio', enabled: false, auth_status: 'unsupported', transport: { command: 'node', args: ['FIXTURE_SECRET'], env: { KEY: 'FIXTURE_SECRET' } } },
   ] : { installed: [{ pluginId: 'tool@market', enabled: true, installed: true, marketplaceName: 'market', description: 'Contains FIXTURE_SECRET' }], available: [{ pluginId: 'not-installed' }] } };
  } });
  expect(calls).toEqual([['mcp', 'list', '--json'], ['plugin', 'list', '--json'], ['plugin', 'list', '--available', '--json'], ['plugin', 'marketplace', 'list', '--json']]);
  expect(result.entries.map(entry => [entry.name, entry.presence.status, entry.presence.scope])).toEqual([['http', 'unknown', null], ['stdio', 'off', null], ['tool@market', 'unknown', null]]);
  expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET');
 });
 it('retains same-name canonical skills, hidden reason and source scope', async () => {
  const base = path.join(root, 'skills');
  for (const folder of ['a', 'b']) { await mkdir(path.join(base, folder), { recursive: true }); await writeFile(path.join(base, folder, 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nPRIVATE_BODY'); }
  context.codex = { roots: [{ path: base, source: 'admin' }], configLayers: [] };
  const result = await readCodexSnapshot(context, { readNative: async (_binary, args) => ({ status: 'valid', data: args[0] === 'mcp' ? [] : { installed: [] } }) });
  expect(result.entries).toHaveLength(2); expect(new Set(result.entries.map(entry => entry.presence.id)).size).toBe(2);
  expect(result.entries.every(entry => entry.presence.scope === 'admin' && entry.presence.modelAvailable === false)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY');
 });
 it('fails safely on wrong native list shapes and secrets in exceptions', async () => {
  const result = await readCodexSnapshot(context, { readNative: async (_binary, args) => { if (args[0] === 'mcp') throw new Error('FIXTURE_SECRET'); return { status: 'valid', data: [] }; } });
  expect(result.phase).toBe('partial'); expect(result.entries).toEqual([]); expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET');
 });
});


import { createSafeCapabilitiesService } from './snapshot.js';
import type { McpExecutor } from './actions.js';
import { createCapabilitiesMcpActions } from './actions.js';
import { vi } from 'vitest';

it('executes positive user/global remove only after native active-layer source proof and revalidation', async () => {
 const executable = path.join(root, 'codex-native'); await writeFile(executable, 'native fixture bytes'); await chmod(executable, 0o700); context.binaries.codex = executable;
 const file = path.join(context.homeDir, '.codex/config.toml'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '[mcp_servers.example]\ncommand="node"\n');
 const native = { config: { layers: [{ name: { type: 'user', file }, version: 'v1', config: { mcp_servers: { example: { command: 'node' } } } }] }, requirements: { requirements: null } };
 const readContext = vi.fn(async () => native);
 const readNative = vi.fn<import('./redact.js').NativeJsonReader>(async (_binary, argv) => ({ status: 'valid' as const, data: argv[0] === 'mcp' ? [{ name: 'example', enabled: true, transport: { type: 'stdio', command: 'node', args: [] } }] : { installed: [] } }));
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ({ entries: [], diagnostics: [], phase: 'ready' }) }, readCodexContext: readContext, readNative });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).not.toBe('loading'));
 const presence = service.get(root).rows.find(row => row.name === 'example')!.codex[0]!;
 expect(presence.scope).toBe('user'); expect(presence.mcpActions?.remove.allowed).toBe(true); expect(presence.mcpActions?.check).toEqual({ allowed: false, reason: 'native-only' });
 const execute = vi.fn<McpExecutor>(async () => ({ code: 'ok' as const })); const actions = createCapabilitiesMcpActions(service, execute);
 const result = await actions.remove({ projectPath: root, provider: 'codex', presenceId: presence.id, revision: service.get(root).revision });
 expect(result).toEqual({ outcome: 'ok', code: 'ok' }); expect(execute.mock.calls[0]?.[0]).toBe(executable); expect(execute.mock.calls[0]?.[1]).toEqual(['mcp', 'remove', 'example']); expect(readContext.mock.calls.length).toBeGreaterThanOrEqual(2);
 actions.dispose(); service.dispose();
});


it('rejects changed Codex bytes or canonical executable even when native config/list responses are unchanged', async () => {
 const executable = path.join(root, 'native-a'); const other = path.join(root, 'native-b'); const alias = path.join(root, 'codex-alias');
 await writeFile(executable, 'native fixture'); await writeFile(other, 'native fixture'); await chmod(executable, 0o700); await chmod(other, 0o700); await symlink(executable, alias); context.binaries.codex = alias;
 const file = path.join(context.homeDir, '.codex/config.toml'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '');
 const native = { config: { layers: [{ name: { type: 'user', file }, version: 'v1', config: { mcp_servers: { example: { command: 'node' } } } }] }, requirements: { requirements: null } };
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ({ entries: [], diagnostics: [], phase: 'ready' }) }, readCodexContext: async () => native,
  readNative: async (_binary, argv) => ({ status: 'valid', data: argv[0] === 'mcp' ? [{ name: 'example', enabled: true, transport: { command: 'node' } }] : { installed: [] } }) });
 const execute = vi.fn(); const actions = createCapabilitiesMcpActions(service, execute);
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).not.toBe('loading'));
 const params = () => ({ projectPath: root, provider: 'codex' as const, revision: service.get(root).revision, presenceId: service.get(root).rows.find(row => row.name === 'example')!.codex[0]!.id });
 await writeFile(executable, 'changed bytes'); expect(await actions.remove(params())).toEqual({ outcome: 'denied', code: 'context-changed' });
 service.refresh(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).not.toBe('loading'));
 await rm(alias); await symlink(other, alias); expect(await actions.remove(params())).toEqual({ outcome: 'denied', code: 'context-changed' });
 expect(execute).not.toHaveBeenCalled(); actions.dispose(); service.dispose();
});
