import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexRoles } from './codex.js';
let root: string, cwd: string, homeDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-codex-roles-'));
  cwd = path.join(root, 'worktree');
  homeDir = path.join(root, 'home');
  await mkdir(cwd);
  await mkdir(homeDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function file(relative: string, text: string | Buffer): Promise<string> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, text);
  return full;
}
const options = () => ({
  cwd,
  homeDir,
  configLayers: [
    { hasDeclaredRoles: false, configFolder: path.join(homeDir, '.codex') },
    { hasDeclaredRoles: false, configFolder: path.join(cwd, '.codex') },
  ],
});
const role = (name: string, body: string, extra = '') =>
  `name="${name}"\ndescription="Description"\ndeveloper_instructions="${body}"\n${extra}`;
describe('Codex native roles', () => {
  it('recursively reads full TOML before any role text truncation and keeps permission channels intact', async () => {
    const source = await file(
      'home/.codex/agents/nested/filename.toml',
      'name="architect"\ndescription="Design"\ndeveloper_instructions="""\nFirst line.\nSecond line.\n"""\nmodel="custom-model"\nmodel_reasoning_effort="xhigh"\nsandbox_mode="read-only"\n',
    );
    const result = await discoverCodexRoles(options());
    expect(result.roles).toEqual([
      {
        id: 'codex:architect',
        source: 'codex',
        name: 'architect',
        description: 'Design',
        provider: 'codex',
        readOnly: true,
        path: await realpath(source),
        prompt: 'First line.\nSecond line.\n',
        model: 'custom-model',
        effort: 'xhigh',
        sandboxMode: 'read-only',
      },
    ]);
    const large = 'A'.repeat(40000);
    await file('worktree/.codex/agents/long.toml', role('long', large, 'sandbox_mode="read-only"'));
    const full = (await discoverCodexRoles(options())).roles.find(
      (item) => item.id === 'codex:long',
    );
    expect(full?.source === 'codex' && full.prompt).toBe(large);
    expect(full?.readOnly).toBe(true);
  });
  it('inherits missing description across layers but not model, effort or sandbox from an older file', async () => {
    await file(
      'home/.codex/agents/review.toml',
      role(
        'reviewer',
        'Old',
        'model="old-model"\nmodel_reasoning_effort="high"\nsandbox_mode="read-only"',
      ),
    );
    const newer = await file(
      'worktree/.codex/agents/review.toml',
      'name="reviewer"\ndeveloper_instructions="New"',
    );
    const result = await discoverCodexRoles(options());
    expect(result.roles).toEqual([
      {
        id: 'codex:reviewer',
        source: 'codex',
        name: 'reviewer',
        description: 'Description',
        provider: 'codex',
        readOnly: false,
        path: await realpath(newer),
        prompt: 'New',
        model: null,
        effort: null,
        sandboxMode: null,
      },
    ]);
  });
  it('keeps the earlier accepted role when the later definition is malformed', async () => {
    await file('home/.codex/agents/good.toml', role('worker', 'Good'));
    await file(
      'worktree/.codex/agents/bad.toml',
      'name="worker"\ndescription="Bad"\ndeveloper_instructions=""',
    );
    const result = await discoverCodexRoles(options());
    expect(result.roles[0]?.source === 'codex' && result.roles[0].prompt).toBe('Good');
    expect(result.partial).toBe(true);
  });
  it('uses native same-layer lexical first winner, reporting the duplicate', async () => {
    await file('home/.codex/agents/z.toml', role('worker', 'Last'));
    await file('home/.codex/agents/a.toml', role('worker', 'First'));
    const result = await discoverCodexRoles(options());
    expect(result.roles[0]?.source === 'codex' && result.roles[0].prompt).toBe('First');
    expect(result.diagnostics.some((item) => item.code === 'duplicate-role')).toBe(true);
  });
  it('requires auto-discovered name, nonempty instructions and description after merge; never filename fallback', async () => {
    await file(
      'home/.codex/agents/filename.toml',
      'description="Only name missing"\ndeveloper_instructions="Text"',
    );
    await file(
      'home/.codex/agents/no-description.toml',
      'name="missing"\ndeveloper_instructions="Text"',
    );
    await file('home/.codex/agents/invalid-name.toml', role('../escape', 'Text'));
    await file('home/.codex/agents/empty.toml', role('empty', ' '));
    const result = await discoverCodexRoles(options());
    expect(result.roles).toEqual([]);
    expect(result.partial).toBe(true);
  });
  it('rejects malformed policy and unsupported config without weakening permissions or leaking parser text', async () => {
    await file('home/.codex/agents/bad.toml', role('bad', 'SECRET_BODY', 'sandbox_mode=false'));
    await file(
      'home/.codex/agents/unknown.toml',
      role('unknown', 'SECRET_BODY', 'approval_policy="never"'),
    );
    await file('home/.codex/agents/syntax.toml', 'name = "SECRET_UNFINISHED');
    await file('home/.codex/agents/utf8.toml', Buffer.from([0xff]));
    const result = await discoverCodexRoles(options());
    expect(result.roles).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'invalid-policy',
        'unsupported-config',
        'invalid-toml',
        'invalid-utf8',
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/SECRET/);
  });
  it('uses only injected native layers, skipping disabled layers and unrelated checkout sources', async () => {
    await file('home/.codex/agents/user.toml', role('user', 'User'));
    await file('worktree/.codex/agents/local.toml', role('local', 'Local'));
    await file('native/agents/native.toml', role('native', 'Native'));
    const result = await discoverCodexRoles({
      ...options(),
      configLayers: [
        { hasDeclaredRoles: false, configFolder: path.join(root, 'native') },
        { hasDeclaredRoles: false, configFolder: path.join(cwd, '.codex'), disabled: true },
      ],
    });
    expect(result.roles.map((item) => item.id)).toEqual(['codex:native']);
  });
  it('does not treat roots alone as proof that declared config_file roles cannot affect the native merge', async () => {
    await file('home/.codex/agents/good.toml', role('good', 'Good'));
    const result = await discoverCodexRoles({
      ...options(),
      configLayers: [{ configFolder: path.join(homeDir, '.codex') }],
    });
    expect(result.roles.map((item) => item.id)).toEqual(['codex:good']);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'context-unverified')).toBe(true);
  });

  it('marks default user/direct-project inventory incomplete until the caller supplies active native layers', async () => {
    await file('worktree/.codex/agents/local.toml', role('local', 'Local'));
    const result = await discoverCodexRoles({ cwd, homeDir });
    expect(result.roles.map((item) => item.id)).toEqual(['codex:local']);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContainEqual({
      source: 'codex',
      code: 'context-unverified',
      path: cwd,
    });
  });

  it('rejects cyclic traversal, retains good files and bounds raw input independently of body size', async () => {
    await file('home/.codex/agents/good.toml', role('good', 'Good'));
    await file('home/.codex/agents/oversized.toml', role('oversized', 'X'.repeat(1048576)));
    await symlink(path.join(homeDir, '.codex/agents'), path.join(homeDir, '.codex/agents/cycle'));
    const result = await discoverCodexRoles(options());
    expect(result.roles.map((item) => item.id)).toEqual(['codex:good']);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['symlink-cycle', 'file-too-large']),
    );
  });
});
