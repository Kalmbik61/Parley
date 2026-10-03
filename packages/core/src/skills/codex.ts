import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readMarkdownFrontmatter, readTomlDocument, readYamlDocument } from './frontmatter.js';
import type { MetadataDiagnostic, MetadataDiagnosticCode, NativeSkill, SkillUnavailableReason } from './types.js';

type Source = Exclude<NativeSkill['source'], 'claude.ai'>;
export interface CodexSkillRoot {
  path: string;
  source: Source;
  /** The caller verified the native source, namespace and enablement policy. */
  verified?: boolean;
  enabled?: boolean;
  namespace?: string;
  /** Native containing plugin root for direct-child symlink boundaries. */
  pluginRoot?: string;
  discoveryMode?: 'recursive' | 'direct-children';
}
export interface CodexConfigLayer {
  source: 'User' | 'SessionFlags' | 'Project' | 'System';
  file?: string;
  data?: Record<string, unknown>;
  configFolder?: string;
  /** Generated Parley suppression must never enter the human rules snapshot. */
  provenance?: 'human' | 'parley';
  disabled?: boolean;
  /** Missing native default config is known-empty; explicit snapshots are required. */
  optional?: boolean;
}
export interface CodexNativeSkillEvidence {
  /** Bound actual participant cwd; inventory paths/names are native canonical identities. */
  cwd: string;
  verified: boolean;
  skills: readonly { path: string; name: string; source: 'user' | 'project'; enabled: boolean }[];
}
export interface CodexDiscoveryOptions {
  cwd: string;
  homeDir?: string;
  nativeEvidence?: CodexNativeSkillEvidence;
  codexHome?: string;
  /** Overrides native root discovery, allowing fully isolated fixtures. */
  roots?: CodexSkillRoot[];
  /** Native low-to-high order, including disabled User layers. */
  configLayers?: CodexConfigLayer[];
  projectRootMarkers?: string[];
  limits?: Partial<typeof NATIVE_LIMITS>;
}
export interface DiscoveryDiagnostic {
  provider: 'codex';
  source: Source;
  path: string;
  code: MetadataDiagnosticCode | 'traversal-limit' | 'symlink-cycle' | 'availability-unverified';
  line?: number;
  column?: number;
  count?: number;
}
export interface CodexDiscoveryResult {
  skills: NativeSkill[];
  diagnostics: DiscoveryDiagnostic[];
  /** Incomplete inventory must not be used to prune previously known entries. */
  partial: boolean;
}
const NATIVE_LIMITS = { maxDepth: 6, maxDirectories: 2000, maxEntries: 20000, maxAncestors: 128, maxRoots: 256 };
const CONFIG_MAX_BYTES = 65536;
type Rule = { selector: 'name' | 'path'; value: string; enabled: boolean; layer: CodexConfigLayer };
// Rust str::split_whitespace/trim use Unicode White_Space: unlike JS \s, this includes
// NEXT LINE (U+0085) and excludes BOM (U+FEFF). Config selectors trim only their edges.
const normalizeNativeWhitespace = (value: string): string => value.split(/\p{White_Space}+/u).filter(Boolean).join(' ');
const trimNativeWhitespace = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function absent(error: unknown): boolean {
  return mapping(error) && error.code === 'ENOENT';
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (absent(error)) return false; throw error; }
}
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const scopeOrder: Record<Source, number> = { project: 0, plugin: 0, extra: 1, user: 1, system: 2, admin: 3 };
function validMarkers(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= NATIVE_LIMITS.maxAncestors && value.every(marker =>
    typeof marker === 'string' && marker.length > 0 && !path.isAbsolute(marker) &&
    !marker.split(/[\\/]/).includes('..'));
}

