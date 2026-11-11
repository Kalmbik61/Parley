// T12a-Claude C2a: the launcher's half of the Claude row — argv, env, a second `parley` server, the identities, and the scan (lead
// m-7557/m-7560/m-7563, s-296 m-7559/m-7561). Temp trees only; never the machine's own config.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS, type ProviderEntry } from '../../providers.js';
import {
  CLAUDE_ENV_ALLOWED, claudeArgvVerdict, claudeConfigRoots, claudeEnvVerdict, claudeLaunchScan, gitRootOf, parleyServerElsewhere,
} from './claude-launch-sources.js';

const claude = (): ProviderEntry => structuredClone(PROVIDERS.claude) as ProviderEntry;

describe('env (s-296 E1, lead m-7563): a CLAUDE_* or ANTHROPIC_* name outside the closed list is uninspected', () => {
  it('the list, and a clean env, are clear', () => {
    expect([...CLAUDE_ENV_ALLOWED].sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CONFIG_DIR']);
    expect(claudeEnvVerdict({ PATH: '/usr/bin', HOME: '/h' })).toEqual({ kind: 'clear' });
    expect(claudeEnvVerdict({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })).toEqual({ kind: 'clear' });
  });
  it.each([
    'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CODE_HOST_OWNED_CONFIG_DIR', 'CLAUDE_TEST_USER_SETTINGS',
    'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_REMOTE_MCP_CONFIG', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_ENTRYPOINT',
    // C2c relies on the launch env check for every non-file plugin path (s-296 P-1).
    'CLAUDE_CODE_PLUGIN_SEED_DIR',
    'ANTHROPIC_AUTH_TOKEN', 'claude_code_lowercase', 'Anthropic_Model',
  ])('%s is uninspected:env', (name) => {
    expect(claudeEnvVerdict({ PATH: '/usr/bin', [name]: 'x' })).toEqual({ kind: 'uninspected', sourceClass: 'env' });
  });
});

describe('argv (s-296 Q-D): the built-in claude runner exactly, for new and for resume', () => {
  it('the shipped runner is clear', () => {
    expect(claudeArgvVerdict(claude())).toEqual({ kind: 'clear' });
  });
  it.each([
    ['an extra flag in the new template', (e: ProviderEntry) => { e.runner.args = [...e.runner.args!, '--setting-sources', 'user']; }],
    ['a changed resume template', (e: ProviderEntry) => { e.runner.resumeArgs = [...e.runner.resumeArgs!, '--project-config-root', '/x']; }],
    ['a reordered template', (e: ProviderEntry) => { e.runner.args = [...e.runner.args!].reverse(); }],
    ['another command', (e: ProviderEntry) => { e.runner.command = 'claude-wrapper'; }],
    ['a runner env', (e: ProviderEntry) => { e.runner.env = { CLAUDE_X: '1' }; }],
    ['a config dir', (e: ProviderEntry) => { e.runner.configDir = '/x'; }],
  ])('%s: uninspected:argv', (_name, change) => {
    const e = claude();
    change(e);
    expect(claudeArgvVerdict(e)).toEqual({ kind: 'uninspected', sourceClass: 'argv' });
  });
  it('another provider id (GLM runs claude too) is never the claude runner', () => {
    expect(claudeArgvVerdict({ ...claude(), id: 'glm' } as ProviderEntry)).toEqual({ kind: 'uninspected', sourceClass: 'argv' });
  });
});

describe('the roots the launcher records', () => {
  let root = '';
  beforeEach(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-launch-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('the config root and .claude.json: CLAUDE_CONFIG_DIR (resolved against cwd), else HOME', () => {
    expect(claudeConfigRoots('/w', { HOME: '/h' })).toEqual({ configRoot: '/h/.claude', globalConfig: '/h/.claude.json' });
    expect(claudeConfigRoots('/w', { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })).toEqual({ configRoot: '/c', globalConfig: '/c/.claude.json' });
    expect(claudeConfigRoots('/w', { HOME: '/h', CLAUDE_CONFIG_DIR: 'rel' })).toEqual({ configRoot: '/w/rel', globalConfig: '/w/rel/.claude.json' });
    expect(claudeConfigRoots('/w', { HOME: '/h', CLAUDE_CONFIG_DIR: '' })).toEqual({ configRoot: '/h/.claude', globalConfig: '/h/.claude.json' });
  });
  it('the git root: canonical, from a subdirectory; none outside a repository', async () => {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    expect(await gitRootOf(path.join(repo, 'sub'), process.env)).toBe(realpathSync(repo));
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    expect(await gitRootOf(plain, process.env)).toBeUndefined();
  });
  it('git that cannot answer (missing from PATH) is null, never "not a repository" (s-296 G2)', async () => {
    expect(await gitRootOf(root, { PATH: path.join(root, 'no-bin'), HOME: root })).toBeNull();
  });
});

describe('B2: another server named parley (lead m-7557, s-296 m-7561)', () => {
  let root = '';
  let global = '';
  let cwd = '';
  let git = '';
  const write = (file: string, data: unknown): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-b2-')));
    global = path.join(root, 'home', '.claude.json');
    git = path.join(root, 'repo');
    cwd = path.join(git, 'sub');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('none anywhere, or other names only: clear', async () => {
    expect(await parleyServerElsewhere(global, [cwd, git])).toEqual({ kind: 'clear' });
    write(global, { mcpServers: { github: {} }, projects: { [cwd]: { mcpServers: { parleyx: {} } } } });
    write(path.join(cwd, '.mcp.json'), { mcpServers: { db: {} } });
    expect(await parleyServerElsewhere(global, [cwd, git])).toEqual({ kind: 'clear' });
  });
  it.each([
    ['user scope', () => write(global, { mcpServers: { parley: {} } })],
    ['user scope, another case', () => write(global, { mcpServers: { Parley: {} } })],
    ['this cwd\'s project entry', () => write(global, { projects: { [cwd]: { mcpServers: { parley: {} } } } })],
    ['the git root\'s project entry', () => write(global, { projects: { [git]: { mcpServers: { PARLEY: {} } } } })],
    ['.mcp.json at cwd', () => write(path.join(cwd, '.mcp.json'), { mcpServers: { parley: {} } })],
    ['.mcp.json at the git root', () => write(path.join(git, '.mcp.json'), { mcpServers: { parley: {} } })],
  ])('%s: trigger', async (_name, plant) => {
    plant();
    expect(await parleyServerElsewhere(global, [cwd, git])).toEqual({ kind: 'trigger' });
  });
  it('another project\'s entry is not this launch\'s', async () => {
    write(global, { projects: { '/elsewhere': { mcpServers: { parley: {} } } } });
    expect(await parleyServerElsewhere(global, [cwd, git])).toEqual({ kind: 'clear' });
  });
  it('a FIFO, an oversized file or a link at .mcp.json: uninspected, and the FIFO does not stall the launch (lead m-7588, s-296 O1)', async () => {
    execFileSync('/usr/bin/mkfifo', [path.join(cwd, '.mcp.json')]);
    const started = Date.now();
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'mcp-json' });
    expect(Date.now() - started).toBeLessThan(2_000);
    rmSync(path.join(cwd, '.mcp.json'));
    // Valid JSON over the 1 MiB bound: refused for its size, not for its parse.
    write(path.join(cwd, '.mcp.json'), { mcpServers: {}, pad: 'x'.repeat(1024 * 1024) });
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'mcp-json' });
    rmSync(path.join(cwd, '.mcp.json'));
    write(path.join(root, 'real.json'), { mcpServers: {} });
    symlinkSync(path.join(root, 'real.json'), path.join(cwd, '.mcp.json'));
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'mcp-json' });
  });
  it('a FIFO at the global config: uninspected, without a stall', async () => {
    mkdirSync(path.dirname(global), { recursive: true });
    execFileSync('/usr/bin/mkfifo', [global]);
    const started = Date.now();
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'claude-json' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('an unparsable .claude.json or .mcp.json: uninspected', async () => {
    write(global, '{');
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'claude-json' });
    write(global, {});
    write(path.join(cwd, '.mcp.json'), '[');
    expect(await parleyServerElsewhere(global, [cwd])).toEqual({ kind: 'uninspected', sourceClass: 'mcp-json' });
  });
});

