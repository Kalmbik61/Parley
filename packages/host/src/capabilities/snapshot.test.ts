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

it('ignores foreign repository location/config env and verifies the queried checkout membership', async () => {
 const a = path.join(root, 'repo-a'); const b = path.join(root, 'repo-b'); const linked = path.join(root, 'linked-a');
 const env: NodeJS.ProcessEnv = { ...process.env, HOME: context.homeDir, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
 delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_COMMON_DIR;
 const git = async (args: string[]) => promisify(execFile)('git', args, { env, timeout: 3000 });
 for (const folder of [a, b]) {
  await git(['init', folder]);
  await git(['-C', folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture']);
 }
 await git(['-C', a, 'worktree', 'add', '-b', 'fixture', linked]);
 const poisoned = { ...env, GIT_DIR: path.join(b, '.git'), GIT_COMMON_DIR: path.join(b, '.git'), GIT_WORK_TREE: b,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: b };
 expect(await findMainCheckout(a, poisoned)).toBe(a);
 expect(await findMainCheckout(linked, poisoned)).toBe(a);
 expect(await findMainCheckout(root, poisoned)).toBeNull();
});


import { allow, contextFingerprint, fingerprint, deny } from './native-targets.js';
import { createCapabilitiesMcpActions } from './actions.js';

it('keeps private raw selectors out of snapshot/events and revalidates config/context before dispatch', async () => {
 const events: CapabilitySnapshot[] = []; context.binaries.claude = '/fixture/claude'; let config = 'CONFIG_SECRET';
 const reader = async (): Promise<ProviderSnapshotResult> => ({ entries: [{ kind: 'mcp', name: '[redacted]', presence: {
  id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null,
 } }], diagnostics: [], phase: 'ready', native: {
  contextFingerprint: contextFingerprint(context, 'claude'), signature: fingerprint(config), names: ['RAW_SELECTOR_SECRET'],
  targets: [{ id: 'opaque', provider: 'claude', name: 'RAW_SELECTOR_SECRET', scope: 'user', fingerprint: fingerprint(config), remove: allow(), check: allow() }],
  add: { user: allow(), project: allow(), local: allow() },
 } });
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: reader, codex: async () => ready() }, changed: (_project, value) => events.push(value) });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('ready'));
 const params = { projectPath: root, provider: 'claude' as const, presenceId: 'opaque', revision: service.get(root).revision };
 expect(JSON.stringify([service.get(root), events])).not.toContain('SECRET');
 const prepared = await service.prepareMcpAction(params); expect(prepared.ok && prepared.target?.name).toBe('RAW_SELECTOR_SECRET');
 config = 'CHANGED'; expect(await service.prepareMcpAction(params)).toEqual({ ok: false, code: 'context-changed' });
 context.env = { KEY: 'NEW_ENV_SECRET' }; expect(await service.prepareMcpAction(params)).toEqual({ ok: false, code: 'context-changed' });
 service.refresh(root); expect(await service.prepareMcpAction(params)).toEqual({ ok: false, code: 'stale' });
 service.dispose(); expect(await service.prepareMcpAction(params)).toEqual({ ok: false, code: 'shutdown' });
});

it('retains only fingerprint-matched explicit Check health across action refresh', async () => {
 context.binaries.claude = '/fixture/claude'; let version = 1;
 const reader = async (): Promise<ProviderSnapshotResult> => ({ entries: [{ kind: 'mcp', name: 'example', presence: {
  id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: true, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null,
 } }], diagnostics: [], phase: 'ready', native: {
  contextFingerprint: contextFingerprint(context, 'claude'), signature: fingerprint(version), names: ['example'],
  targets: [{ id: 'opaque', provider: 'claude', name: 'example', scope: 'user', fingerprint: fingerprint(version), remove: allow(), check: allow() }],
  add: { user: allow(), project: allow(), local: allow() },
 } });
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: reader, codex: async () => ready() } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('ready'));
 const actions = createCapabilitiesMcpActions(service, async () => ({ code: 'ok', stdout: Buffer.from('example:\n Scope: User config\n Status: ✔ Connected\n SECRET') }));
 expect((await actions.check({ projectPath: root, provider: 'claude', presenceId: 'opaque', revision: service.get(root).revision })).status).toBe('ok');
 await vi.waitFor(() => expect(service.get(root).rows.find(row => row.name === 'example')?.claude[0]?.status).toBe('ok'));
 version = 2; service.refresh(root);
 await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('ready'));
 expect(service.get(root).rows.find(row => row.name === 'example')?.claude[0]?.status).toBe('unknown'); actions.dispose(); service.dispose();
});

