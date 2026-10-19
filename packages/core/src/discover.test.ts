import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assistantCwd,
  claudeProjectRoots,
  claudeProjectSlug,
  claudeRootFor,
  customProviderProjectRoots,
  defaultRoot,
  discoverSessions,
  sessionFileForPath,
} from './discover.js';

let root: string;
let home: string;
const savedHome = process.env.PARLEY_HOME;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-discover-'));
  home = path.join(root, 'parley-home');
  process.env.PARLEY_HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('папка помощника (спека 2026-10-14, 15.6)', () => {
  it('claudeProjectSlug — слаг Claude Code: не буква и не цифра → дефис', () => {
    expect(claudeProjectSlug('/Users/a/.parley/assistant')).toBe('-Users-a--parley-assistant');
    expect(claudeProjectSlug('/Users/a/Desktop/MY/my_harnas')).toBe('-Users-a-Desktop-MY-my-harnas');
  });

  it('discoverSessions не видит транскрипты помощника, остальные проекты — видит', async () => {
    const projects = path.join(root, 'projects');
    const assistant = path.join(projects, claudeProjectSlug(assistantCwd(home)));
    const other = path.join(projects, '-Users-a-proj');
    await mkdir(assistant, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(path.join(assistant, 'aaa.jsonl'), '');
    await writeFile(path.join(other, 'bbb.jsonl'), '');
    const found = await discoverSessions(projects);
    expect(found.map((session) => session.id)).toEqual(['bbb']);
  });

  it('sessionFileForPath для файла помощника — null', () => {
    const projects = '/root';
    const slug = claudeProjectSlug(assistantCwd(home));
    expect(sessionFileForPath(path.join(projects, slug, 'aaa.jsonl'), projects)).toBeNull();
    expect(sessionFileForPath(path.join(projects, '-Users-a-proj', 'bbb.jsonl'), projects)).toBe(path.join(projects, '-Users-a-proj', 'bbb.jsonl'));
  });
});

describe('история своих провайдеров (спека своих провайдеров 5.6)', () => {
  const userHome = '/u/me';

  it('customProviderProjectRoots: подпапки providers с префиксом → их projects; нет каталога → []', async () => {
    expect(customProviderProjectRoots(home)).toEqual([]);
    await mkdir(path.join(home, 'providers', 'custom-kimi'), { recursive: true });
    await mkdir(path.join(home, 'providers', 'custom-zed'), { recursive: true });
    await mkdir(path.join(home, 'providers', 'other'), { recursive: true });
    await mkdir(path.join(home, 'providers', 'custom-Bad Name'), { recursive: true });
    await writeFile(path.join(home, 'providers', 'custom-file'), '');
    expect(customProviderProjectRoots(home)).toEqual([
      path.join(home, 'providers', 'custom-kimi', 'projects'),
      path.join(home, 'providers', 'custom-zed', 'projects'),
    ]);
  });

  it('claudeProjectRoots: ~/.claude/projects и корни custom-* в доме Parley; подмена — только она', async () => {
    await mkdir(path.join(home, 'providers', 'custom-kimi'), { recursive: true });
    const env = { PARLEY_HOME: home } as NodeJS.ProcessEnv;
    expect(claudeProjectRoots(env, userHome)).toEqual([
      path.join(userHome, '.claude', 'projects'),
      path.join(home, 'providers', 'custom-kimi', 'projects'),
    ]);
    expect(claudeProjectRoots({ ...env, PARLEY_CLAUDE_PROJECTS_DIR: '/stub' }, userHome)).toEqual(['/stub']);
  });

  it('claudeRootFor: custom-kimi → <home>/providers/custom-kimi/projects; claude → defaultRoot()', () => {
    expect(claudeRootFor('custom-kimi')).toBe(path.join(home, 'providers', 'custom-kimi', 'projects'));
    expect(claudeRootFor('claude')).toBe(defaultRoot());
    expect(claudeRootFor('glm')).toBe(defaultRoot());
  });
});
