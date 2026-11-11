// The Claude row's `plugins` class (plan T12a-Claude, slice C2c; lead m-7689 and m-7698 after the human's narrowed hook rule relayed in
// m-7697; s-296 m-7688 P-1..P-3). It reads which plugins are installed and active, and only for the active ones their declarative hooks
// (`manifest.hooks` JSON files or the inline object, `hooks/hooks.json`) and their manifest `settings`, through C2b's `hooksVerdict` and
// C2a's `settingsTextVerdict`. A hook targeting Parley is a trigger; anything it cannot read or resolve is `uninspected:plugins`.
//
// Not read, by the human's decision (accepted residual): JavaScript hooks modules (`hooks/register.ts`), mods folders, and the hooks modules of
// the client's built-in plugins. Matcherless hooks and plugins do not turn the mode off.
//
// What 2.1.322 does (read from its binary): installed plugins come from `<configRoot>/plugins/installed_plugins.json`, an entry per scope
// (`managed`, `user`, `project`, `local`; `projectPath` for the last two). An explicit `enabledPlugins` value wins; otherwise the manifest's
// `defaultEnabled`, true when absent; a plugin required by an enabled dependent is enabled regardless (`dependencies`: a name, `name@market`,
// or `{name, marketplace?}`, a bare name resolved in the dependent's own marketplace). The precedence between settings sources is not pinned,
// so a plugin counts as disabled only when no source says `true` and some source says `false` (lead m-7689 Q1 fallback; errs toward reading).

import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { type ManagedLayer, followedPrint, hooksVerdict, readFollowingOneLink, realManagedLayer, settingsTextVerdict } from './claude-settings.js';
import { CLEAR, SETTINGS_MAX_BYTES, type SourceClass, type SourceVerdict } from './detector.js';
import type { LaunchIdentities } from './launch-decision.js';

const uninspected = (): SourceVerdict => Object.freeze({ kind: 'uninspected', sourceClass: 'plugins' });

/** Bounds per check (s-296 P-2): over any of them the class is uninspected. */
export const PLUGIN_BOUNDS = Object.freeze({ ids: 64, hookFilesPerPlugin: 16, dependencyRounds: 64, dropins: 64 });

type Json = Record<string, unknown>;
const isPlain = (o: unknown): o is Json => typeof o === 'object' && o !== null && !Array.isArray(o);

/** A JSON object file, read like every Claude source (one link level, bounded, no-follow, FIFO-safe), cached by its fingerprint. */
function jsonReader(): (file: string) => Json | 'absent' | 'unreadable' {
  const cache = new Map<string, { readonly print: string; readonly value: Json | 'absent' | 'unreadable' }>();
  return (file) => {
    const before = followedPrint(file);
    const hit = cache.get(file);
    if (hit !== undefined && before !== null && hit.print === before) return hit.value;
    const { read, print } = readFollowingOneLink(file, SETTINGS_MAX_BYTES);
    let value: Json | 'absent' | 'unreadable';
    if (read.kind === 'absent') value = 'absent';
    else if (read.kind !== 'text') value = 'unreadable';
    else {
      try {
        const data: unknown = JSON.parse(read.text);
        value = isPlain(data) ? data : 'unreadable';
      } catch { value = 'unreadable'; }
    }
    if (print !== null && print === before) cache.set(file, { print, value });
    else cache.delete(file);
    return value;
  };
}

/** `name@marketplace` → its marketplace, or undefined for a bare name. */
const marketplaceOf = (id: string): string | undefined => (id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : undefined);

/** A dependency of plugin `of`, as the client resolves it; undefined when its shape is not one the client accepts. */
function dependencyId(dep: unknown, of: string): string | undefined {
  let name: string;
  let market: string | undefined;
  if (typeof dep === 'string') {
    const bare = dep.replace(/@\^[^@]*$/, '');
    if (bare.includes('@')) { name = bare.slice(0, bare.lastIndexOf('@')); market = bare.slice(bare.lastIndexOf('@') + 1); } else name = bare;
  } else if (isPlain(dep) && typeof dep['name'] === 'string') {
    name = dep['name'];
    market = typeof dep['marketplace'] === 'string' ? dep['marketplace'] : undefined;
  } else return undefined;
  if (!/^[A-Za-z0-9][-A-Za-z0-9._]*$/.test(name)) return undefined;
  const m = market ?? marketplaceOf(of);
  return m === undefined ? name : `${name}@${m}`;
}