it('does not advertise actions from unassociated injected targets or builtin records', async () => {
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready(), codex: async () => ready() } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
 const builtin = service.get(root).rows.find(row => row.name === 'parley')!.codex[0]!;
 expect(builtin.mcpActions).toEqual({ remove: deny('builtin'), check: deny('builtin') });
 expect(await service.prepareMcpAction({ projectPath: root, provider: 'codex', presenceId: builtin.id, revision: service.get(root).revision })).toEqual({ ok: false, code: 'unverified' }); service.dispose();
});


it('prevents Add from shadowing the confirmed launch builtin', async () => {
 context.binaries.codex = '/fixture/codex';
 const reader = async (): Promise<ProviderSnapshotResult> => ({ ...ready(), native: {
  contextFingerprint: contextFingerprint(context, 'codex'), signature: 'stable', names: [], targets: [],
  add: { user: allow(), project: deny('unsupported-scope'), local: deny('unsupported-scope') },
 } });
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready(), codex: reader } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
 const execute = vi.fn(); const actions = createCapabilitiesMcpActions(service, execute);
 expect(await actions.add({ projectPath: root, provider: 'codex', revision: service.get(root).revision, scope: 'user', name: 'parley', input: { kind: 'stdio', command: 'node' } })).toEqual({ outcome: 'denied', code: 'conflict' });
 expect(execute).not.toHaveBeenCalled(); actions.dispose(); service.dispose();
});


import { chmod } from 'node:fs/promises';
import { readBinaryIdentity } from './native-targets.js';

it('rechecks Codex bytes after fresh source proof and prevents dispatch if the executable changes in that window', async () => {
 const executable = path.join(root, 'codex-native'); await writeFile(executable, 'native fixture'); await chmod(executable, 0o700); context.binaries.codex = executable;
 const identity = (await readBinaryIdentity(executable, context))!; let replaceAfterProof = false;
 const reader = async (): Promise<ProviderSnapshotResult> => {
  if (replaceAfterProof) { replaceAfterProof = false; await writeFile(executable, 'changed after proof'); }
  return { entries: [{ kind: 'mcp', name: 'example', presence: { id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null } }], diagnostics: [], phase: 'ready', native: {
   contextFingerprint: contextFingerprint(context, 'codex'), signature: 'unchanged-source-proof', names: ['example'], executionBinary: executable, binaryIdentity: identity,
   targets: [{ id: 'opaque', provider: 'codex', name: 'example', scope: 'user', fingerprint: 'unchanged-target', remove: allow(), check: deny('native-only') }],
   add: { user: allow(), project: deny('unsupported-scope'), local: deny('unsupported-scope') },
  } };
 };
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: async () => ready(), codex: reader } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
 const execute = vi.fn(); const actions = createCapabilitiesMcpActions(service, execute); replaceAfterProof = true;
 expect(await actions.remove({ projectPath: root, provider: 'codex', presenceId: 'opaque', revision: service.get(root).revision })).toEqual({ outcome: 'denied', code: 'context-changed' });
 expect(execute).not.toHaveBeenCalled(); actions.dispose(); service.dispose();
});

