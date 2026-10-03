import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { commandBinary, loadProviders, stateDir } from '@parley/core';
import type { SkillCatalogOptions } from '@parley/core';
import { capabilityPresence, capabilitySnapshot } from '@parley/protocol';
import type { CapabilityColumn, CapabilityDiagnostic, CapabilityPresence, CapabilityProvider, CapabilityRow, CapabilitySnapshot } from '@parley/protocol';
import { readClaudeSnapshot } from './claude.js';
import { readCodexSnapshot } from './codex.js';
import { rowIdentity, object, readJsonFile, readNativeJson, safeText } from './redact.js';
import type { NativeJsonReader, SnapshotEntry } from './redact.js';

type ClaudeOptions = Omit<Extract<SkillCatalogOptions, { provider: 'claude' }>, 'provider' | 'cwd' | 'homeDir'>;
type CodexOptions = Omit<Extract<SkillCatalogOptions, { provider: 'codex' }>, 'provider' | 'cwd' | 'homeDir'>;
export interface SnapshotContext {
  /** Actual main checkout for the project panel, not a participant worktree. */
  projectPath: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  binaries: Record<CapabilityProvider, string | null>;
  claude?: ClaudeOptions & {
    userConfigFile?: string;
    /** Source-backed native/Git identity; unresolved leaves local MCP unknown. */
    mainCheckout?: string;
    mcpPolicy?: { verified: boolean; enabled?: readonly string[]; disabled?: readonly string[]; approved?: readonly string[] };
  };
  codex?: CodexOptions;
}
export interface ProviderSnapshotResult { entries: SnapshotEntry[]; diagnostics: CapabilityDiagnostic[]; phase: CapabilityColumn['phase'] }
export interface SnapshotReaderOptions { readNative?: NativeJsonReader }
export type ProviderSnapshotReader = (context: SnapshotContext, options: SnapshotReaderOptions) => Promise<ProviderSnapshotResult>;

/** Bounded native Git output only; no repository/config output or raw errors are logged. */
async function readGit(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile('git', [...args],
      { env, encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) => {
        if (error !== null) { resolve(null); return; }
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch { resolve(null); }
      });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  });
}

/** Native --local-env-vars identifies repository-specific variables to remove for foreign queries.
 * Git documents that its main worktree is listed first; queried root must also belong to that list.
 * https://git-scm.com/docs/git-rev-parse#Documentation/git-rev-parse.txt---local-env-vars
 * https://git-scm.com/docs/git-worktree#_commands
 */
export async function findMainCheckout(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const canonicalCwd = await realpath(cwd);
    if (!(await stat(canonicalCwd)).isDirectory()) return null;
    // Only the inventory query removes all Git variables: it reads native variable names, no repository.
    const inventoryEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
    const inventory = await readGit(['rev-parse', '--local-env-vars'], inventoryEnv);
    if (inventory === null) return null;
    const names = inventory.split('\n').filter(Boolean);
    if (names.length === 0 || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))) return null;
    const cleanEnv = { ...env };
    for (const name of names) delete cleanEnv[name];
    for (const name of Object.keys(cleanEnv)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete cleanEnv[name];
    const prefix = ['-c', 'core.fsmonitor=false', '-C', canonicalCwd];
    const [listing, root] = await Promise.all([
      readGit([...prefix, 'worktree', 'list', '--porcelain', '-z'], cleanEnv),
      readGit([...prefix, 'rev-parse', '--show-toplevel'], cleanEnv),
    ]);
    if (listing === null || root === null || !root.endsWith('\n')) return null;
    const fields = listing.split('\0');
    const first = fields[0]; const end = fields.indexOf('');
    if (!first?.startsWith('worktree ') || fields.slice(0, end).includes('bare')) return null;
    const worktrees = fields.filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
    if (worktrees.length > 128 || worktrees.some(folder => !path.isAbsolute(folder))) return null;
    const queriedRoot = root.slice(0, -1);
    if (!path.isAbsolute(queriedRoot)) return null;
    const canonicalRoot = await realpath(queriedRoot);
    const relative = path.relative(canonicalRoot, canonicalCwd);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
    const members = await Promise.all(worktrees.map(folder => realpath(folder).catch(() => null)));
    if (!members.includes(canonicalRoot)) return null;
    const main = members[0];
    return main && (await stat(main)).isDirectory() ? main : null;
  } catch { return null; }
}