/**
 * A file under a plugin root, resolved by realpath against the realpath'd root before any read (s-296 P-2), so `..` or a link inside the
 * plugin cannot lead outside it: the real path, `absent`, or null when it cannot be resolved or escapes the root.
 */
function inside(root: string, file: string): string | 'absent' | null {
  let real: string;
  try { real = realpathSync(path.resolve(root, file)); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
  const rel = path.relative(root, real);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : real;
}

/** A hook definition file's or an inline object's hook map: `{hooks: {...}}` or the event map itself. */
const hookMap = (o: Json): unknown => (Object.hasOwn(o, 'hooks') ? o['hooks'] : o);

export interface PluginsOptions {
  /** Where the managed settings live (their `enabledPlugins`). Tests replace it. */
  readonly managed?: ManagedLayer;
}

/**
 * The class. Needs the launch's `configRoot` and `cwd`; without them it is uninspected. Each check: the installed set, the effective
 * `enabledPlugins` from every settings source C2a reads, `defaultEnabled` and dependencies to a bounded fixed point, then the declarative hooks
 * and `settings` of each active plugin. Disabled plugins are never read.
 */
export function claudePluginsClass(identities: LaunchIdentities | undefined, options: PluginsOptions = {}): SourceClass {
  const configRoot = identities?.configRoot;
  const cwd = identities?.cwd;
  if (configRoot === undefined || cwd === undefined) return Object.freeze({ name: 'plugins', check: uninspected });
  const managed = options.managed ?? realManagedLayer();
  const projectDirs = new Set([cwd, ...(identities?.gitRoot === undefined ? [] : [identities.gitRoot])]);
  const read = jsonReader();

  const settingsFiles = (): string[] | null => {
    const files = [
      path.join(configRoot, 'settings.json'),
      ...[...projectDirs].flatMap((root) => [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]),
      ...(identities?.settings === undefined ? [] : [identities.settings.path]),
      path.join(managed.dir, 'managed-settings.json'),
    ];
    let dropins: string[] = [];
    try { dropins = readdirSync(path.join(managed.dir, 'managed-settings.d')); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') return null;
    }
    if (dropins.length > PLUGIN_BOUNDS.dropins) return null;
    return [...files, ...dropins.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(managed.dir, 'managed-settings.d', n))];
  };

  const check = (): SourceVerdict => {
    // 1. Installed plugins relevant to this launch.
    const installedFile = read(path.join(configRoot, 'plugins', 'installed_plugins.json'));
    if (installedFile === 'unreadable') return uninspected();
    const installed = new Map<string, string>();
    if (installedFile !== 'absent') {
      const plugins = installedFile['plugins'];
      if (!isPlain(plugins)) return uninspected();
      const ids = Object.keys(plugins);
      if (ids.length > PLUGIN_BOUNDS.ids) return uninspected();
      for (const id of ids) {
        const raw = plugins[id];
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          if (!isPlain(entry) || typeof entry['installPath'] !== 'string' || !path.isAbsolute(entry['installPath'])) return uninspected();
          const scope = entry['scope'];
          if (scope === 'managed' || scope === 'user') installed.set(id, entry['installPath']);
          else if (scope === 'project' || scope === 'local') {
            if (typeof entry['projectPath'] !== 'string') return uninspected();
            if (projectDirs.has(entry['projectPath'])) installed.set(id, entry['installPath']);
          } else return uninspected();
        }
      }
    }

    // 2. The explicit enabledPlugins values; the fallback precedence: true anywhere wins, else false anywhere.
    const files = settingsFiles();
    if (files === null) return uninspected();
    const explicit = new Map<string, boolean>();
    for (const file of files) {
      const settings = read(file);
      if (settings === 'absent') continue;
      if (settings === 'unreadable') return uninspected();
      const enabled = settings['enabledPlugins'];
      if (enabled === undefined) continue;
      if (!isPlain(enabled)) return uninspected();
      for (const [id, value] of Object.entries(enabled)) {
        if (typeof value !== 'boolean') return uninspected();
        explicit.set(id, explicit.get(id) === true || value);
      }
    }
    if (explicit.size > PLUGIN_BOUNDS.ids) return uninspected();
    for (const [id, on] of explicit) if (on && !installed.has(id)) return uninspected();

    // 3. Active set: explicit true, or no explicit value and defaultEnabled (absent → true); then dependencies to a fixed point.
    const manifests = new Map<string, { readonly root: string; readonly files: readonly Json[] }>();
    const manifestOf = (id: string): { readonly root: string; readonly files: readonly Json[] } | null => {
      const known = manifests.get(id);
      if (known !== undefined) return known;
      let root: string;
      try { root = realpathSync(installed.get(id)!); } catch { return null; }
      const files: Json[] = [];
      for (const rel of [path.join('.claude-plugin', 'plugin.json'), 'plugin.json']) {
        const real = inside(root, rel);
        if (real === null) return null;
        if (real === 'absent') continue;
        const m = read(real);
        if (m === 'unreadable') return null;
        if (m !== 'absent') files.push(m);
      }
      const value = Object.freeze({ root, files: Object.freeze(files) });
      manifests.set(id, value);
      return value;
    };
    const active = new Set<string>();
    for (const id of installed.keys()) {
      const on = explicit.get(id);
      if (on === true) { active.add(id); continue; }
      if (on === false) continue;
      const m = manifestOf(id);
      if (m === null) return uninspected();
      if (m.files.every((f) => f['defaultEnabled'] !== false)) active.add(id);
    }
    let rounds = 0;
    for (let grew = true; grew;) {
      grew = false;
      if (++rounds > PLUGIN_BOUNDS.dependencyRounds) return uninspected();
      for (const id of [...active]) {
        const m = manifestOf(id);
        if (m === null) return uninspected();
        for (const f of m.files) {
          const deps = f['dependencies'];
          if (deps === undefined) continue;
          if (!Array.isArray(deps)) return uninspected();
          for (const dep of deps) {
            const depId = dependencyId(dep, id);
            if (depId === undefined) return uninspected();
            const match = installed.has(depId) ? depId : [...installed.keys()].find((k) => k === depId || k.startsWith(`${depId}@`));
            if (match === undefined) return uninspected();
            if (!active.has(match)) { active.add(match); grew = true; }
          }
        }
      }
    }

    // 4. Each active plugin's declarative hooks and settings. Hook modules (non-JSON paths, hooks/register.ts) are the accepted residual.
    let first: SourceVerdict = CLEAR;
    const take = (v: SourceVerdict): boolean => {
      if (v.kind === 'trigger') { first = v; return true; }
      if (v.kind === 'uninspected' && first.kind === 'clear') first = v;
      return false;
    };
    for (const id of active) {
      const m = manifestOf(id);
      if (m === null) return uninspected();
      const hookFiles: string[] = [];
      const fixed = inside(m.root, path.join('hooks', 'hooks.json'));
      if (fixed === null) return uninspected();
      if (fixed !== 'absent') hookFiles.push(fixed);
      for (const f of m.files) {
        const declared = f['hooks'];
        if (declared === undefined) continue;
        const entries = Array.isArray(declared) ? declared : [declared];
        for (const entry of entries) {
          if (isPlain(entry)) { if (take(hooksVerdict(hookMap(entry)))) return first; continue; }
          if (typeof entry !== 'string') return uninspected();
          if (!entry.endsWith('.json')) continue;
          const real = inside(m.root, entry);
          if (real === null || real === 'absent') return uninspected();
          hookFiles.push(real);
        }
        const settings = f['settings'];
        if (settings !== undefined) {
          if (!isPlain(settings)) return uninspected();
          if (take(settingsTextVerdict(JSON.stringify(settings), false))) return first;
        }
      }
      if (hookFiles.length > PLUGIN_BOUNDS.hookFilesPerPlugin) return uninspected();
      for (const file of new Set(hookFiles)) {
        const h = read(file);
        if (h === 'absent') continue;
        if (h === 'unreadable') return uninspected();
        if (take(hooksVerdict(hookMap(h)))) return first;
      }
    }
    return first;
  };
  return Object.freeze({ name: 'plugins', check });
}