function healthFixture() {
 context.binaries.claude = '/fixture/claude';
 const originalEnv = context.env; const originalClaude = context.claude;
 let signature = 'source-proof'; let selector = 'example'; let checkAllowed = true; let binaryDigest = 'binary-proof'; let includeTarget = true;
 const reader = async (): Promise<ProviderSnapshotResult> => ({ entries: [{ kind: 'mcp', name: 'example', presence: {
  id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: checkAllowed ? true : null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null,
 } }], diagnostics: [], phase: 'ready', native: {
  contextFingerprint: contextFingerprint(context, 'claude'), signature, names: [selector],
  binaryIdentity: { canonicalPath: '/fixture/claude', sha256: binaryDigest, size: 1 },
  targets: includeTarget ? [{ id: 'opaque', provider: 'claude', name: selector, scope: 'user', fingerprint: 'unchanged-config', remove: allow(), check: checkAllowed ? allow() : deny() }] : [],
  add: { user: allow(), project: allow(), local: allow() },
 } });
 const service = createSafeCapabilitiesService({ context: async () => context, readers: { claude: reader, codex: async () => ready() } });
 const loaded = async (): Promise<void> => { await vi.waitFor(() => expect(service.get(root).columns.claude.phase).toBe('ready')); };
 const status = () => service.get(root).rows.find(row => row.name === 'example')?.claude[0]?.status;
 const change = (kind: string): void => {
  if (kind === 'policy') context.claude = { mcpPolicy: { verified: false } };
  else if (kind === 'winner') selector = 'different-effective-name';
  else if (kind === 'inventory') signature = 'different-source-proof';
  else if (kind === 'binary') binaryDigest = 'different-bytes';
  else if (kind === 'context') context.env = { ...context.env, CONFIG_CONTEXT: 'changed' };
  else if (kind === 'check') checkAllowed = false;
  else if (kind === 'absent') includeTarget = false;
 };
 service.get(root);
 const reset = (): void => { if (originalClaude === undefined) delete context.claude; else context.claude = originalClaude; if (originalEnv === undefined) delete context.env; else context.env = originalEnv; signature = 'source-proof'; selector = 'example'; checkAllowed = true; binaryDigest = 'binary-proof'; includeTarget = true; };
 return { service, loaded, status, change, reset };
}
const connectedOutput = Buffer.from('example:\n Scope: User config\n Status: ✔ Connected');

it.each(['policy', 'winner', 'inventory', 'binary', 'context', 'check', 'absent'])('invalidates effective Check health when %s proof changes and does not resurrect it', async kind => {
 const fixture = healthFixture(); await fixture.loaded();
 const actions = createCapabilitiesMcpActions(fixture.service, async () => ({ code: 'ok', stdout: connectedOutput }));
 try {
  expect((await actions.check({ projectPath: root, provider: 'claude', presenceId: 'opaque', revision: fixture.service.get(root).revision })).status).toBe('ok');
  await fixture.loaded(); expect(fixture.status()).toBe('ok');
  fixture.change(kind); fixture.service.refresh(root); await fixture.loaded(); expect(fixture.status()).toBe('unknown');
  fixture.reset(); fixture.service.refresh(root); await fixture.loaded(); expect(fixture.status()).toBe('unknown');
 } finally { actions.dispose(); fixture.service.dispose(); }
});

it.each(['policy', 'winner', 'inventory', 'binary', 'context', 'check'])('does not record in-flight Check health into a refreshed %s proof', async kind => {
 const fixture = healthFixture(); await fixture.loaded();
 let started!: () => void; let complete!: () => void;
 const executing = new Promise<void>(resolve => { started = resolve; });
 const release = new Promise<void>(resolve => { complete = resolve; });
 const actions = createCapabilitiesMcpActions(fixture.service, async () => { started(); await release; return { code: 'ok', stdout: connectedOutput }; });
 try {
  const checking = actions.check({ projectPath: root, provider: 'claude', presenceId: 'opaque', revision: fixture.service.get(root).revision });
  await executing; fixture.change(kind); fixture.service.refresh(root); await fixture.loaded(); complete();
  expect(await checking).toMatchObject({ outcome: 'denied', code: 'context-changed', status: 'unknown' });
  await fixture.loaded(); expect(fixture.status()).toBe('unknown');
 } finally { complete(); actions.dispose(); fixture.service.dispose(); }
});

it('retains effective Check health after an unchanged proof refresh while Check executes', async () => {
 const fixture = healthFixture(); await fixture.loaded();
 let started!: () => void; let complete!: () => void;
 const executing = new Promise<void>(resolve => { started = resolve; });
 const release = new Promise<void>(resolve => { complete = resolve; });
 const actions = createCapabilitiesMcpActions(fixture.service, async () => { started(); await release; return { code: 'ok', stdout: connectedOutput }; });
 try {
  const checking = actions.check({ projectPath: root, provider: 'claude', presenceId: 'opaque', revision: fixture.service.get(root).revision });
  await executing; fixture.service.refresh(root); await fixture.loaded(); complete();
  expect((await checking).status).toBe('ok'); await fixture.loaded(); expect(fixture.status()).toBe('ok');
 } finally { complete(); actions.dispose(); fixture.service.dispose(); }
});

