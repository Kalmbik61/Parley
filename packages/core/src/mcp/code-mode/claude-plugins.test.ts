// T12a-Claude C2c: the active plugins of a Claude session (lead m-7689/m-7698, s-296 m-7688). A temp config root, temp plugins and a temp
// managed layer; never the machine's own.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_BOUNDS, claudePluginsClass } from './claude-plugins.js';
import { providerSourceClasses } from './provider-rows.js';

let root = '';
let configRoot = '';
let cwd = '';
const managed = (): { dir: string; presenceOnly: string[] } => ({ dir: path.join(root, 'managed'), presenceOnly: [] });
const write = (file: string, data: unknown): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
const TARGETED = { hooks: { PreToolUse: [{ matcher: 'mcp__parley__get_map', hooks: [{ type: 'command', command: 'never-read' }] }] } };
const GENERAL = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } };

/** Installs a plugin under the temp root and lists it in installed_plugins.json. */
function plugin(id: string, opts: { manifest?: unknown; hooksJson?: unknown; scope?: string; projectPath?: string; extra?: (dir: string) => void } = {}): string {
  const dir = path.join(root, 'cache', id.replace('@', '-at-'));
  mkdirSync(dir, { recursive: true });
  if (opts.manifest !== undefined) write(path.join(dir, '.claude-plugin', 'plugin.json'), opts.manifest);
  if (opts.hooksJson !== undefined) write(path.join(dir, 'hooks', 'hooks.json'), opts.hooksJson);
  opts.extra?.(dir);
  const file = path.join(configRoot, 'plugins', 'installed_plugins.json');
  let data: { version: number; plugins: Record<string, unknown[]> } = { version: 2, plugins: {} };
  try { data = JSON.parse(readFileSync(file, 'utf8')) as typeof data; } catch { /* first */ }
  data.plugins[id] = [{ scope: opts.scope ?? 'user', installPath: dir, version: '1', ...(opts.projectPath === undefined ? {} : { projectPath: opts.projectPath }) }];
  write(file, data);
  return dir;
}
const enable = (map: Record<string, boolean>, file = path.join(configRoot, 'settings.json')): void => write(file, { enabledPlugins: map });
const cls = (over: Record<string, unknown> = {}) => claudePluginsClass({ configRoot, cwd, ...over }, { managed: managed() });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-plugins-')));
  configRoot = path.join(root, 'config');
  cwd = path.join(root, 'project');
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the installed set and activation', () => {
  it('no recorded roots: uninspected; nothing installed: clear', () => {
    expect(claudePluginsClass({ cwd }, { managed: managed() }).check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    expect(cls().check()).toEqual({ kind: 'clear' });
  });
  it('the plan\'s fixture pair: an enabled plugin with a targeted hook is a trigger; its disabled cached twin is clear', () => {
    plugin('a@m', { hooksJson: TARGETED });
    enable({ 'a@m': true });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    enable({ 'a@m': false });
    expect(cls().check()).toEqual({ kind: 'clear' });
  });
  it('a disabled plugin is never read: its unreadable hook file does not matter', () => {
    plugin('a@m', { hooksJson: '{ not json' });
    enable({ 'a@m': false });
    expect(cls().check()).toEqual({ kind: 'clear' });
  });
  it('defaultEnabled: absent means active, false means inactive, an explicit true wins over it', () => {
    plugin('a@m', { hooksJson: TARGETED });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { manifest: { name: 'a', defaultEnabled: false }, hooksJson: TARGETED });
    expect(cls().check()).toEqual({ kind: 'clear' });
    enable({ 'a@m': true });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
  });
  it('the precedence fallback (lead m-7689 Q1): true in any source wins over false in another (here Parley\'s own lean --settings)', () => {
    plugin('a@m', { hooksJson: TARGETED });
    enable({ 'a@m': true });
    const flag = path.join(root, 'work', 'settings', 's-1.json');
    enable({ 'a@m': false }, flag);
    expect(cls({ settings: { path: flag, sha256: 'a'.repeat(64) } }).check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
  });
  it('enabledPlugins from project, local, the git root and managed settings count too', () => {
    plugin('a@m', { manifest: { defaultEnabled: false }, hooksJson: TARGETED });
    const git = path.join(root, 'repo');
    for (const file of [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'), path.join(git, '.claude', 'settings.local.json'),
      path.join(root, 'managed', 'managed-settings.json'), path.join(root, 'managed', 'managed-settings.d', '10.json')]) {
      enable({ 'a@m': true }, file);
      expect(cls({ gitRoot: git }).check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
      rmSync(file);
      expect(cls({ gitRoot: git }).check()).toEqual({ kind: 'clear' });
    }
  });
  it('dependencies: a plugin required by an active one is active regardless; bare names resolve in the dependent\'s marketplace; object form', () => {
    for (const dep of ['b', 'b@m', { name: 'b' }, { name: 'b', marketplace: 'm' }, 'b@^1.2']) {
      plugin('a@m', { manifest: { dependencies: [dep] } });
      plugin('b@m', { hooksJson: TARGETED });
      enable({ 'a@m': true, 'b@m': false });
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    }
  });
  it('a dependency that is not installed, or of a shape the client rejects: uninspected', () => {
    plugin('a@m', { manifest: { dependencies: ['missing'] } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    plugin('a@m', { manifest: { dependencies: [42] } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('an id enabled but not installed: uninspected (the client may fetch it)', () => {
    enable({ 'ghost@m': true });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('scopes: user and managed always; project and local only for this cwd or git root; unknown scope or no projectPath: uninspected', () => {
    plugin('a@m', { hooksJson: TARGETED, scope: 'project', projectPath: path.join(root, 'elsewhere') });
    expect(cls().check()).toEqual({ kind: 'clear' });
    plugin('a@m', { hooksJson: TARGETED, scope: 'local', projectPath: cwd });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { hooksJson: TARGETED, scope: 'managed' });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { hooksJson: TARGETED, scope: 'team' });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    plugin('a@m', { hooksJson: TARGETED, scope: 'project' });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('an unreadable installed_plugins.json, or a FIFO there: uninspected, without a stall', () => {
    write(path.join(configRoot, 'plugins', 'installed_plugins.json'), '{');
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    rmSync(path.join(configRoot, 'plugins', 'installed_plugins.json'));
    execFileSync('/usr/bin/mkfifo', [path.join(configRoot, 'plugins', 'installed_plugins.json')]);
    const started = Date.now();
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('an active plugin\'s declarative hooks and settings', () => {
  it('hooks/hooks.json, a manifest hooks path, a manifest inline object: each classified by hooksVerdict', () => {
    plugin('a@m', { hooksJson: GENERAL });
    expect(cls().check()).toEqual({ kind: 'clear' });
    plugin('a@m', { manifest: { hooks: './extra/h.json' }, extra: (d) => write(path.join(d, 'extra', 'h.json'), TARGETED) });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { manifest: { hooks: [TARGETED] } });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { manifest: { hooks: TARGETED.hooks } });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    plugin('a@m', { hooksJson: { hooks: { PreToolUse: [{ matcher: 'Edit.*', hooks: [] }] } } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'hooks-regex-matcher' });
  });
  it('JavaScript hooks modules are the accepted residual (m-7698): not read, not uninspected', () => {
    plugin('a@m', { manifest: { hooks: './hooks/register.ts' }, extra: (d) => write(path.join(d, 'hooks', 'register.ts'), 'mcp__parley__get_map') });
    expect(cls().check()).toEqual({ kind: 'clear' });
    plugin('a@m', { extra: (d) => { write(path.join(d, 'mods', 'x.ts'), 'x'); write(path.join(d, 'hooks', 'register.ts'), 'x'); } });
    expect(cls().check()).toEqual({ kind: 'clear' });
  });
  it('an unreadable hook file or manifest of an active plugin: uninspected; a hook path or a link leaving the plugin root: uninspected', () => {
    plugin('a@m', { hooksJson: '{' });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    plugin('a@m', { manifest: '{' });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    write(path.join(root, 'outside.json'), TARGETED);
    plugin('a@m', { manifest: { hooks: '../../outside.json' } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    plugin('a@m', { extra: (d) => { mkdirSync(path.join(d, 'hooks'), { recursive: true }); symlinkSync(path.join(root, 'outside.json'), path.join(d, 'hooks', 'hooks.json')); } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    plugin('a@m', { manifest: { hooks: './missing.json' } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('a FIFO as an active plugin\'s hook file: uninspected, without a stall', () => {
    plugin('a@m', { extra: (d) => { mkdirSync(path.join(d, 'hooks'), { recursive: true }); execFileSync('/usr/bin/mkfifo', [path.join(d, 'hooks', 'hooks.json')]); } });
    const started = Date.now();
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('a manifest\'s settings are judged like a settings file (Q5): a deny on Parley, a relocating env', () => {
    plugin('a@m', { manifest: { settings: { permissions: { deny: ['mcp__parley__*'] } } } });
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    plugin('a@m', { manifest: { settings: { env: { CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/x' } } } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
    plugin('a@m', { manifest: { settings: 'x' } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
});

describe('bounds (s-296 P-2)', () => {
  it('more installed ids than the bound: uninspected', () => {
    const file = path.join(configRoot, 'plugins', 'installed_plugins.json');
    const plugins: Record<string, unknown[]> = {};
    for (let i = 0; i <= PLUGIN_BOUNDS.ids; i++) plugins[`p${i}@m`] = [{ scope: 'user', installPath: path.join(root, 'none') }];
    write(file, { version: 2, plugins });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('more hook files in one plugin than the bound: uninspected', () => {
    const hooks = Array.from({ length: PLUGIN_BOUNDS.hookFilesPerPlugin + 1 }, (_, i) => `./h${i}.json`);
    plugin('a@m', { manifest: { hooks }, extra: (d) => { for (const h of hooks) write(path.join(d, h), GENERAL); } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
  });
  it('a dependency chain that needs more rounds than the bound: uninspected; one round less: read', () => {
    const chain = (n: number): void => {
      for (let i = 0; i < n; i++) plugin(`p${i}@m`, { manifest: { defaultEnabled: i === 0, dependencies: i + 1 < n ? [`p${i + 1}`] : [] } });
    };
    chain(PLUGIN_BOUNDS.dependencyRounds);
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'plugins' });
    rmSync(path.join(configRoot, 'plugins'), { recursive: true });
    chain(PLUGIN_BOUNDS.dependencyRounds - 1);
    expect(cls().check()).toEqual({ kind: 'clear' });
  });
});

describe('the row', () => {
  it('the Claude row now carries the plugins class', () => {
    expect(providerSourceClasses('claude', { cwd })!.map((c) => c.name)).toEqual(['client', 'settings', 'plugins', 'nested-sources']);
  });
});
