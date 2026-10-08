import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverClaudeRoles } from './claude.js';
let root: string, cwd: string, homeDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-roles-'));
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
const options = () => ({ cwd, homeDir });
describe('Claude native roles', () => {
  it('returns only source identity and description; Claude owns body, model and tools', async () => {
    const source = await file(
      'worktree/.claude/agents/audit.md',
      '---\nname: decorative\ndescription: |\n  Inspect behavior.\n  Cite evidence.\nmodel: SECRET_MODEL\ntools: [SECRET_TOOL]\n---\nSECRET_PROMPT',
    );
    const result = await discoverClaudeRoles(options());
    expect(result.roles).toEqual([
      {
        id: 'claude:decorative',
        source: 'claude',
        name: 'decorative',
        description: 'Inspect behavior.\nCite evidence.\n',
        provider: 'claude',
        readOnly: false,
        nativeAgent: 'decorative',
        path: await realpath(source),
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });
  it('uses project before user and keeps source-qualified identities', async () => {
    await file('home/.claude/agents/user-file.md', '---\nname: reviewer\ndescription: User\n---\n');
    await file(
      'worktree/.claude/agents/project-file.md',
      '---\nname: reviewer\ndescription: Project\n---\n',
    );
    const result = await discoverClaudeRoles(options());
    expect(result.roles.map((role) => role.description)).toEqual(['Project']);
    expect(result.roles[0]?.id).toBe('claude:reviewer');
  });
  it.each(
    [
      undefined,
      null,
      false,
      42,
      ['reviewer'],
      '',
      '-leading',
      'plugin:reviewer',
      'review：name',
    ].map((name) => ({ name })),
  )(
    'skips missing or invalid native metadata name $name without filename fallback',
    async ({ name }) => {
      const metadata = name === undefined ? '' : `name: ${JSON.stringify(name)}\n`;
      await file(
        'worktree/.claude/agents/filename.md',
        `---\n${metadata}description: Valid description\n---\nSECRET_BODY`,
      );
      const result = await discoverClaudeRoles(options());
      expect(result.roles).toEqual([]);
      expect(JSON.stringify(result.diagnostics)).not.toMatch(/SECRET/);
    },
  );

  it('does not choose a guessed same-root native winner or fall back through ambiguous project identity', async () => {
    await file(
      'worktree/.claude/agents/a.md',
      '---\nname: duplicate\ndescription: First\n---\nSECRET_PROMPT_A',
    );
    await file(
      'worktree/.claude/agents/nested/z.md',
      '---\nname: duplicate\ndescription: Second\n---\nSECRET_PROMPT_Z',
    );
    await file(
      'home/.claude/agents/fallback.md',
      '---\nname: duplicate\ndescription: User fallback\n---\n',
    );
    await file(
      'worktree/.claude/agents/good.md',
      '---\nname: independent\ndescription: Good\n---\n',
    );
    const result = await discoverClaudeRoles(options());
    expect(result.roles.map((role) => role.id)).toEqual(['claude:independent']);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'duplicate-role')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it('uses the injected config home and does not follow another checkout', async () => {
    await file('home/.claude/agents/wrong.md', '---\nname: wrong\ndescription: Wrong\n---\n');
    await file('override/agents/right.md', '---\nname: right\ndescription: Right\n---\n');
    await file('main/.claude/agents/main.md', '---\nname: wrong\ndescription: Wrong\n---\n');
    const result = await discoverClaudeRoles({
      ...options(),
      configDir: path.join(root, 'override'),
    });
    expect(result.roles.map((role) => role.id)).toEqual(['claude:right']);
  });
  it('rejects invalid metadata and UTF-8 without leaking source or treating folders as roles', async () => {
    await file('worktree/.claude/agents/no-header.md', 'SECRET_PROMPT');
    await file('worktree/.claude/agents/broken.md', '---\ndescription: [SECRET_BAD\n---\n');
    await file('worktree/.claude/agents/array.md', '---\nname: array\ndescription: [a,b]\n---\n');
    await file('worktree/.claude/agents/utf8.md', Buffer.from([0xff]));
    await mkdir(path.join(cwd, '.claude/agents/directory.md'));
    const result = await discoverClaudeRoles(options());
    expect(result.roles).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['invalid-policy', 'invalid-yaml', 'invalid-utf8']),
    );
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/SECRET/);
  });
  it('reports broken links and traversal limits while retaining independent valid roles', async () => {
    await file('worktree/.claude/agents/good.md', '---\nname: good\ndescription: Good\n---\n');
    await symlink(path.join(root, 'absent'), path.join(cwd, '.claude/agents/broken.md'));
    const result = await discoverClaudeRoles(options());
    expect(result.roles.map((role) => role.id)).toEqual(['claude:good']);
    expect(result.partial).toBe(true);
    const limited = await discoverClaudeRoles({ ...options(), limits: { maxEntries: 0 } });
    expect(limited.roles).toEqual([]);
    expect(limited.diagnostics.some((item) => item.code === 'discovery-limit')).toBe(true);
  });
  it('distinguishes known empty roots from an unreadable root and a missing cwd', async () => {
    expect(await discoverClaudeRoles(options())).toEqual({
      roles: [],
      diagnostics: [],
      partial: false,
    });
    await file('worktree/.claude/agents', 'Not a directory');
    expect((await discoverClaudeRoles(options())).diagnostics[0]?.code).toBe('unreadable');
    await rm(cwd, { recursive: true });
    expect((await discoverClaudeRoles(options())).diagnostics[0]?.code).toBe('missing-context');
  });
});
