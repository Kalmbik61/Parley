import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export type SharedProjectContext =
  | { kind: 'git'; projectPath: string; mainRoot: string; checkoutRoot: string }
  | { kind: 'non-git'; projectPath: string }
  | { kind: 'unavailable'; reason: 'project-unavailable' | 'git-context-unverified' | 'main-project-unavailable' };

export interface ProjectGitResult { code: number | null; stdout: string; stderr: string }
export interface ProjectContextOptions {
  env?: NodeJS.ProcessEnv;
  /** Bounded native Git transport; injectable for deterministic failure fixtures. */
  readGit?: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ProjectGitResult>;
}

async function nativeGit(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProjectGitResult> {
  return new Promise(resolve => {
    const child = execFile('git', [...args], {
      env, encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL', windowsHide: true,
    }, (error, stdout, stderr) => {
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) });
      } catch { resolve({ code: null, stdout: '', stderr: '' }); }
    });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  });
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const GIT_DIR_PARTS = ['HEAD', 'objects', 'refs'];
/** null — no entry; 'unknown' — the entry cannot be checked. */
async function entry(file: string): Promise<Stats | null | 'unknown'> {
  try { return await lstat(file); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown'; }
}

/** Absence is proved through every ancestor; unreadable/gitfile/repository-like markers are ambiguous.
 * A `.git` folder without HEAD, objects or refs (GitKraken leaves such a stub in the home folder) is no
 * repository, nor is a lone HEAD/objects/refs entry: Git skips both, so only all three parts look bare. */
async function hasNoRepositoryMarker(cwd: string): Promise<boolean> {
  let folder = cwd;
  for (let depth = 0; depth < 128; depth++) {
    const dotGit = await entry(path.join(folder, '.git'));
    if (dotGit === 'unknown' || (dotGit && !dotGit.isDirectory())) return false;
    for (const part of dotGit ? GIT_DIR_PARTS : []) if (await entry(path.join(folder, '.git', part)) !== null) return false;
    const bare = await Promise.all(GIT_DIR_PARTS.map(part => entry(path.join(folder, part))));
    if (bare.includes('unknown') || bare.every(Boolean)) return false;
    const parent = path.dirname(folder);
    if (parent === folder) return true;
    folder = parent;
  }
  return false;
}

/** Native local-env inventory plus isolated discovery: inherited Git selectors cannot redirect a query.
 * Git documents that the main worktree is first in `worktree list --porcelain -z`.
 * https://git-scm.com/docs/git-worktree#_commands
 * https://git-scm.com/docs/git-rev-parse#Documentation/git-rev-parse.txt---local-env-vars
 */
async function resolveProjectIdentity(
  projectPath: string, options: ProjectContextOptions = {},
): Promise<SharedProjectContext> {
  const unavailable = { kind: 'unavailable', reason: 'git-context-unverified' } as const;
  try {
    const cwd = await realpath(projectPath);
    if (!(await stat(cwd)).isDirectory()) return { kind: 'unavailable', reason: 'project-unavailable' };
    const readGit = options.readGit ?? nativeGit;
    const env = { ...Object.fromEntries(Object.entries(options.env ?? process.env)
      .filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C', LANG: 'C' };
    const inventory = await readGit(['rev-parse', '--local-env-vars'], env);
    if (inventory.code !== 0 || !inventory.stdout.endsWith('\n')) return unavailable;
    const names = inventory.stdout.split('\n').filter(Boolean);
    if (names.length === 0 || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))) return unavailable;
    const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd];
    const inside = await readGit([...prefix, 'rev-parse', '--is-inside-work-tree'], env);
    if (inside.code !== 0) {
      // A failed command alone is never proof of non-Git. Require native C-locale absence and markers.
      if (inside.code === 128 && inside.stdout === '' &&
          inside.stderr === 'fatal: not a git repository (or any of the parent directories): .git\n' &&
          await hasNoRepositoryMarker(cwd)) return { kind: 'non-git', projectPath: cwd };
      return unavailable;
    }
    if (inside.stdout !== 'true\n') return unavailable; // Bare repositories are not shared projects.
    const [listing, root] = await Promise.all([
      readGit([...prefix, 'worktree', 'list', '--porcelain', '-z'], env),
      readGit([...prefix, 'rev-parse', '--show-toplevel'], env),
    ]);
    if (listing.code !== 0 || root.code !== 0 || !root.stdout.endsWith('\n') ||
        !listing.stdout.endsWith('\0\0')) return unavailable;
    const records = listing.stdout.slice(0, -2).split('\0\0');
    if (records.length === 0 || records.length > 128) return unavailable;
    const roots: string[] = [];
    for (const record of records) {
      const fields = record.split('\0');
      if (!fields[0]?.startsWith('worktree ') || fields.includes('bare')) return unavailable;
      const folder = fields[0].slice(9);
      if (!path.isAbsolute(folder)) return unavailable;
      const canonical = await realpath(folder);
      if (!(await stat(canonical)).isDirectory() || roots.includes(canonical)) return unavailable;
      roots.push(canonical);
    }
    const checkoutRoot = await realpath(root.stdout.slice(0, -1));
    const mainRoot = roots[0];
    if (!mainRoot || !roots.includes(checkoutRoot) || !contained(checkoutRoot, cwd)) return unavailable;
    return { kind: 'git', projectPath: cwd, mainRoot, checkoutRoot };
  } catch { return { kind: 'unavailable', reason: 'project-unavailable' }; }
}

/** Preserve the explicit nested folder in the corresponding main checkout. */
export async function resolveSharedProjectContext(projectPath: string, options: ProjectContextOptions = {}): Promise<SharedProjectContext> {
  const identity = await resolveProjectIdentity(projectPath, options);
  if (identity.kind !== 'git') return identity;
  const corresponding = path.join(identity.mainRoot, path.relative(identity.checkoutRoot, identity.projectPath));
  try {
    const mainProject = await realpath(corresponding);
    if (!contained(identity.mainRoot, mainProject) || mainProject !== corresponding ||
        !(await stat(mainProject)).isDirectory()) return { kind: 'unavailable', reason: 'main-project-unavailable' };
    return { ...identity, projectPath: mainProject };
  } catch { return { kind: 'unavailable', reason: 'main-project-unavailable' }; }
}

/** P17 panel identity uses the native main root, independently of the selected nested project. */
export async function resolveMainCheckout(projectPath: string, options: ProjectContextOptions = {}): Promise<string | null> {
  const context = await resolveProjectIdentity(projectPath, options);
  return context.kind === 'git' ? context.mainRoot : null;
}


/** Read-only diagnostic. Root/custom ignore rules are never changed. Unknown Git output is not proof. */
export async function sharedPathIgnored(context: Exclude<SharedProjectContext, { kind: 'unavailable' }>, file: string,
  options: ProjectContextOptions = {}): Promise<boolean> {
  if (context.kind !== 'git') return false;
  const env = { ...Object.fromEntries(Object.entries(options.env ?? process.env)
    .filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C', LANG: 'C' };
  const result = await (options.readGit ?? nativeGit)(['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', context.projectPath, 'check-ignore', '--no-index', '--', path.relative(context.projectPath, file)], env);
  return result.code === 0;
}
