import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { readMarkdownFrontmatter } from './frontmatter.js';
import type { MetadataDiagnosticCode, NativeSkill, SkillUnavailableReason } from './types.js';

type Source = NativeSkill['source'];
type Kind = 'skill' | 'command';
type Visibility = 'on' | 'off' | 'name-only' | 'user-invocable-only';
type Layer = 'user' | 'project' | 'local' | 'flag' | 'managed';

export interface DiscoveryDiagnostic {
  provider: 'claude';
  code:
    | MetadataDiagnosticCode
    | 'invalid-json'
    | 'invalid-settings'
    | 'invalid-plugin'
    | 'availability-unverified'
    | 'missing-context'
    | 'discovery-limit'
    | 'symlink-cycle'
    | 'alias-conflict'
    | 'ambiguous-name'
    | 'outside-source';
  source?: Source;
  path?: string;
  line?: number;
  column?: number;
  count?: number;
}

export interface ClaudePluginEvidence {
  id: string;
  namespace: string;
  installPath: string;
  enabled: boolean | null;
  /** Native snapshot confirms this cwd, namespace and conventional skills/commands layout. */
  verified: boolean;
}

export interface ClaudeSyncedEvidence {
  account: string;
  accountVerified: boolean;
  /** Entries must be native active-account manifest entries, not a filesystem glob. */
  manifestVerified: boolean;
  skills: readonly { name: string; path: string }[];
}

export interface ClaudeNativeEvidence {
  /** Evidence belongs to this session cwd (canonical aliases are accepted). */
  cwd: string;
  /**
   * Caller verified effective policy for this session, including flag/managed layers.
   * Local user/project roots need this evidence; JSON syntax alone is not native policy proof.
   * Plugins additionally need verified namespace/layout + enabled=true; synced skills need
   * the verified active account and manifest. Refresh evidence when session inputs change.
   */
  policyVerified: boolean;
  loadToolAvailable: boolean;
  plugins?: readonly ClaudePluginEvidence[];
  synced?: ClaudeSyncedEvidence;
}

export interface ClaudeDiscoveryOptions {
  cwd: string;
  homeDir: string;
  configDir?: string;
  /**
   * Merge order: user, project, local, flag, managed. Injected layers replace that input.
   * Absent user/project/local layers are read locally; flag/managed are injection-only.
   * Caller supplies their effective values before asserting native policy verification.
   */
  settings?: Partial<Record<Layer, unknown>>;
  /** Reusable native context evidence: discovery itself never invokes a CLI or model. */
  nativeEvidence?: ClaudeNativeEvidence;
  /** Parley safeguards; these are not claims about Claude's native traversal limits. */
  limits?: { maxEntries?: number; maxDirectories?: number; maxCommandDepth?: number };
}

export interface ClaudeDiscoveryResult {
  skills: NativeSkill[];
  diagnostics: DiscoveryDiagnostic[];
  partial: boolean;
}

interface Root {
  directory: string;
  source: Source;
  kind: Kind;
  verified: boolean;
  namespace?: string;
  containment?: string;
  reason?: SkillUnavailableReason;
}
interface Candidate {
  skill: NativeSkill;
  kind: Kind;
}
type JsonResult =
  | { status: 'valid'; data: unknown }
  | { status: 'missing' }
  | { status: 'invalid'; code: 'invalid-json' | 'invalid-utf8' | 'file-too-large' | 'unreadable' };

const JSON_MAX_BYTES = 1048576;
const compare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const part = (name: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);
const nativeName = (name: string): boolean => name.split(':').every(part);
const inside = (base: string, file: string): boolean => {
  const relative = path.relative(base, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
async function trulyAbsent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    return absent(error);
  }
}

/** Bounded, nonblocking JSON reads, with no exception/source text in the result. */
async function readJson(file: string): Promise<JsonResult> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return { status: 'invalid', code: 'unreadable' };
      const buffer = Buffer.alloc(JSON_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > JSON_MAX_BYTES) return { status: 'invalid', code: 'file-too-large' };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      } catch {
        return { status: 'invalid', code: 'invalid-utf8' };
      }
      try {
        return { status: 'valid', data: JSON.parse(text) as unknown };
      } catch {
        return { status: 'invalid', code: 'invalid-json' };
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    return absent(error) && (await trulyAbsent(file))
      ? { status: 'missing' }
      : { status: 'invalid', code: 'unreadable' };
  }
}

