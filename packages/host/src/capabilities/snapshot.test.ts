import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSafeCapabilitiesService, mergeSnapshotRows } from './snapshot.js';
import type { ProviderSnapshotResult, SnapshotContext } from './snapshot.js';
import type { SnapshotEntry } from './redact.js';
import type { CapabilityProvider, CapabilitySnapshot } from '@parley/protocol';
let root: string; let context: SnapshotContext;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p15-service-'))); context = { projectPath: root, homeDir: path.join(root, 'home'), binaries: { claude: null, codex: null } }; await mkdir(context.homeDir); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const entry = (provider: CapabilityProvider, document: string, name = 'review'): SnapshotEntry => ({ kind: 'skill', name, presence: {
 id: JSON.stringify([provider, 'skill', document]), scope: 'project', source: document, documentPath: document,
 description: 'Review code', installed: true, enabled: true, status: 'ok', summary: null, modelAvailable: true, unavailableReason: null,
} });
const ready = (entries: SnapshotEntry[] = []): ProviderSnapshotResult => ({ entries, diagnostics: [], phase: 'ready' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

 describe('memory capability snapshots', () => {
 it('publishes a ready column before another finishes; get is immediate and does not refresh', async () => {
  const pending = deferred<ProviderSnapshotResult>(); const events: CapabilitySnapshot[] = [];
  const claude = vi.fn(async () => ready([entry('claude', '/fixture/claude/SKILL.md')]));
  const codex = vi.fn(() => pending.promise);
  const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude, codex }, changed: (_project, snapshot) => events.push(snapshot) });
  expect(service.get(root).columns.claude.phase).toBe('loading');
  await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('ready'));
  expect(service.get(root).columns.codex.phase).toBe('loading'); expect(events).toHaveLength(1);
  service.get(root); expect(claude).toHaveBeenCalledTimes(1);
  pending.resolve(ready()); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
  const returned = service.get(root); returned.rows.splice(0); expect(service.get(root).rows.length).toBeGreaterThan(0);
  expect(service.get(root).rows.find(row => row.kind === 'mcp' && row.name === 'parley')?.claude[0]).toMatchObject({ scope: 'builtin', enabled: null, status: 'unknown' });
  service.dispose();
 });
 it('ignores stale completion after a newer refresh and shutdown', async () => {
  const old = deferred<ProviderSnapshotResult>(); let calls = 0; const events: CapabilitySnapshot[] = [];
  const service = createSafeCapabilitiesService({ context: async () => context,
    readers: { claude: async () => ++calls === 1 ? old.promise : ready([entry('claude', '/new/SKILL.md', 'new')]), codex: async () => ready() },
    changed: (_project, snapshot) => events.push(snapshot) });
  service.get(root); await vi.waitFor(() => expect(calls).toBe(1)); service.refresh(root);
  await vi.waitFor(() => expect(service.get(root).rows.some(row => row.name === 'new')).toBe(true));
  const revision = service.get(root).revision;
  old.resolve(ready([entry('claude', '/old/SKILL.md', 'old')]));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(service.get(root).revision).toBe(revision); expect(events.some(snapshot => snapshot.rows.some(row => row.name === 'old'))).toBe(false);
  service.dispose();
 });
 it('preserves same-name provider identities and keeps plugins provider-qualified', () => {
  const plugin = (provider: CapabilityProvider): SnapshotEntry => ({ kind: 'plugin', name: 'same', presence: {
    ...entry(provider, '/unused').presence, id: `${provider}:plugin`, scope: null, documentPath: null, modelAvailable: null,
  } });
  const rows = mergeSnapshotRows({ claude: [entry('claude', '/a'), plugin('claude')], codex: [entry('codex', '/b'), entry('codex', '/c'), plugin('codex')] });
  expect(rows.filter(row => row.kind === 'plugin')).toHaveLength(2);
  expect(rows.find(row => row.kind === 'skill')).toMatchObject({ separateCopies: true, codex: expect.any(Array) });
  expect(rows.find(row => row.kind === 'skill')?.codex).toHaveLength(2);
 });
 it('only records sharedFrom after checking an actual provider source symlink', async () => {
  const folder = path.join(root, '.agents/skills/review'); await mkdir(folder, { recursive: true });
  const document = path.join(folder, 'SKILL.md'); await writeFile(document, 'Skill');
  await mkdir(path.join(root, '.claude/skills'), { recursive: true }); await symlink(folder, path.join(root, '.claude/skills/review'));
  const service = createSafeCapabilitiesService({ context: async () => context, readers: {
    claude: async () => ready([entry('claude', document)]), codex: async () => ready([entry('codex', document)]),
  } });
  service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
  await vi.waitFor(() => expect(service.get(root).rows.find(row => row.name === 'review')?.claude[0]?.sharedFrom).toBe('codex'));
  expect(service.get(root).rows.find(row => row.name === 'review')).toMatchObject({ separateCopies: false });
  expect(service.get(root).rows.find(row => row.name === 'review')?.codex[0]?.sharedFrom).toBeUndefined(); service.dispose();
 });
 it('canonical equality without a source symlink does not fabricate sharedFrom', async () => {
  const document = path.join(root, 'same/SKILL.md'); await mkdir(path.dirname(document)); await writeFile(document, 'Skill');
  const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready([entry('claude', document)]), codex: async () => ready([entry('codex', document)]) } });
  service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
  const row = service.get(root).rows.find(row => row.name === 'review');
  expect(row?.claude[0]?.sharedFrom).toBeUndefined(); expect(row?.codex[0]?.sharedFrom).toBeUndefined(); service.dispose();
 });
 it('marks builtin skill only for matching current receipt content; edits remain foreign', async () => {
  const folder = path.join(root, '.agents/skills/parley'); await mkdir(folder, { recursive: true });
  const document = path.join(folder, 'SKILL.md'); const text = 'Owned skill PRIVATE_BODY'; await writeFile(document, text);
  await mkdir(path.join(root, '.parley')); await writeFile(path.join(root, '.parley/skills-receipt.json'), JSON.stringify({ version: 1, entries: { [folder]: { kind: 'dir', sha256: createHash('sha256').update(text).digest('hex') } } }));
  const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready(), codex: async () => ready([entry('codex', document, 'parley')]) } });
  service.get(root); await vi.waitFor(() => expect(service.get(root).rows.find(row => row.kind === 'skill')?.codex[0]?.scope).toBe('builtin'));
  expect(JSON.stringify(service.get(root))).not.toContain('PRIVATE_BODY');
  await writeFile(document, 'Edited'); service.refresh(root);
  await vi.waitFor(() => expect(service.get(root).rows.find(row => row.kind === 'skill')?.codex[0]?.scope).toBe('project')); service.dispose();
 });
 it('drops raw extras and safely isolates a failed column without logs/error excerpts', async () => {
  const value = entry('claude', '/fixture/SKILL.md'); Object.assign(value.presence, { env: { SECRET: 'FIXTURE_SECRET' }, stdout: 'FIXTURE_SECRET' });
  const events: CapabilitySnapshot[] = [];
  const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready([value]), codex: async () => { throw new Error('FIXTURE_SECRET'); } }, changed: (_project, snapshot) => events.push(snapshot) });
  service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('error'));
  expect(service.get(root).columns.claude.phase).toBe('ready');
  expect(JSON.stringify([service.get(root), events])).not.toContain('FIXTURE_SECRET'); service.dispose();
 });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findMainCheckout } from './snapshot.js';

