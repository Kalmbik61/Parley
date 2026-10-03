import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeSnapshot } from './claude.js';
import { readJsonFile } from './redact.js';
import type { SnapshotContext } from './snapshot.js';
let root: string; let context: SnapshotContext;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p15-claude-'))); context = {
  projectPath: path.join(root, 'worktree'), homeDir: path.join(root, 'home'), binaries: { claude: '/fixture/claude', codex: null },
  claude: { configDir: 'config', mainCheckout: path.join(root, 'main') },
}; for (const dir of [context.projectPath, context.homeDir, path.join(root, 'main'), path.join(context.projectPath, 'config')]) await mkdir(dir, { recursive: true }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const plugins = async () => ({ status: 'valid' as const, data: [] });

describe('Claude safe snapshot', () => {
  it('reads local main-checkout storage and this checkout project file without MCP CLI calls', async () => {
    const main = path.join(root, 'main');
    await writeFile(path.join(context.projectPath, 'config/.claude.json'), JSON.stringify({
      mcpServers: { user: { command: 'node', args: ['FIXTURE_SECRET'], env: { KEY: 'FIXTURE_SECRET' } } },
      projects: { [main]: { mcpServers: { local: { type: 'http', url: 'https://login:FIXTURE_SECRET@example.com/token/FIXTURE_SECRET' } } } },
    }));
    await writeFile(path.join(context.projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node', args: [] } } }));
    const calls: readonly string[][] = [];
    const result = await readClaudeSnapshot(context, { readNative: async (binary, args) => {
      expect(binary).toBe('/fixture/claude'); (calls as string[][]).push([...args]); return plugins();
    } });
    expect(calls).toEqual([['plugin', 'list', '--json']]);
    expect(result.entries.map(entry => [entry.name, entry.presence.scope])).toEqual([['user', 'user'], ['local', 'local'], ['project', 'project']]);
    expect(result.entries.every(entry => entry.presence.enabled === null && entry.presence.status === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET');
    expect(JSON.stringify(result)).not.toContain('/token/');
  });
  it('does not treat projectEnabled=false as a user/local plugin disable or merge another project', async () => {
    const result = await readClaudeSnapshot(context, { readNative: async () => ({ status: 'valid', data: [
      { id: 'user@market', scope: 'user', enabled: true, projectEnabled: false },
      { id: 'local@market', scope: 'local', projectPath: context.projectPath, enabled: true, projectEnabled: false },
      { id: 'other@market', scope: 'project', projectPath: path.join(root, 'main'), enabled: true },
    ] }) });
    expect(result.entries.map(entry => entry.name)).toEqual(['user@market', 'local@market']);
    expect(result.entries.every(entry => entry.presence.enabled === null)).toBe(true);
  });
  it('keeps confirmed independent skills while unknown local identity and failed list remain partial', async () => {
    const folder = path.join(context.projectPath, '.claude/skills/review'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), '---\ndescription: Review code\n---\nPRIVATE_BODY');
    context.claude = { nativeEvidence: { cwd: context.projectPath, policyVerified: true, loadToolAvailable: true } };
    const result = await readClaudeSnapshot(context, { readNative: async () => { throw new Error('FIXTURE_SECRET'); } });
    expect(result.phase).toBe('partial');
    expect(result.entries[0]?.presence.modelAvailable).toBe(true);
    expect(result.diagnostics).toContainEqual({ code: 'identity-unverified', source: 'mcp' });
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET|PRIVATE_BODY/);
  });
  it('bounds whole JSON input, rejects malformed UTF-8 and reports safe codes', async () => {
    const file = path.join(root, 'config.json'); await writeFile(file, '{}');
    expect(await readJsonFile(file, 2)).toEqual({ status: 'valid', data: {} });
    expect(await readJsonFile(file, 1)).toEqual({ status: 'invalid', code: 'output-limit' });
    await writeFile(file, Buffer.from([0xff])); expect(await readJsonFile(file)).toEqual({ status: 'invalid', code: 'invalid-config' });
    await writeFile(file, '{"FIXTURE_SECRET":'); expect(JSON.stringify(await readJsonFile(file))).not.toContain('FIXTURE_SECRET');
    expect(await readJsonFile(root)).toEqual({ status: 'invalid', code: 'unreadable' });
  });
  it.skipIf(process.platform === 'win32')('rejects a real FIFO without waiting for a writer', async () => {
    const fifo = path.join(root, 'config-fifo'); await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
    const read = readJsonFile(fifo);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 300); })])).toEqual({ status: 'invalid', code: 'unreadable' }); }
    finally { if (timer) clearTimeout(timer); const release = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK); await release.close(); await read; }
  });
});

