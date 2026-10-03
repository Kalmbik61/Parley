import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexUserMcpProof, contextFingerprint, fingerprint } from './native-targets.js';
import type { SnapshotContext } from './snapshot.js';
import type { CodexNativeContext } from '@parley/core';
let root: string; let context: SnapshotContext; let file: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p17-proof-'))); file = path.join(root, 'home/.codex/config.toml');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '');
  context = { projectPath: root, homeDir: path.join(root, 'home'), env: { HOME: path.join(root, 'home'), KEY: 'SECRET' }, binaries: { claude: null, codex: '/fixture/codex' } };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const layer = (type: string, config: Record<string, unknown> = {}) => ({ name: { type, file }, version: 'v1', config });
const native = (layers: unknown[] = [layer('user', { mcp_servers: { example: { command: 'node' } } })]): CodexNativeContext => ({ config: { layers }, requirements: { requirements: null } });
describe('native MCP selectors', () => {
  it('proves positive User-only source with an actual native active config file', async () => {
    const proof = await codexUserMcpProof(context, native());
    expect([...proof!.names]).toEqual(['example']); expect(proof?.add).toBe(true);
    expect(proof?.signature).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(proof)).not.toContain('SECRET');
  });
  it('keeps project/system contributors unavailable even if a user table also exists', async () => {
    for (const type of ['project', 'system']) {
      const proof = await codexUserMcpProof(context, native([layer(type, { mcp_servers: { example: { command: 'different' } } }), layer('user', { mcp_servers: { example: { command: 'node' }, independent: {} } })]));
      expect([...proof!.names]).toEqual(['independent']);
    }
  });
  it('uses native disabled decisions rather than inventing a project trust decision', async () => {
    const disabled = { ...layer('project', { mcp_servers: { example: {} } }), disabledReason: 'untrusted' };
    expect((await codexUserMcpProof(context, native([disabled, layer('user', { mcp_servers: { example: {} } })])))?.names.has('example')).toBe(true);
  });
  it('refuses managed/unknown requirements, layers, profile and custom session overrides', async () => {
    const valid = native();
    for (const value of [null, { ...valid, requirements: {} }, { ...valid, requirements: { requirements: {} } },
      native([layer('enterpriseManaged')]), native([layer('future')]), native([layer('sessionFlags', { mcp_servers: {} })]),
      native([{ ...layer('user'), name: { type: 'user', file, profile: 'named' } }]),
      native([{ ...layer('user'), name: { type: 'user', file: '/wrong/config.toml' } }]),
      native([layer('user'), layer('user')])]) expect(await codexUserMcpProof(context, value)).toBeNull();
  });
  it('fingerprints exact private context and config without exposing raw values', () => {
    expect(fingerprint({ b: 2, a: 'SECRET' })).toBe(fingerprint({ a: 'SECRET', b: 2 }));
    expect(contextFingerprint(context, 'codex')).not.toBe(contextFingerprint({ ...context, env: { KEY: 'CHANGED' } }, 'codex'));
    expect(contextFingerprint(context, 'codex')).not.toContain('SECRET');
  });
});


import { createHash } from 'node:crypto';
import { chmod, symlink } from 'node:fs/promises';
import { CLAUDE_ACTION_BUILD, readBinaryIdentity, verifiedClaudeActionBinary, claudeDestinationsBound } from './native-targets.js';

it('hashes the actual executable/canonical target with bounded regular-file reads and detects byte changes', async () => {
 const executable = path.join(root, 'native-cli'); await writeFile(executable, 'fixture bytes'); await chmod(executable, 0o700);
 const alias = path.join(root, 'cli-alias'); await symlink(executable, alias);
 const identity = await readBinaryIdentity(alias, context);
 expect(identity).toEqual({ canonicalPath: executable, size: 13, sha256: createHash('sha256').update('fixture bytes').digest('hex') });
 expect(await readBinaryIdentity(alias, context, 3)).toBeNull(); expect(await readBinaryIdentity(root, context)).toBeNull();
 await writeFile(executable, 'changed bytes'); expect((await readBinaryIdentity(alias, context))?.sha256).not.toBe(identity?.sha256);
 await chmod(executable, 0o600); expect(await readBinaryIdentity(alias, context)).toBeNull();
});
it('accepts only the publisher-audited artifact, never a basename/version-shaped wrapper', async () => {
 const approved = { canonicalPath: '/verified/native', sha256: CLAUDE_ACTION_BUILD.sha256, size: CLAUDE_ACTION_BUILD.size };
 const proof = await verifiedClaudeActionBinary(context, async () => approved);
 expect(proof).toEqual(process.platform === 'darwin' && process.arch === 'arm64' ? approved : null);
 expect(await verifiedClaudeActionBinary(context, async () => ({ ...approved, sha256: '0'.repeat(64) }))).toBeNull();
 expect(await verifiedClaudeActionBinary(context, async () => ({ ...approved, size: approved.size - 1 }))).toBeNull();
});
it('binds the configured read destinations to the actual native HOME/config environment', () => {
 const value = { ...context, env: { HOME: context.homeDir }, claude: { userConfigFile: path.join(context.homeDir, '.claude.json') } };
 expect(claudeDestinationsBound(value)).toBe(true);
 expect(claudeDestinationsBound({ ...value, env: { HOME: root } })).toBe(false);
 expect(claudeDestinationsBound({ ...value, claude: { userConfigFile: '/foreign/.claude.json' } })).toBe(false);
 expect(claudeDestinationsBound({ ...value, env: { HOME: context.homeDir, CLAUDE_CONFIG_DIR: '/foreign' }, claude: { configDir: '/different' } })).toBe(false);
});


it('permits a native declared User destination before the first config file is created', async () => {
 await rm(file); const proof = await codexUserMcpProof(context, native([layer('user')])); expect(proof?.add).toBe(true);
 context.env = { HOME: context.homeDir, CODEX_HOME: '/foreign' }; expect(await codexUserMcpProof(context, native([layer('user')]))).toBeNull();
});