it('native Git identity resolves a linked checkout to its main record, including unusual path characters', async () => {
 const main = path.join(root, 'main\ncheckout'); const linked = path.join(root, 'linked'); await mkdir(main);
 const env: NodeJS.ProcessEnv = { ...process.env, HOME: context.homeDir, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
 delete env.GIT_DIR; delete env.GIT_WORK_TREE;
 const git = async (args: string[]) => promisify(execFile)('git', args, { env, timeout: 3000 });
 await git(['init', main]); await git(['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture']);
 await git(['-C', main, 'worktree', 'add', '-b', 'fixture', linked]);
 expect(await findMainCheckout(linked, env)).toBe(main);
 expect(await findMainCheckout(root, env)).toBeNull();
});

it('limits snapshot wire volume with an explicit partial diagnostic instead of a complete claim', async () => {
 const values = Array.from({ length: 100 }, (_, index) => ({ ...entry('claude', `/doc/${index}`), presence: {
   ...entry('claude', `/doc/${index}`).presence, description: 'd'.repeat(65_536),
 } }));
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready(values), codex: async () => ready() } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('partial'));
 expect(service.get(root).columns.claude.diagnostics).toContainEqual(expect.objectContaining({ code: 'output-limit' }));
 expect(service.get(root).rows.find(row => row.kind === 'mcp' && row.name === 'parley')?.claude[0]?.scope).toBe('builtin');
 expect(Buffer.byteLength(JSON.stringify(service.get(root)))).toBeLessThan(8 * 1024 * 1024); service.dispose();
});