export async function discoverCodexSkills(options: CodexDiscoveryOptions): Promise<CodexDiscoveryResult> {
  const result: CodexDiscoveryResult = { skills: [], diagnostics: [], partial: false };
  const cwd = path.resolve(options.cwd);
  const home = path.resolve(options.homeDir ?? homedir());
  const codexHome = path.resolve(options.codexHome ?? path.join(home, '.codex'));
  const limits = { ...NATIVE_LIMITS };
  const report = (source: Source, file: string, diagnostic: MetadataDiagnostic | Pick<DiscoveryDiagnostic, 'code' | 'count'>): void => {
    result.partial = true;
    result.diagnostics.push({ provider: 'codex', source, path: file, ...diagnostic });
  };
  for (const key of Object.keys(NATIVE_LIMITS) as Array<keyof typeof NATIVE_LIMITS>) {
    const requested = options.limits?.[key];
    if (requested === undefined) continue;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      report('project', cwd, { code: 'invalid-policy' });
      return result;
    }
    limits[key] = Math.min(requested, NATIVE_LIMITS[key]);
  }
  try { if (!(await stat(cwd)).isDirectory()) throw new Error(); }
  catch { report('project', cwd, { code: 'unreadable' }); return result; }

  // Evidence authorizes individual local documents, never a root or a same-name sibling.
  let evidenceKnown = false;
  const nativeIdentities = new Map<string, boolean>();
  if (options.nativeEvidence?.verified === true) {
    try { evidenceKnown = await realpath(options.nativeEvidence.cwd) === await realpath(cwd); }
    catch { /* A removed/foreign context provides no availability proof. */ }
  }
  if (evidenceKnown) {
    for (const item of options.nativeEvidence!.skills) {
      const key = JSON.stringify([item.path, item.name, item.source]);
      const previous = nativeIdentities.get(key);
      if (previous !== undefined && previous !== item.enabled) { evidenceKnown = false; break; }
      nativeIdentities.set(key, item.enabled);
    }
  }
  const layers: Array<{ layer: CodexConfigLayer; data: Record<string, unknown> }> = [];
  const rules: Rule[] = [];
  let humanPolicyKnown = true;
  let markers = options.projectRootMarkers ?? ['.git'];
  if (!validMarkers(markers)) { report('project', cwd, { code: 'invalid-policy' }); return result; }
  const configLayers: CodexConfigLayer[] = options.configLayers ?? [{ source: 'User', file: path.join(codexHome, 'config.toml'), configFolder: codexHome, optional: true }];
  for (const layer of configLayers) {
    if (layer.provenance === 'parley') continue;
    let data = layer.data ?? {};
    const source: Source = layer.source === 'Project' ? 'project' : layer.source === 'System' ? 'admin' : 'user';
    const configPath = layer.file ?? path.join(layer.configFolder ?? codexHome, 'config.toml');
    if (layer.data === undefined && layer.file !== undefined) {
      let present: boolean;
      try { present = await exists(layer.file); }
      catch { report(source, configPath, { code: 'unreadable' }); humanPolicyKnown = false; continue; }
      if (!present && layer.optional) {
        layers.push({ layer, data });
        continue;
      }
      const parsed = await readTomlDocument(layer.file, CONFIG_MAX_BYTES);
      if (parsed.status === 'invalid') {
        report(source, configPath, parsed.diagnostic);
        if (layer.source === 'User' || layer.source === 'SessionFlags') humanPolicyKnown = false;
        continue;
      }
      data = parsed.data;
    }
    layers.push({ layer, data });
    if (options.projectRootMarkers === undefined && layer.source !== 'Project' && !layer.disabled && data.project_root_markers !== undefined) {
      if (validMarkers(data.project_root_markers)) {
        markers = data.project_root_markers as string[];
      } else { report(source, configPath, { code: 'invalid-policy' }); return result; }
    }
    if (layer.source !== 'User' && layer.source !== 'SessionFlags') continue;
    if (data.skills === undefined) continue;
    if (!mapping(data.skills) || (data.skills.config !== undefined && !Array.isArray(data.skills.config))) {
      report(source, configPath, { code: 'invalid-policy' }); humanPolicyKnown = false; continue;
    }
    for (const entry of (data.skills.config ?? []) as unknown[]) {
      const hasName = mapping(entry) && entry.name !== undefined;
      const hasPath = mapping(entry) && entry.path !== undefined;
      if (!mapping(entry) || hasName === hasPath || typeof entry.enabled !== 'boolean' ||
        (hasName && (typeof entry.name !== 'string' || !trimNativeWhitespace(entry.name))) ||
        (hasPath && (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)))) {
        report(source, configPath, { code: 'invalid-policy' }); humanPolicyKnown = false; continue;
      }
      const selector = hasName ? 'name' : 'path';
      let value = hasName ? trimNativeWhitespace(entry.name as string) : path.normalize(entry.path as string);
      if (selector === 'path') { try { value = await realpath(value); } catch { /* Native keeps unresolved absolute selectors. */ } }
      const previous = rules.findIndex(rule => rule.selector === selector && rule.value === value);
      if (previous >= 0) rules.splice(previous, 1);
      rules.push({ selector, value, enabled: entry.enabled, layer });
    }
  }

  let roots = options.roots;
  if (roots === undefined) {
    roots = [];
    // Native layer-stack roots retain high-to-low precedence before canonical dedup.
    const rootLayers = layers.map(({ layer, data }) => ({
      layer: layer.configFolder === undefined && layer.file !== undefined && layer.source !== 'SessionFlags'
        ? { ...layer, configFolder: path.dirname(path.resolve(layer.file)) } : layer,
      data,
    })).filter(({ layer }) => layer.configFolder !== undefined);
    if (!rootLayers.some(({ layer }) => layer.source === 'User')) {
      rootLayers.unshift({ layer: { source: 'User', configFolder: codexHome }, data: {} });
    }
    for (const { layer } of [...rootLayers].reverse()) {
      const folder = layer.configFolder!;
      if (layer.source === 'Project') roots.push({ path: path.join(folder, 'skills'), source: 'project' });
      else if (layer.source === 'User') {
        roots.push({ path: path.join(folder, 'skills'), source: 'user', verified: true });
        roots.push({ path: path.join(home, '.agents/skills'), source: 'user', verified: true });
        roots.push({ path: path.join(folder, 'skills/.system'), source: 'system' });
      } else if (layer.source === 'System') roots.push({ path: path.join(folder, 'skills'), source: 'admin' });
    }
    const ancestors: string[] = [];
    let cursor = cwd;
    while (true) {
      ancestors.push(cursor);
      let found = markers.length === 0;
      for (const marker of markers) {
        try { if (await exists(path.join(cursor, marker))) { found = true; break; } }
        catch { report('project', cursor, { code: 'unreadable' }); return result; }
      }
      if (found) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) { ancestors.splice(1); break; }
      if (ancestors.length >= limits.maxAncestors) { report('project', cwd, { code: 'traversal-limit', count: ancestors.length }); return result; }
      cursor = parent;
    }
    for (const ancestor of ancestors.reverse()) {
      roots.push({ path: path.join(ancestor, '.codex/skills'), source: 'project' });
      roots.push({ path: path.join(ancestor, '.agents/skills'), source: 'project', verified: true });
    }
  }
  if (roots.length > limits.maxRoots) report('project', cwd, { code: 'traversal-limit', count: roots.length });
  const files = new Set<string>();
  const rootPaths = new Set<string>();

  async function load(file: string, root: CodexSkillRoot, boundary?: string): Promise<void> {
    let canonical: string;
    try { canonical = await realpath(file); } catch { report(root.source, file, { code: 'unreadable' }); return; }
    if (boundary !== undefined) {
      const relative = path.relative(boundary, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        report(root.source, canonical, { code: 'availability-unverified' }); return;
      }
    }
    if (files.has(canonical)) return;
    files.add(canonical);
    const parsed = await readMarkdownFrontmatter(canonical);
    if (parsed.status !== 'valid') {
      report(root.source, canonical, parsed.status === 'invalid' ? parsed.diagnostic : { code: 'invalid-yaml' });
      return;
    }
    const fallback = normalizeNativeWhitespace(path.basename(path.dirname(canonical))) || 'skill';
    const rawName = Object.hasOwn(parsed.data, 'name') ? parsed.data.name : fallback;
    const normalizedName = typeof rawName === 'string' ? normalizeNativeWhitespace(rawName) : '';
    if (typeof rawName !== 'string' || !normalizedName || [...normalizedName].length > 64 || rawName.includes('\0')) {
      report(root.source, canonical, { code: 'invalid-name' }); return;
    }
    const name = root.namespace ? `${root.namespace}:${normalizedName}` : normalizedName;
    if (root.namespace && (!trimNativeWhitespace(root.namespace) || [...name].length > 129 ||
      root.namespace.includes('\0') || root.namespace.includes('\r') || root.namespace.includes('\n'))) {
      report(root.source, canonical, { code: 'invalid-name' }); return;
    }
    const description = typeof parsed.data.description === 'string' && parsed.data.description.trim() ? parsed.data.description : '';
    let reason: SkillUnavailableReason | null = null;
    if (!description) { reason = 'invalid-metadata'; report(root.source, canonical, { code: 'invalid-policy' }); }
    const native = evidenceKnown && !root.namespace && (root.source === 'user' || root.source === 'project')
      ? nativeIdentities.get(JSON.stringify([canonical, name, root.source]))
      : undefined;
    const verified = options.nativeEvidence === undefined ? root.verified === true : native !== undefined;
    if (reason === null && (!verified || (root.source === 'plugin' && !root.namespace) || !humanPolicyKnown)) reason = 'availability-unverified';
    if (reason === null && (root.enabled === false || native === false))
      reason = root.source === 'plugin' ? 'plugin-disabled' : 'human-disabled';
    let enabled = true;
    for (const rule of rules) if ((rule.selector === 'name' && rule.value === name) || (rule.selector === 'path' && rule.value === canonical)) enabled = rule.enabled;
    if (reason === null && !enabled) reason = 'human-disabled';
    const policyFile = path.join(path.dirname(canonical), 'agents/openai.yaml');
    try {
      if (await exists(policyFile)) {
        const policy = await readYamlDocument(policyFile, CONFIG_MAX_BYTES);
        if (policy.status === 'invalid') {
          report(root.source, policyFile, { ...policy.diagnostic, code: 'invalid-policy' });
          if (reason !== 'invalid-metadata') reason = 'availability-unverified';
        } else if (policy.data.policy !== undefined && (!mapping(policy.data.policy) ||
          (policy.data.policy.allow_implicit_invocation !== undefined && typeof policy.data.policy.allow_implicit_invocation !== 'boolean'))) {
          report(root.source, policyFile, { code: 'invalid-policy' });
          if (reason !== 'invalid-metadata') reason = 'availability-unverified';
        } else if (mapping(policy.data.policy)) {
          // Product-filter parity is not verified; never infer an eligible native product.
          const products = policy.data.policy.products;
          if (products !== undefined && (!Array.isArray(products) || products.length > 0)) {
            report(root.source, policyFile, { code: 'invalid-policy' });
            if (reason !== 'invalid-metadata') reason = 'availability-unverified';
          } else if (policy.data.policy.allow_implicit_invocation === false && reason === null) reason = 'implicit-invocation-disabled';
        }
      }
    } catch { report(root.source, policyFile, { code: 'invalid-policy' }); if (reason !== 'invalid-metadata') reason = 'availability-unverified'; }
    result.skills.push({ provider: 'codex', documentKind: 'skill', name, description, source: root.source, path: canonical, modelAvailable: reason === null, unavailableReason: reason });
  }

  for (const root of roots.slice(0, limits.maxRoots)) {
    const rootPath = path.resolve(root.path);
    let canonicalRoot: string;
    try {
      if (!(await exists(rootPath))) continue;
      canonicalRoot = await realpath(rootPath);
      if (!(await stat(canonicalRoot)).isDirectory()) throw new Error();
    } catch { report(root.source, rootPath, { code: 'unreadable' }); continue; }
    if (!root.verified || (root.source === 'plugin' && !root.namespace)) report(root.source, canonicalRoot, { code: 'availability-unverified' });
    if (rootPaths.has(canonicalRoot)) continue;
    rootPaths.add(canonicalRoot);
    let boundary: string | undefined;
    if (root.discoveryMode === 'direct-children') {
      try { boundary = root.pluginRoot ? await realpath(root.pluginRoot) : canonicalRoot; }
      catch { report(root.source, rootPath, { code: 'availability-unverified' }); continue; }
    }
    const visited = new Set<string>();
    let directoryCount = 0;
    let entryCount = 0;
    let limited = false;
    const limit = (): void => { if (!limited) { report(root.source, canonicalRoot, { code: 'traversal-limit', count: entryCount }); limited = true; } };
    async function walk(directory: string, depth: number, active: Set<string>): Promise<void> {
      let canonical: string;
      try { canonical = await realpath(directory); } catch { report(root.source, directory, { code: 'unreadable' }); return; }
      if (active.has(canonical)) { report(root.source, directory, { code: 'symlink-cycle' }); return; }
      if (visited.has(canonical)) return;
      if (directoryCount >= limits.maxDirectories) { limit(); return; }
      directoryCount++;
      visited.add(canonical);
      const nextActive = new Set(active); nextActive.add(canonical);
      const entries = [];
      try {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          if (entryCount >= limits.maxEntries) { limit(); break; }
          entryCount++; entries.push(entry);
        }
      } catch { report(root.source, directory, { code: 'unreadable' }); return; }
      entries.sort((a, b) => compare(a.name, b.name));
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const entryDepth = depth + 1;
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try { const target = await stat(entryPath); isDirectory = target.isDirectory(); isFile = target.isFile(); }
          catch { report(root.source, entryPath, { code: 'unreadable' }); continue; }
          if (isDirectory && root.source === 'system') continue;
        }
        const direct = root.discoveryMode === 'direct-children';
        if (isDirectory) {
          if (entry.name.startsWith('.') || (direct && depth >= 1)) continue;
          if (entryDepth >= limits.maxDepth) { limit(); continue; }
          await walk(entryPath, entryDepth, nextActive);
        } else if (isFile && entry.name === 'SKILL.md' && (!direct || depth === 1)) {
          if (entryDepth > limits.maxDepth) { limit(); continue; }
          await load(entryPath, root, boundary);
        }
      }
    }
    await walk(rootPath, 0, new Set());
  }
  result.skills.sort((a, b) => scopeOrder[a.source as Source] - scopeOrder[b.source as Source] || compare(a.name, b.name) || compare(a.path, b.path));
  return result;
}
