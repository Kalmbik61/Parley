import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readMarkdownFrontmatter } from '../skills/frontmatter.js';
import type { ClaudeRole, RoleCatalog, RoleDiagnostic, RoleDiscoveryLimits } from './types.js';

/** Native role/config input bound, separate from the post-parse 32 KiB role-text ceiling. */
export const ROLE_DOCUMENT_MAX_BYTES = 1048576;
export const compareRoleText = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
// Claude's Vjn validates the metadata string without trimming or filename fallback.
const validClaudeRoleName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name !== '' &&
  !name.startsWith('-') &&
  !name.normalize('NFKC').includes(':');
export interface ClaudeRoleOptions {
  cwd: string;
  homeDir: string;
  configDir?: string;
  limits?: RoleDiscoveryLimits;
}
interface RoleFile {
  file: string;
  canonical: string;
}

/** Shared bounded filesystem traversal only; provider schemas and merge rules stay separate. */
export function roleTraversal(
  source: 'claude' | 'codex',
  result: RoleCatalog,
  limits: RoleDiscoveryLimits = {},
) {
  const defaults = { maxDepth: 32, maxDirectories: 2000, maxEntries: 20000, maxRoots: 128 };
  const bounds = { ...defaults };
  const report = (diagnostic: Omit<RoleDiagnostic, 'source'>): void => {
    result.partial = true;
    result.diagnostics.push({ source, ...diagnostic });
  };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const requested = limits[key];
    if (requested === undefined) continue;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > defaults[key]) {
      bounds[key] = 0;
      report({ code: 'discovery-limit' });
    } else bounds[key] = requested;
  }
  let entries = 0,
    directories = 0,
    roots = 0;
  async function walk(
    directory: string,
    extension: string,
    recursive: boolean,
    depth: number,
    ancestors: ReadonlySet<string>,
    out: RoleFile[],
  ): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        try {
          await lstat(directory);
        } catch (missing) {
          if (
            typeof missing === 'object' &&
            missing !== null &&
            'code' in missing &&
            missing.code === 'ENOENT'
          )
            return;
        }
      }
      report({ code: 'unreadable', path: directory });
      return;
    }
    if (ancestors.has(canonical)) {
      report({ code: 'symlink-cycle', path: canonical });
      return;
    }
    if (directories >= bounds.maxDirectories) {
      report({ code: 'discovery-limit', path: canonical, count: directories });
      return;
    }
    directories += 1;
    const next = new Set([...ancestors, canonical]);
    try {
      const handle = await opendir(canonical);
      for await (const entry of handle) {
        if (entries >= bounds.maxEntries) {
          report({ code: 'discovery-limit', path: canonical, count: entries });
          break;
        }
        entries += 1;
        const file = path.join(directory, entry.name);
        let directoryEntry = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            directoryEntry = (await stat(file)).isDirectory();
          } catch {
            report({ code: 'unreadable', path: file });
            continue;
          }
        }
        if (directoryEntry) {
          if (recursive) {
            if (depth >= bounds.maxDepth)
              report({ code: 'discovery-limit', path: file, count: depth + 1 });
            else await walk(file, extension, recursive, depth + 1, next, out);
          }
        } else if (entry.name.endsWith(extension) && (entry.isFile() || entry.isSymbolicLink())) {
          try {
            out.push({ file, canonical: await realpath(file) });
          } catch {
            report({ code: 'unreadable', path: file });
          }
        }
      }
    } catch {
      report({ code: 'unreadable', path: canonical });
    }
  }
  return {
    report,
    async context(cwd: string, homeDir: string): Promise<boolean> {
      try {
        if (!path.isAbsolute(cwd) || !path.isAbsolute(homeDir) || !(await stat(cwd)).isDirectory())
          throw new Error();
        return true;
      } catch {
        report({ code: 'missing-context', path: cwd });
        return false;
      }
    },
    async files(directory: string, extension: string, recursive: boolean): Promise<RoleFile[]> {
      if (roots >= bounds.maxRoots) {
        report({ code: 'discovery-limit', path: directory, count: roots });
        return [];
      }
      roots += 1;
      const out: RoleFile[] = [];
      await walk(directory, extension, recursive, 0, new Set(), out);
      return out.sort((a, b) => compareRoleText(a.file, b.file));
    },
  };
}

/** Metadata-only: Claude applies all prompt/model/tools fields through --agent itself. */
export async function discoverClaudeRoles(options: ClaudeRoleOptions): Promise<RoleCatalog> {
  const result: RoleCatalog = { roles: [], diagnostics: [], partial: false };
  const traversal = roleTraversal('claude', result, options.limits);
  if (!(await traversal.context(options.cwd, options.homeDir))) return result;
  const configDir = path.resolve(
    options.cwd,
    options.configDir ?? path.join(options.homeDir, '.claude'),
  );
  const roles = new Map<string, ClaudeRole>();
  const claimed = new Set<string>();
  for (const root of [path.join(options.cwd, '.claude/agents'), path.join(configDir, 'agents')]) {
    const inRoot = new Map<string, ClaudeRole | null>();
    for (const { canonical } of await traversal.files(root, '.md', true)) {
      const parsed = await readMarkdownFrontmatter(canonical, ROLE_DOCUMENT_MAX_BYTES);
      if (parsed.status === 'invalid') {
        traversal.report({ ...parsed.diagnostic, path: canonical });
        continue;
      }
      if (parsed.status === 'missing') continue;
      const name = parsed.data.name;
      if (!validClaudeRoleName(name)) {
        // No name is native documentation beside agents; invalid supplied names are diagnostics.
        if (name !== undefined) traversal.report({ code: 'invalid-name', path: canonical });
        continue;
      }
      if (typeof parsed.data.description !== 'string' || parsed.data.description === '') {
        traversal.report({ code: 'invalid-policy', path: canonical });
        continue;
      }
      if (inRoot.has(name)) {
        // Native read-order within a source tree is unspecified: never invent a lexical winner.
        inRoot.set(name, null);
        traversal.report({ code: 'duplicate-role', path: canonical });
        continue;
      }
      inRoot.set(name, {
        id: `claude:${name}`,
        source: 'claude',
        name,
        description: parsed.data.description.replaceAll('\\n', '\n'),
        provider: 'claude',
        readOnly: false,
        path: canonical,
        nativeAgent: name,
      });
    }
    for (const [name, role] of inRoot) {
      // Ambiguous project identities also shadow user fallback; permissions are not guessed.
      if (claimed.has(name)) continue;
      claimed.add(name);
      if (role) roles.set(name, role);
    }
  }
  result.roles = [...roles.values()].sort((a, b) => compareRoleText(a.id, b.id));
  return result;
}
