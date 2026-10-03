import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodexSnapshot } from './codex.js';
import type { SnapshotContext } from './snapshot.js';
let root: string; let context: SnapshotContext;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p15-codex-'))); context = {
 projectPath: root, homeDir: path.join(root, 'home'), binaries: { claude: null, codex: '/fixture/codex' }, codex: { configLayers: [], roots: [] },
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
  expect(calls).toEqual([['mcp', 'list', '--json'], ['plugin', 'list', '--json']]);
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
