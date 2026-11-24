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
import { chmod, symlink, utimes } from 'node:fs/promises';
import { CLAUDE_ACTION_BUILD, binaryHashCount, readBinaryIdentity, verifiedClaudeActionBinary, claudeDestinationsBound } from './native-targets.js';

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

describe('кэш хэша бинаря', () => {
 const makeBinary = async (name: string, bytes: string): Promise<string> => {
  const executable = path.join(root, name); await writeFile(executable, bytes); await chmod(executable, 0o700); return executable;
 };
 it('четыре вызова readBinaryIdentity для одного файла хэшируют один раз', async () => {
  const executable = await makeBinary('cached-cli', 'cache me'); const before = binaryHashCount();
  const results = [];
  for (let index = 0; index < 4; index++) results.push(await readBinaryIdentity(executable, context));
  expect(binaryHashCount() - before).toBe(1);
  expect(new Set(results.map(result => result?.sha256)).size).toBe(1);
  expect(results[0]?.sha256).toBe(createHash('sha256').update('cache me').digest('hex'));
 });
 it('параллельные вызовы делят один проход', async () => {
  const executable = await makeBinary('parallel-cli', 'shared pass'); const before = binaryHashCount();
  const results = await Promise.all(Array.from({ length: 4 }, () => readBinaryIdentity(executable, context)));
  expect(binaryHashCount() - before).toBe(1);
  expect(results.every(result => result?.sha256 === results[0]?.sha256 && result !== null)).toBe(true);
 });
 it('тот же путь, другое содержимое того же размера: новый хэш, а не старый', async () => {
  const executable = await makeBinary('swapped-cli', 'AAAA'); const first = await readBinaryIdentity(executable, context);
  await writeFile(executable, 'BBBB'); await utimes(executable, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const second = await readBinaryIdentity(executable, context);
  expect(first?.sha256).toBe(createHash('sha256').update('AAAA').digest('hex'));
  expect(second?.sha256).toBe(createHash('sha256').update('BBBB').digest('hex'));
 });
 it('изменение размера даёт новый хэш', async () => {
  const executable = await makeBinary('grown-cli', 'short'); await readBinaryIdentity(executable, context); const before = binaryHashCount();
  await writeFile(executable, 'a much longer body');
  expect((await readBinaryIdentity(executable, context))?.sha256).toBe(createHash('sha256').update('a much longer body').digest('hex'));
  expect(binaryHashCount() - before).toBe(1);
 });
 it('возврат старого mtime после правки не возвращает старый хэш (ctime меняется)', async () => {
  const executable = await makeBinary('rewound-cli', 'CCCC'); const old = new Date(Date.now() - 60_000); await utimes(executable, old, old);
  const first = await readBinaryIdentity(executable, context);
  await new Promise(resolve => setTimeout(resolve, 20)); await writeFile(executable, 'DDDD'); await utimes(executable, old, old);
  const second = await readBinaryIdentity(executable, context);
  expect(second?.sha256).not.toBe(first?.sha256);
 });
 it('отказ не кэшируется: после починки бинаря хэш считается', async () => {
  const executable = await makeBinary('late-cli', 'ok'); await chmod(executable, 0o600);
  expect(await readBinaryIdentity(executable, context)).toBeNull();
  await chmod(executable, 0o700);
  expect((await readBinaryIdentity(executable, context))?.sha256).toBe(createHash('sha256').update('ok').digest('hex'));
 });
 it('держит не более 8 файлов: девятый вытесняет первый', async () => {
  const files = []; for (let index = 0; index < 9; index++) files.push(await makeBinary(`lru-${index}`, `body ${index}`));
  for (const executable of files) await readBinaryIdentity(executable, context);
  const before = binaryHashCount();
  await readBinaryIdentity(files[8]!, context); expect(binaryHashCount() - before).toBe(0);
  await readBinaryIdentity(files[0]!, context); expect(binaryHashCount() - before).toBe(1);
 });
});