export async function defaultSnapshotContext(projectPath: string): Promise<SnapshotContext> {
  const cwd = await realpath(projectPath);
  if (!(await stat(cwd)).isDirectory()) throw new Error('missing-context');
  const env = { ...process.env };
  const main = await findMainCheckout(cwd, env);
  const panel = main ?? cwd;
  const homeDir = homedir();
  const registry = await loadProviders();
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(panel, env.CLAUDE_CONFIG_DIR) : undefined;
  return {
    projectPath: panel, homeDir, env,
    binaries: { claude: registry.claude ? commandBinary(registry.claude.runner.command, env) : null,
      codex: registry.codex ? commandBinary(registry.codex.runner.command, env) : null },
    claude: { ...(configDir ? { configDir, userConfigFile: path.join(configDir, '.claude.json') } : {}),
      ...(main ? { mainCheckout: main } : {}) },
    codex: env.CODEX_HOME ? { codexHome: path.resolve(panel, env.CODEX_HOME) } : {},
  };
}

const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function mergeSnapshotRows(columns: Partial<Record<CapabilityProvider, SnapshotEntry[]>>): CapabilityRow[] {
  const rows = new Map<string, CapabilityRow>();
  for (const provider of ['claude', 'codex'] as const) for (const entry of columns[provider] ?? []) {
    const id = entry.rowId && /^[a-f0-9]{64}$/.test(entry.rowId) ? entry.rowId : rowIdentity(entry.kind, entry.name, provider);
    let row = rows.get(id);
    if (!row) { row = { id, kind: entry.kind, name: entry.name, description: entry.presence.description,
      separateCopies: false, claude: [], codex: [] }; rows.set(id, row); }
    if (!row[provider].some(item => item.id === entry.presence.id)) row[provider].push(entry.presence);
  }
  for (const row of rows.values()) {
    row.claude.sort((a, b) => compare(a.id, b.id)); row.codex.sort((a, b) => compare(a.id, b.id));
    const documents = [...row.claude, ...row.codex].map(item => item.documentPath).filter((item): item is string => item !== null);
    row.separateCopies = row.kind === 'skill' && new Set(documents).size > 1;
  }
  return [...rows.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name) || compare(a.id, b.id));
}

/** Receipt metadata only proves ownership when its current file/actual link still matches. */
async function builtinSkills(context: SnapshotContext, entries: SnapshotEntry[]): Promise<CapabilityDiagnostic[]> {
  const read = await readJsonFile(path.join(stateDir(context.projectPath), 'skills-receipt.json'), 1024 * 1024);
  if (read.status === 'missing') return [];
  const data = read.status === 'valid' ? object(read.data) : null;
  const receipt = data?.version === 1 ? object(data.entries) : null;
  if (!receipt) return [{ code: 'receipt-unverified', source: 'receipt' }];
  const owned = new Set<string>();
  const observed = new Set(entries.filter(entry => entry.kind === 'skill').map(entry => entry.presence.documentPath));
  for (const [folder, raw] of Object.entries(receipt).slice(0, 1000)) {
    const entry = object(raw);
    if (!entry || !path.isAbsolute(folder)) continue;
    try {
      const info = await lstat(folder);
      if ((entry.kind !== 'dir' && entry.kind !== 'copy') || !info.isDirectory() || typeof entry.sha256 !== 'string') continue;
      const file = path.join(folder, 'SKILL.md');
      if (!observed.has(await realpath(file))) continue;
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > 65_536) continue;
        const content = Buffer.alloc(65_537); let length = 0;
        while (length < content.length) {
          const { bytesRead } = await handle.read(content, length, content.length - length, null);
          if (bytesRead === 0) break; length += bytesRead;
        }
        if (length > 65_536 || createHash('sha256').update(content.subarray(0, length)).digest('hex') !== entry.sha256) continue;
        owned.add(await realpath(file));
      } finally { await handle.close(); }
    } catch { /* Edited/broken receipt entries are never claimed by name. */ }
  }
  for (const entry of entries) if (entry.kind === 'skill' && entry.name === 'parley' &&
    entry.presence.documentPath !== null && owned.has(entry.presence.documentPath)) entry.presence.scope = 'builtin';
  return [];
}