/** Read-only resolver. Unknown source/policy evidence never upgrades model availability. */
export async function discoverClaudeSkills(
  options: ClaudeDiscoveryOptions,
): Promise<ClaudeDiscoveryResult> {
  const result: ClaudeDiscoveryResult = { skills: [], diagnostics: [], partial: false };
  const diagnose = (diagnostic: Omit<DiscoveryDiagnostic, 'provider'>): void => {
    result.diagnostics.push({ provider: 'claude', ...diagnostic });
    result.partial = true;
  };
  let cwd: string;
  try {
    if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.homeDir)) throw new Error();
    cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    diagnose({ code: 'missing-context', path: options.cwd });
    return result;
  }
  const configDir = path.resolve(cwd, options.configDir ?? path.join(options.homeDir, '.claude'));
  let contextVerified = false;
  try {
    contextVerified =
      options.nativeEvidence !== undefined &&
      (await realpath(options.nativeEvidence.cwd)) === cwd &&
      options.nativeEvidence.policyVerified === true;
  } catch {
    /* Unknown/deleted evidence context must not fall back to the main checkout. */
  }
  if (!contextVerified) diagnose({ code: 'availability-unverified', path: cwd });
  const loadToolAvailable = options.nativeEvidence?.loadToolAvailable === true;
  const limit = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    if (Number.isSafeInteger(value) && value >= 0 && value <= fallback) return value;
    diagnose({ code: 'discovery-limit' });
    return 0;
  };
  const maxEntries = limit(options.limits?.maxEntries, 20000);
  const maxDirectories = limit(options.limits?.maxDirectories, 2000);
  const maxDepth = limit(options.limits?.maxCommandDepth, 6);
  let entryCount = 0;
  let directoryCount = 0;
  const overrides = new Map<string, Visibility>();
  const enabledPlugins = new Map<string, boolean>();
  let syncDisabled = false;
  let settingsVerified = true;
  const layers: Array<{ name: Layer; source: Source; file?: string }> = [
    { name: 'user', source: 'user', file: path.join(configDir, 'settings.json') },
    { name: 'project', source: 'project', file: path.join(cwd, '.claude/settings.json') },
    { name: 'local', source: 'project', file: path.join(cwd, '.claude/settings.local.json') },
    { name: 'flag', source: 'extra' },
    { name: 'managed', source: 'admin' },
  ];
  for (const layer of layers) {
    let data: unknown = {};
    if (options.settings && Object.hasOwn(options.settings, layer.name))
      data = options.settings[layer.name];
    else if (layer.file) {
      const read = await readJson(layer.file);
      if (read.status === 'invalid') {
        diagnose({ code: read.code, source: layer.source, path: layer.file });
        settingsVerified = false;
        continue;
      }
      if (read.status === 'valid') data = read.data;
    }
    const bad = (): void => {
      settingsVerified = false;
      diagnose({
        code: 'invalid-settings',
        source: layer.source,
        ...(layer.file ? { path: layer.file } : {}),
      });
    };
    if (!record(data)) {
      bad();
      continue;
    }
    for (const key of ['skillOverrides', 'enabledPlugins'] as const) {
      const values = data[key];
      if (values === undefined) continue;
      if (!record(values)) {
        bad();
        continue;
      }
      for (const [name, value] of Object.entries(values)) {
        if (key === 'skillOverrides') {
          if (
            value === 'on' ||
            value === 'off' ||
            value === 'name-only' ||
            value === 'user-invocable-only'
          )
            overrides.set(name, value);
          else bad();
        } else if (typeof value === 'boolean') enabledPlugins.set(name, value);
        else bad();
      }
    }
    if (layer.name !== 'project' && data.syncClaudeAiSkills !== undefined) {
      if (typeof data.syncClaudeAiSkills !== 'boolean') bad();
      else if (!data.syncClaudeAiSkills) syncDisabled = true;
    }
  }

  const candidates = new Map<string, Candidate>();
  const pluginInventory: ClaudePluginEvidence[] = [];
  async function addDocument(
    file: string,
    name: string,
    root: Root,
    optional = false,
  ): Promise<void> {
    if (!nativeName(name)) {
      diagnose({ code: 'invalid-name', source: root.source, path: file });
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(file);
    } catch (error) {
      if (!(optional && absent(error) && (await trulyAbsent(file))))
        diagnose({ code: 'unreadable', source: root.source, path: file });
      return;
    }
    if (root.containment && !inside(root.containment, canonical)) {
      diagnose({ code: 'outside-source', source: root.source, path: file });
      return;
    }
    const previous = candidates.get(canonical);
    if (previous) {
      if (previous.skill.name !== name) {
        previous.skill.modelAvailable = false;
        previous.skill.unavailableReason = 'availability-unverified';
        diagnose({ code: 'alias-conflict', source: root.source, path: canonical });
      }
      return;
    }
    const metadata = await readMarkdownFrontmatter(canonical);
    if (metadata.status === 'invalid') {
      diagnose({ ...metadata.diagnostic, source: root.source, path: canonical });
      return;
    }
    const data = metadata.status === 'valid' ? metadata.data : {};
    const description =
      typeof data.description === 'string' && data.description.trim() !== ''
        ? data.description
        : '';
    let reason: SkillUnavailableReason | null = null;
    if (!description) reason = 'invalid-metadata';
    const disabled = data['disable-model-invocation'];
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      reason = 'invalid-metadata';
      diagnose({ code: 'invalid-policy', source: root.source, path: canonical });
    } else if (disabled === true) reason ??= 'disable-model-invocation';
    // Plugin and account-synced skills have native source-specific visibility, not skillOverrides.
    if (root.source !== 'plugin' && root.source !== 'claude.ai') {
      const visibility = overrides.get(name);
      if (visibility === 'off') reason ??= 'human-disabled';
      if (visibility === 'user-invocable-only') reason ??= 'user-invocable-only';
    }
    reason ??= root.reason ?? null;
    if (!contextVerified || !settingsVerified || !root.verified)
      reason ??= 'availability-unverified';
    else if (!loadToolAvailable) reason ??= 'load-tool-unavailable';
    candidates.set(canonical, {
      kind: root.kind,
      skill: {
        provider: 'claude',
        name,
        description,
        source: root.source,
        path: canonical,
        modelAvailable: reason === null,
        unavailableReason: reason,
      },
    });
  }

  async function directoryEntries(
    root: Root,
    ancestors: ReadonlySet<string>,
  ): Promise<{ entries: Dirent[]; canonical: string } | null> {
    let canonical: string;
    try {
      canonical = await realpath(root.directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error();
    } catch (error) {
      if (!(absent(error) && (await trulyAbsent(root.directory))))
        diagnose({ code: 'unreadable', source: root.source, path: root.directory });
      return null;
    }
    if (root.containment && !inside(root.containment, canonical)) {
      diagnose({ code: 'outside-source', source: root.source, path: root.directory });
      return null;
    }
    if (ancestors.has(canonical)) {
      diagnose({ code: 'symlink-cycle', source: root.source, path: canonical });
      return null;
    }
    if (directoryCount >= maxDirectories) {
      diagnose({
        code: 'discovery-limit',
        source: root.source,
        path: canonical,
        count: directoryCount,
      });
      return null;
    }
    directoryCount += 1;
    const entries: Dirent[] = [];
    try {
      const directory = await opendir(canonical);
      for await (const entry of directory) {
        if (entryCount >= maxEntries) {
          diagnose({
            code: 'discovery-limit',
            source: root.source,
            path: canonical,
            count: entryCount,
          });
          break;
        }
        entryCount += 1;
        entries.push(entry);
      }
    } catch {
      diagnose({ code: 'unreadable', source: root.source, path: canonical });
    }
    return { canonical, entries: entries.sort((a, b) => compare(a.name, b.name)) };
  }

  async function isDirectory(full: string, entry: Dirent, source: Source): Promise<boolean> {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return (await stat(full)).isDirectory();
    } catch {
      diagnose({ code: 'unreadable', source, path: full });
      return false;
    }
  }

  async function scan(
    root: Root,
    parents: string[] = [],
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const read = await directoryEntries(root, ancestors);
    if (!read) return;
    const nextAncestors = new Set([...ancestors, read.canonical]);
    for (const entry of read.entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(root.directory, entry.name);
      if (root.kind === 'skill') {
        if (root.source === 'user' && entry.name === 'synced') {
          if (!options.nativeEvidence?.synced)
            diagnose({ code: 'availability-unverified', source: 'claude.ai', path: full });
          continue;
        }
        if (!(await isDirectory(full, entry, root.source))) continue;
        const name = root.namespace ? root.namespace + ':' + entry.name : entry.name;
        await addDocument(path.join(full, 'SKILL.md'), name, root, true);
        if (root.source === 'user' || root.source === 'project') {
          const manifest = await readJson(path.join(full, '.claude-plugin/plugin.json'));
          if (manifest.status === 'valid') {
            if (
              record(manifest.data) &&
              typeof manifest.data.name === 'string' &&
              part(manifest.data.name)
            ) {
              pluginInventory.push({
                id: manifest.data.name + '@skills-dir',
                namespace: manifest.data.name,
                installPath: full,
                enabled: null,
                verified: false,
              });
            } else diagnose({ code: 'invalid-plugin', source: 'plugin', path: full });
          } else if (manifest.status === 'invalid')
            diagnose({ code: manifest.code, source: 'plugin', path: full });
        }
      } else if (entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink())) {
        const parts = [...parents, entry.name.slice(0, -3)];
        const name = [...(root.namespace ? [root.namespace] : []), ...parts].join(':');
        await addDocument(full, name, root);
      } else if (await isDirectory(full, entry, root.source)) {
        if (parents.length >= maxDepth)
          diagnose({
            code: 'discovery-limit',
            source: root.source,
            path: full,
            count: parents.length + 1,
          });
        else await scan({ ...root, directory: full }, [...parents, entry.name], nextAncestors);
      }
    }
  }

  // Observed precedence applies only to plain user/project skills, not command/plugin collisions.
  for (const [base, source] of [
    [configDir, 'user'],
    [path.join(cwd, '.claude'), 'project'],
  ] as const) {
    await scan({ directory: path.join(base, 'skills'), source, kind: 'skill', verified: true });
    await scan({ directory: path.join(base, 'commands'), source, kind: 'command', verified: true });
  }

  const registryPath = path.join(configDir, 'plugins/installed_plugins.json');
  const registry = await readJson(registryPath);
  if (registry.status === 'invalid')
    diagnose({ code: registry.code, source: 'plugin', path: registryPath });
  else if (registry.status === 'valid') {
    if (!record(registry.data) || registry.data.version !== 2 || !record(registry.data.plugins))
      diagnose({ code: 'invalid-plugin', source: 'plugin', path: registryPath });
    else
      for (const [id, rows] of Object.entries(registry.data.plugins)) {
        if (!Array.isArray(rows)) {
          diagnose({ code: 'invalid-plugin', source: 'plugin', path: registryPath });
          continue;
        }
        for (const row of rows) {
          if (pluginInventory.length >= maxEntries) {
            diagnose({ code: 'discovery-limit', source: 'plugin', path: registryPath });
            break;
          }
          if (
            !record(row) ||
            typeof row.installPath !== 'string' ||
            !path.isAbsolute(row.installPath) ||
            typeof row.scope !== 'string' ||
            !['user', 'project', 'local'].includes(row.scope)
          ) {
            diagnose({ code: 'invalid-plugin', source: 'plugin', path: registryPath });
            continue;
          }
          if (row.scope !== 'user') {
            if (typeof row.projectPath !== 'string') {
              diagnose({ code: 'invalid-plugin', source: 'plugin', path: registryPath });
              continue;
            }
            if (
              path.resolve(row.projectPath) !== cwd &&
              path.resolve(row.projectPath) !== path.resolve(options.cwd)
            )
              continue;
          }
          pluginInventory.push({
            id,
            namespace: id.split('@')[0] ?? '',
            installPath: row.installPath,
            enabled: null,
            verified: false,
          });
        }
      }
  }

  const pluginPaths = new Map<string, ClaudePluginEvidence>();
  const plugins = [...(options.nativeEvidence?.plugins ?? []), ...pluginInventory];
  for (const plugin of plugins.slice(0, maxEntries)) {
    if (
      !part(plugin.namespace) ||
      !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(plugin.id) ||
      !path.isAbsolute(plugin.installPath)
    ) {
      diagnose({ code: 'invalid-plugin', source: 'plugin' });
      continue;
    }
    let canonical: string;
    try {
      canonical = await realpath(plugin.installPath);
    } catch {
      diagnose({ code: 'unreadable', source: 'plugin', path: plugin.installPath });
      continue;
    }
    const previousPlugin = pluginPaths.get(canonical);
    if (previousPlugin) {
      if (
        previousPlugin.verified &&
        plugin.verified &&
        (previousPlugin.namespace !== plugin.namespace || previousPlugin.enabled !== plugin.enabled)
      ) {
        for (const candidate of candidates.values())
          if (candidate.skill.source === 'plugin' && inside(canonical, candidate.skill.path)) {
            candidate.skill.modelAvailable = false;
            candidate.skill.unavailableReason = 'availability-unverified';
          }
        diagnose({ code: 'alias-conflict', source: 'plugin', path: canonical });
      }
      continue;
    }
    pluginPaths.set(canonical, plugin);
    const manifest = await readJson(path.join(canonical, '.claude-plugin/plugin.json'));
    let verified = plugin.verified;
    if (manifest.status === 'invalid') {
      verified = false;
      diagnose({ code: manifest.code, source: 'plugin', path: canonical });
    } else if (manifest.status === 'missing') {
      verified = false;
      diagnose({ code: 'invalid-plugin', source: 'plugin', path: canonical });
    } else if (
      !record(manifest.data) ||
      manifest.data.name !== plugin.namespace ||
      manifest.data.skills !== undefined ||
      manifest.data.commands !== undefined
    )
      verified = false;
    const enabled = enabledPlugins.get(plugin.id) === false ? false : plugin.enabled;
    const reason =
      enabled === false
        ? 'plugin-disabled'
        : !verified || enabled !== true
          ? 'availability-unverified'
          : undefined;
    if (!verified || enabled === null)
      diagnose({ code: 'availability-unverified', source: 'plugin', path: canonical });
    for (const kind of ['skill', 'command'] as const) {
      await scan({
        directory: path.join(canonical, kind === 'skill' ? 'skills' : 'commands'),
        source: 'plugin',
        kind,
        namespace: plugin.namespace,
        containment: canonical,
        verified: verified && enabled === true,
        ...(reason ? { reason } : {}),
      });
    }
  }
  if (plugins.length > maxEntries)
    diagnose({ code: 'discovery-limit', source: 'plugin', count: plugins.length });

  const synced = options.nativeEvidence?.synced;
  if (synced) {
    const directory = path.join(configDir, 'skills/synced');
    if (!part(synced.account))
      diagnose({ code: 'invalid-name', source: 'claude.ai', path: directory });
    else {
      let canonicalAccount: string | undefined;
      try {
        const canonicalSyncRoot = await realpath(directory);
        canonicalAccount = await realpath(path.join(directory, synced.account));
        if (canonicalAccount !== path.join(canonicalSyncRoot, synced.account)) {
          diagnose({ code: 'outside-source', source: 'claude.ai', path: directory });
          canonicalAccount = undefined;
        }
      } catch {
        diagnose({ code: 'unreadable', source: 'claude.ai', path: directory });
      }
      if (canonicalAccount) {
        const verified = synced.accountVerified && synced.manifestVerified;
        if (!verified)
          diagnose({
            code: 'availability-unverified',
            source: 'claude.ai',
            path: canonicalAccount,
          });
        for (const entry of synced.skills.slice(0, maxEntries)) {
          if (!entry.name.startsWith('anthropic-skills:') || !path.isAbsolute(entry.path)) {
            diagnose({ code: 'invalid-name', source: 'claude.ai', path: canonicalAccount });
            continue;
          }
          await addDocument(entry.path, entry.name, {
            directory: canonicalAccount,
            source: 'claude.ai',
            kind: 'skill',
            verified,
            containment: canonicalAccount,
            ...(syncDisabled ? { reason: 'human-disabled' } : {}),
          });
        }
        if (synced.skills.length > maxEntries)
          diagnose({ code: 'discovery-limit', source: 'claude.ai', count: synced.skills.length });
      }
    }
  }

  const names = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) {
    const previous = names.get(candidate.skill.name) ?? [];
    previous.push(candidate);
    names.set(candidate.skill.name, previous);
  }
  for (const group of names.values()) {
    if (group.length < 2) continue;
    const plain = group.every(
      (c) => c.kind === 'skill' && (c.skill.source === 'user' || c.skill.source === 'project'),
    );
    const user = group.find((c) => c.skill.source === 'user');
    if (plain && user && group.filter((c) => c.skill.source === 'user').length === 1) {
      for (const candidate of group)
        if (candidate !== user) {
          candidate.skill.modelAvailable = false;
          candidate.skill.unavailableReason = 'shadowed';
        }
    } else {
      for (const candidate of group) {
        candidate.skill.modelAvailable = false;
        candidate.skill.unavailableReason = 'availability-unverified';
      }
      diagnose({ code: 'ambiguous-name', count: group.length });
    }
  }
  result.skills = [...candidates.values()]
    .map((c) => c.skill)
    .sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path));
  return result;
}