import type { NativePluginInventory } from './native-plugin-inventory.js';
async function pluginServiceFixture() {
 const executable = path.join(root, 'codex-plugin'); await writeFile(executable, 'native fixture'); await chmod(executable, 0o700);
 context.binaries.codex = executable; const identity = (await readBinaryIdentity(executable, context))!;
 const actions = { install: deny(), uninstall: allow(), enable: deny('native-only'), disable: deny('native-only'), details: deny('native-only') };
 const inventory: NativePluginInventory = { provider: 'codex', contextFingerprint: contextFingerprint(context, 'codex'), signature: 'source-proof', executionBinary: executable, binaryIdentity: identity,
 targets: [{ id: 'opaque-plugin', kind: 'installed', nativeId: 'PRIVATE_SELECTOR@market', scope: 'user', fingerprint: 'target-proof', sourceFingerprint: null, actions,
 summary: { id: 'opaque-plugin', kind: 'installed', provider: 'codex', name: 'safe', pluginId: 'safe@market', description: null, version: null, scope: 'user', enabled: null,
 composition: { skills: null, agents: null, mcp: null, hooks: null, tokenEstimate: null }, actions } }], marketplaceNames: [], installScopes: { user: allow(), project: deny(), local: deny() }, marketplaceAdd: { user: allow(), project: deny(), local: deny() }, catalog: allow(), partial: false };
 const readPluginInventory = vi.fn(async () => structuredClone(inventory));
 const reader = async (): Promise<ProviderSnapshotResult> => ({ entries: [{ kind: 'plugin', name: 'safe', presence: { id: 'opaque-plugin', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null } }], phase: 'ready', diagnostics: [], pluginsNative: structuredClone(inventory) });
 const service = createSafeCapabilitiesService({ context: async () => context, readPluginInventory, readers: { claude: async () => ready(), codex: reader } });
 service.get(root); await vi.waitFor(() => expect(service.get(root).columns.codex.phase).toBe('ready'));
 return { service, inventory, executable, readPluginInventory, params: { projectPath: root, provider: 'codex' as const, presenceId: 'opaque-plugin', revision: service.get(root).revision } };
}
it('revalidates private plugin identity without publishing its selector, config or byte proof', async () => {
 const fixture = await pluginServiceFixture();
 try {
  expect((await fixture.service.preparePluginAction(fixture.params)).ok).toBe(true);
  const snapshot = JSON.stringify(fixture.service.get(root));
  expect(snapshot).not.toContain('PRIVATE_SELECTOR'); expect(snapshot).not.toContain('source-proof'); expect(snapshot).not.toContain(fixture.executable);
  fixture.inventory.signature = 'changed-winning-layer';
  expect(await fixture.service.preparePluginAction(fixture.params)).toEqual({ ok: false, code: 'context-changed' });
 } finally { fixture.service.dispose(); }
});
it('rejects a plugin target when captured bytes, main context or ownership change', async () => {
 const fixture = await pluginServiceFixture();
 try {
  await writeFile(fixture.executable, 'replacement bytes');
  expect(await fixture.service.preparePluginAction(fixture.params)).toEqual({ ok: false, code: 'context-changed' });
  await writeFile(fixture.executable, 'native fixture');
  fixture.inventory.targets[0]!.scope = null;
  expect(await fixture.service.preparePluginAction(fixture.params)).toEqual({ ok: false, code: 'context-changed' });
  fixture.inventory.targets[0]!.scope = 'user';context.env = { HOME: '/different-context' };
  expect(await fixture.service.preparePluginAction(fixture.params)).toEqual({ ok: false, code: 'context-changed' });
 } finally { fixture.service.dispose(); }
});
it('does not dispatch captured plugin work if Refresh finishes during fresh provenance inspection', async () => {
 const fixture = await pluginServiceFixture(); const gate = deferred<NativePluginInventory>(); fixture.readPluginInventory.mockImplementationOnce(() => gate.promise);
 try {
  const preparing = fixture.service.preparePluginAction(fixture.params);
  await vi.waitFor(() => expect(fixture.readPluginInventory).toHaveBeenCalledOnce());
  fixture.service.refresh(root); await vi.waitFor(() => expect(fixture.service.get(root).columns.codex.phase).toBe('ready'));
  gate.resolve(fixture.inventory); expect(await preparing).toEqual({ ok: false, code: 'stale' });
 } finally { fixture.service.dispose(); }
});