async function markSharedLinks(context: SnapshotContext, columns: Partial<Record<CapabilityProvider, SnapshotEntry[]>>): Promise<void> {
  for (const provider of ['claude', 'codex'] as const) {
    const other = provider === 'claude' ? 'codex' : 'claude';
    const targets = new Set((columns[other] ?? []).filter(entry => entry.kind === 'skill').map(entry => entry.presence.documentPath));
    for (const entry of columns[provider] ?? []) {
      const presence = entry.presence;
      if (entry.kind !== 'skill' || !targets.has(presence.documentPath) || !['user', 'project', 'builtin'].includes(presence.scope ?? '')) continue;
      if (!/^[^/\\:]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
      const projectRoot = path.join(context.projectPath, provider === 'claude' ? '.claude/skills' : '.agents/skills');
      const userRoot = provider === 'claude'
        ? path.join(path.resolve(context.projectPath, context.claude?.configDir ?? path.join(context.homeDir, '.claude')), 'skills')
        : path.join(context.homeDir, '.agents/skills');
      const roots = presence.scope === 'project' ? [projectRoot] : presence.scope === 'user' ? [userRoot] : [projectRoot, userRoot];
      for (const root of roots) try {
        const folder = path.join(root, entry.name);
        if (!(await lstat(folder)).isSymbolicLink()) continue;
        const target = await readlink(folder);
        if (target === '' || await realpath(path.join(folder, 'SKILL.md')) !== presence.documentPath) continue;
        presence.sharedFrom = other; break;
      } catch { /* Canonical equality alone never implies a symlink or its direction. */ }
    }
  }
}

export interface SafeCapabilitiesService {
  get(projectPath: string): CapabilitySnapshot;
  refresh(projectPath: string): CapabilitySnapshot;
  dispose(): void;
}
export interface SafeCapabilitiesOptions extends SnapshotReaderOptions {
  context?: (projectPath: string) => Promise<SnapshotContext>;
  readers?: Partial<Record<CapabilityProvider, ProviderSnapshotReader>>;
  changed?: (projectPath: string, snapshot: CapabilitySnapshot) => void;
}

export function createSafeCapabilitiesService(options: SafeCapabilitiesOptions = {}): SafeCapabilitiesService {
  interface Cached { generation: number; snapshot: CapabilitySnapshot; entries: Partial<Record<CapabilityProvider, SnapshotEntry[]>> }
  const cache = new Map<string, Cached>();
  let disposed = false;
  const copy = (value: CapabilitySnapshot): CapabilitySnapshot => structuredClone(value);
  const active = (key: string, generation: number): Cached | undefined => {
    const value = cache.get(key); return !disposed && value?.generation === generation ? value : undefined;
  };
  const emit = (key: string, value: Cached): void => { options.changed?.(key, copy(value.snapshot)); };
  const refresh = (projectPath: string): CapabilitySnapshot => {
    const key = path.resolve(projectPath);
    const previous = cache.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    const value: Cached = { generation, entries: {}, snapshot: { projectPath: key, revision: (previous?.snapshot.revision ?? 0) + 1,
      columns: { claude: { phase: 'loading', diagnostics: [] }, codex: { phase: 'loading', diagnostics: [] } }, rows: [] } };
    cache.set(key, value);
    const finish = async (provider: CapabilityProvider, result: ProviderSnapshotResult, context?: SnapshotContext): Promise<void> => {
      const current = active(key, generation); if (!current) return;
      const entries: SnapshotEntry[] = []; const diagnostics = [...result.diagnostics];
      for (const entry of result.entries) {
        // Rebuild the allowlist even for injected readers; no raw extra property reaches DTO/events.
        const p = entry.presence;
        const safe: CapabilityPresence = { id: p.id, scope: p.scope, source: p.source, documentPath: p.documentPath,
          description: safeText(p.description), installed: p.installed, enabled: p.enabled, status: p.status,
          summary: safeText(p.summary), modelAvailable: p.modelAvailable, unavailableReason: p.unavailableReason,
          ...(p.sharedFrom ? { sharedFrom: p.sharedFrom } : {}) };
        const parsed = capabilityPresence.safeParse(safe);
        if (!parsed.success || !safeText(entry.name)) { diagnostics.push({ code: 'invalid-output' }); continue; }
        entries.push({ kind: entry.kind, name: safeText(entry.name)!, ...(entry.rowId && /^[a-f0-9]{64}$/.test(entry.rowId) ? { rowId: entry.rowId } : {}), presence: parsed.data });
      }
      if (context) entries.unshift({ kind: 'mcp', name: 'parley', rowId: rowIdentity('mcp', 'parley'), presence: {
        id: JSON.stringify([provider, 'mcp', 'builtin', 'parley']), scope: 'builtin', source: 'Parley launch',
        documentPath: null, description: 'Provided by Parley when a session starts.', installed: true,
        enabled: null, status: 'unknown', summary: 'Provided at session launch', modelAvailable: null, unavailableReason: null,
      } });
      let bytes = 0;
      const bounded = entries.filter(entry => { bytes += Buffer.byteLength(JSON.stringify(entry)); return bytes <= 1024 * 1024; });
      if (bounded.length !== entries.length) diagnostics.push({ code: 'output-limit', count: entries.length - bounded.length });
      current.entries[provider] = bounded;
      if (context) await markSharedLinks(context, current.entries);
      if (active(key, generation) !== current) return;
      current.snapshot.columns[provider] = { phase: diagnostics.length && result.phase === 'ready' ? 'partial' : result.phase, diagnostics };
      current.snapshot.rows = mergeSnapshotRows(current.entries);
      current.snapshot.revision += 1;
      try { current.snapshot = capabilitySnapshot.parse(current.snapshot); }
      catch { current.entries[provider] = []; current.snapshot.rows = mergeSnapshotRows(current.entries);
        current.snapshot.columns[provider] = { phase: 'error', diagnostics: [{ code: 'invalid-output' }] }; }
      emit(key, current);
    };
    void (options.context ?? defaultSnapshotContext)(key).then(context => {
      for (const provider of ['claude', 'codex'] as const) {
        const reader = options.readers?.[provider] ?? (provider === 'claude' ? readClaudeSnapshot : readCodexSnapshot);
        void reader(context, { readNative: options.readNative ?? readNativeJson }).then(async result => {
          result.diagnostics.push(...await builtinSkills(context, result.entries));
          await finish(provider, result, context);
        }).catch(() => finish(provider, { entries: [], diagnostics: [{ code: 'invalid-output' }], phase: 'error' }, context));
      }
    }).catch(() => {
      for (const provider of ['claude', 'codex'] as const)
        void finish(provider, { entries: [], diagnostics: [{ code: 'missing-context', source: 'context' }], phase: 'error' });
    });
    return copy(value.snapshot);
  };
  return { get(projectPath) { const value = cache.get(path.resolve(projectPath)); return value ? copy(value.snapshot) : refresh(projectPath); },
    refresh, dispose() { disposed = true; cache.clear(); } };
}