it('native resource identity remains stable when display metadata is redacted', async () => {
 const native = (secret: boolean) => async () => ({ status: 'valid' as const, data: [{ id: 'tool@market', scope: 'user', enabled: false,
  ...(secret ? { env: { LABEL: 'tool@market' } } : {}),
 }] });
 const first = await readClaudeSnapshot(context, { readNative: native(false) });
 const redacted = await readClaudeSnapshot(context, { readNative: native(true) });
 expect(first.entries[0]?.presence.id).toBe(redacted.entries[0]?.presence.id);
 expect(first.entries[0]?.rowId).toBe(redacted.entries[0]?.rowId);
 expect(redacted.entries[0]?.name).toBe('[redacted]'); expect(JSON.stringify(redacted)).not.toContain('tool@market');
});

it('positive plugin policy requires matching cwd and source-specific native evidence', async () => {
 context.claude = { ...context.claude, nativeEvidence: { cwd: context.projectPath, policyVerified: true, loadToolAvailable: true,
  plugins: [{ id: 'tool@market', namespace: 'tool', installPath: path.join(root, 'plugin'), verified: true, enabled: true }],
 } };
 const native = async () => ({ status: 'valid' as const, data: [{ id: 'tool@market', scope: 'user', enabled: true }] });
 expect((await readClaudeSnapshot(context, { readNative: native })).entries.find(entry => entry.kind === 'plugin')?.presence.enabled).toBe(true);
 context.claude.nativeEvidence!.cwd = path.join(root, 'main');
 expect((await readClaudeSnapshot(context, { readNative: native })).entries.find(entry => entry.kind === 'plugin')?.presence.enabled).toBeNull();
});


import { vi } from 'vitest';
import { CLAUDE_ACTION_BUILD, fingerprint } from './native-targets.js';
import { createSafeCapabilitiesService } from './snapshot.js';
import { createCapabilitiesMcpActions } from './actions.js';
import type { McpExecutor } from './actions.js';