describe('the launch scan', () => {
  let root = '';
  let home = '';
  let cwd = '';
  const managed = (): { dir: string; presenceOnly: string[] } => ({ dir: path.join(root, 'managed'), presenceOnly: [] });
  const env = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-scan-')));
    home = path.join(root, 'home');
    cwd = path.join(root, 'project');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clean: clear, and it records cwd, the config root and the --settings identity (no git root outside a repository)', async () => {
    const settings = { path: path.join(root, 'work', 's-1.json'), sha256: 'b'.repeat(64) };
    expect(await claudeLaunchScan({ entry: claude(), cwd, env: env(), settings, managed: managed() })).toEqual({
      verdict: { kind: 'clear' }, identities: { cwd, configRoot: path.join(home, '.claude'), settings },
    });
  });
  it('a deny in the user settings is a trigger; an env name outside the list is uninspected before anything is read', async () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp__parley'] } }));
    expect((await claudeLaunchScan({ entry: claude(), cwd, env: env(), managed: managed() })).verdict).toEqual({ kind: 'trigger' });
    expect((await claudeLaunchScan({ entry: claude(), cwd, env: { ...env(), CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/x' }, managed: managed() })).verdict)
      .toEqual({ kind: 'uninspected', sourceClass: 'env' });
  });
  it('an overridden template is uninspected:argv; a second parley server is a trigger', async () => {
    const e = claude();
    e.runner.args = [...e.runner.args!, '--x'];
    expect((await claudeLaunchScan({ entry: e, cwd, env: env(), managed: managed() })).verdict).toEqual({ kind: 'uninspected', sourceClass: 'argv' });
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { parley: {} } }));
    expect((await claudeLaunchScan({ entry: claude(), cwd, env: env(), managed: managed() })).verdict).toEqual({ kind: 'trigger' });
  });
  it('git missing from the PTY env\'s PATH: uninspected:git-root (s-296 G2)', async () => {
    expect((await claudeLaunchScan({ entry: claude(), cwd, env: { PATH: path.join(root, 'no-bin'), HOME: home }, managed: managed() })).verdict)
      .toEqual({ kind: 'uninspected', sourceClass: 'git-root' });
  });
  it('in a repository, the git root is recorded and its local settings are read', async () => {
    execFileSync('git', ['init', '-q', root]);
    const scan = await claudeLaunchScan({ entry: claude(), cwd, env: env(), managed: managed() });
    expect(scan.identities.gitRoot).toBe(root);
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['mcp__parley__get_map'] } }));
    expect((await claudeLaunchScan({ entry: claude(), cwd, env: env(), managed: managed() })).verdict).toEqual({ kind: 'trigger' });
  });
});

describe('the frame exception holds (lead m-7578): the two C2a source files make no filesystem write', () => {
  // The frame exception for the global config file covers a read. These two files may read, stat, list and run git; never write, rename,
  // remove, link, chmod or open for writing.
  const WRITES = /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|utimes|utimesSync|createWriteStream|writeSync|write)\s*\(|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;
  // An open is allowed only read-only: its line names O_RDONLY (and, by the pattern above, no write flag).
  const OPEN = /\bopen(Sync)?\s*\(/;
  it.each(['claude-launch-sources.ts', 'claude-settings.ts', 'claude-plugins.ts'])('%s', (name) => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name), 'utf8');
    const hits = source.split('\n').map((line, i) => [i + 1, line] as const).filter(([, line]) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && (WRITES.test(line) || (OPEN.test(line) && !line.includes('O_RDONLY'))));
    expect(hits).toEqual([]);
  });
});