it('permits native-guarded Add and owned explicit-scope Remove without inventing enabled policy', async () => {
 context.env = { HOME: context.homeDir, CLAUDE_CONFIG_DIR: path.join(context.projectPath, 'config') };
 const file = path.join(context.projectPath, 'config/.claude.json');
 await writeFile(file, JSON.stringify({ mcpServers: { user: { command: 'node' } }, projects: { [context.claude!.mainCheckout!]: { mcpServers: { local: { command: 'node' } } } } }));
 await writeFile(path.join(context.projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node' } } }));
 const readBinaryIdentity = vi.fn(async () => ({ canonicalPath: '/verified/claude', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size }));
 const service = createSafeCapabilitiesService({ context: async () => context, readNative: plugins, readBinaryIdentity,
   readers: { codex: async () => ({ entries: [], diagnostics: [], phase: 'ready' }) } });
 service.get(context.projectPath); await vi.waitFor(() => expect(service.get(context.projectPath).columns.claude.phase).not.toBe('loading'));
 const snapshot = service.get(context.projectPath);
 if (process.platform !== 'darwin' || process.arch !== 'arm64') { expect(snapshot.columns.claude.mcpAdd?.user.allowed).toBe(false); service.dispose(); return; }
 expect(snapshot.columns.claude.mcpAdd?.user.allowed).toBe(true);
 const execute = vi.fn<McpExecutor>(async () => ({ code: 'ok', stdout: Buffer.from('OUTPUT_SECRET') })); const actions = createCapabilitiesMcpActions(service, execute);
 for (const scope of ['user', 'project', 'local']) {
   const presence = service.get(context.projectPath).rows.find(row => row.name === scope)!.claude[0]!;
   expect(presence.enabled).toBeNull(); expect(presence.mcpActions?.remove.allowed).toBe(true); expect(presence.mcpActions?.check.allowed).toBe(false);
   const result = await actions.remove({ projectPath: context.projectPath, provider: 'claude', presenceId: presence.id, revision: service.get(context.projectPath).revision });
   expect(result.outcome).toBe('ok'); expect(execute.mock.calls.at(-1)?.[0]).toBe('/verified/claude'); expect(execute.mock.calls.at(-1)?.[1]).toEqual(['mcp', 'remove', '--scope', scope, scope]);
   await vi.waitFor(() => expect(service.get(context.projectPath).columns.claude.phase).not.toBe('loading'));
 }
 const result = await actions.add({ projectPath: context.projectPath, provider: 'claude', name: 'new-server', revision: service.get(context.projectPath).revision, scope: 'project', input: { kind: 'stdio', command: 'node' } });
 expect(result.outcome).toBe('ok'); expect(readBinaryIdentity.mock.calls.length).toBeGreaterThanOrEqual(5); expect(JSON.stringify(result)).not.toContain('SECRET'); actions.dispose(); service.dispose();
});

it('denies actions for unmatched native bytes, malformed sources or mismatched destinations', async () => {
 context.env = { HOME: context.homeDir, CLAUDE_CONFIG_DIR: path.join(context.projectPath, 'config') };
 const approved = { canonicalPath: '/verified/claude', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size };
 for (const patch of [{ sha256: '0'.repeat(64) }, { size: 1 }]) {
   const result = await readClaudeSnapshot(context, { readNative: plugins, readBinaryIdentity: async () => ({ ...approved, ...patch }) });
   expect(result.native?.add.user.allowed).toBe(false); expect(result.native?.targets).toEqual([]);
 }
 await writeFile(path.join(context.projectPath, 'config/.claude.json'), '[]');
 const malformed = await readClaudeSnapshot(context, { readNative: plugins, readBinaryIdentity: async () => approved }); expect(malformed.native?.add.user.allowed).toBe(false);
 context.claude!.userConfigFile = '/foreign/config';
 const foreign = await readClaudeSnapshot(context, { readNative: plugins, readBinaryIdentity: async () => approved }); expect(foreign.native?.add.user.allowed).toBe(false);
});


import { symlink } from 'node:fs/promises';

it('rejects a changed canonical config target even when a replacement contains identical metadata', async () => {
 context.env = { HOME: context.homeDir, CLAUDE_CONFIG_DIR: path.join(context.projectPath, 'config') };
 const source = path.join(context.projectPath, 'config/.claude.json'); const replacement = path.join(root, 'other-config.json');
 const contents = JSON.stringify({ mcpServers: { example: { command: 'node' } } }); await writeFile(source, contents); await writeFile(replacement, contents);
 const service = createSafeCapabilitiesService({ context: async () => context, readNative: plugins,
   readBinaryIdentity: async () => ({ canonicalPath: '/verified/claude', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size }),
   readers: { codex: async () => ({ entries: [], diagnostics: [], phase: 'ready' }) } });
 service.get(context.projectPath); await vi.waitFor(() => expect(service.get(context.projectPath).columns.claude.phase).not.toBe('loading'));
 if (process.platform !== 'darwin' || process.arch !== 'arm64') { service.dispose(); return; }
 const presence = service.get(context.projectPath).rows.find(row => row.name === 'example')!.claude[0]!;
 const params = { projectPath: context.projectPath, provider: 'claude' as const, presenceId: presence.id, revision: service.get(context.projectPath).revision };
 await rm(source); await symlink(replacement, source); expect(await service.prepareMcpAction(params)).toEqual({ ok: false, code: 'context-changed' }); service.dispose();
});


it('requires exact context-bound native winning identity before Check, beyond injected policy alone', async () => {
 context.env = { HOME: context.homeDir, CLAUDE_CONFIG_DIR: path.join(context.projectPath, 'config') };
 const server = { command: 'node' };
 await writeFile(path.join(context.projectPath, 'config/.claude.json'), JSON.stringify({ mcpServers: { example: server } }));
 context.claude!.mcpPolicy = { verified: true, enabled: ['example'] };
 const options = { readNative: plugins, readBinaryIdentity: async () => ({ canonicalPath: '/verified/claude', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size }) };
 const check = async () => (await readClaudeSnapshot(context, options)).native?.targets[0]?.check.allowed;
 if (process.platform !== 'darwin' || process.arch !== 'arm64') { expect(await check()).toBeUndefined(); return; }
 expect(await check()).toBe(false);
 const target = { name: 'example', scope: 'user' as const, configFingerprint: fingerprint(server) };
 context.claude!.mcpWinningTargets = { cwd: context.projectPath, targets: [target] }; expect(await check()).toBe(true);
 context.claude!.mcpWinningTargets = { cwd: path.join(root, 'main'), targets: [target] }; expect(await check()).toBe(false);
 context.claude!.mcpWinningTargets = { cwd: context.projectPath, targets: [{ ...target, scope: 'project' }] }; expect(await check()).toBe(false);
 context.claude!.mcpWinningTargets = { cwd: context.projectPath, targets: [{ ...target, configFingerprint: fingerprint({ command: 'different' }) }] }; expect(await check()).toBe(false);
 context.claude!.mcpWinningTargets = { cwd: context.projectPath, targets: [target, target] }; expect(await check()).toBe(false);
 context.claude!.mcpWinningTargets = { cwd: context.projectPath, targets: [target] };
 await writeFile(path.join(context.projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { example: server } }));
 const ambiguous = await readClaudeSnapshot(context, options); expect(ambiguous.native?.targets.every(target => !target.check.allowed)).toBe(true);
});


it('does not allow Add against malformed or truncated human MCP name inventories', async () => {
 context.env = { HOME: context.homeDir, CLAUDE_CONFIG_DIR: path.join(context.projectPath, 'config') };
 const options = { readNative: plugins, readBinaryIdentity: async () => ({ canonicalPath: '/verified/claude', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size }) };
 const file = path.join(context.projectPath, 'config/.claude.json');
 for (const config of [{ mcpServers: [] }, { mcpServers: { example: 'invalid' } }, { mcpServers: Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`server-${index}`, { command: 'node' }])) }, { projects: [] }, { projects: { [context.claude!.mainCheckout!]: [] } }]) {
  await writeFile(file, JSON.stringify(config));
  const result = await readClaudeSnapshot(context, options); expect(result.native?.add.user.allowed).toBe(false); expect(result.phase).toBe('partial');
 }
});
