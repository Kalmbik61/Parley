// T12a-Claude C2a: the Claude settings sources in the session process (lead m-7557/m-7560, s-296 m-7559/m-7561). Real files in a temp tree,
// a temp managed layer; never the machine's own settings.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS, DROPIN_MAX_ENTRIES, type ManagedLayer, claudeSettingsClass, hooksVerdict, ruleClass, serverMatcherClass, settingsTextVerdict, toolMatcherClass } from './claude-settings.js';
import { workSettingsJson } from '../../work/settings-file.js';
import { SETTINGS_MAX_BYTES } from './detector.js';

describe('what a deny or ask rule says about Parley: the closed grammar (no RegExp; C2a.1, lead m-7610 on finding F1)', () => {
  it.each([
    'mcp__parley', 'mcp__parley__*', 'mcp__parley__get_map', 'mcp__parley__get_map(anything)', 'MCP__Parley__x', 'mcp__PARLEY', ' mcp__parley ',
    // The tool part is cut at the first `(`: the content never changes the class.
    'mcp__parley(anything)',
  ])('%j names Parley exactly: parley (a trigger)', (rule) => { expect(ruleClass(rule)).toBe('parley'); });
  it.each([
    // Globs that are not provably disjoint: prefix, suffix and infix forms (s-296 m-7609).
    '*', '*parley*', '*__get_map', '*get_map', 'mc*', 'mcp*', 'MCP*', 'm*p', '*(x)',
    // Any other mcp__ rule: the client also applies rules through a server's runtime keys (Parley's former HARNAS name among them).
    'mcp__*', 'mcp__*__get_map', 'mcp__', 'mcp__a__b__c', 'mcp__par ley', 'mcp__.*', 'mcp__par*', 'mcp__github', 'mcp__github__create_issue',
    'mcp__parley-x__get_map', 'mcp__parleyx', 'mcp__harnas__get_map', 'MCP__Other__x',
  ])('%j may or may not reach Parley: unresolved (uninspected)', (rule) => { expect(ruleClass(rule)).toBe('unresolved'); });
  it.each([
    'Bash', 'Bash(rm:*)', 'Read(./.env)', 'Read(**/*.env)', 'WebFetch', 'Edit',
    // A glob whose literal prefix cannot begin an mcp__ name: 2.1.322's glob is anchored at the start.
    'Bash*', 'Web*', 'Notebook*Edit', 'x*',
  ])('%j cannot reach a Parley tool: disjoint', (rule) => { expect(ruleClass(rule)).toBe('disjoint'); });
});

describe('hook matchers (C2b; lead m-7673/m-7675, s-296 m-7674 H1)', () => {
  it('the 33 events of 2.1.322', () => { expect(CLAUDE_HOOK_EVENTS.size).toBe(33); });
  it.each(['', '*'])('tool matcher %j: general', (m) => { expect(toolMatcherClass(m)).toBe('general'); });
  it.each([
    // .* and ^.*$: the lead's doubtful disposition (the client itself treats .* as match-all).
    '.*', '^.*$',
    // Simple matchers naming Parley, compared exactly by the client (Npt).
    'mcp__parley__get_map', 'mcp__parley', 'Bash|mcp__parley__get_map', 'Bash, mcp__parley__code_execute', 'MCP__PARLEY__x',
    // Anchored regex on Parley.
    '^mcp__parley__.*', '^mcp__parley__get_map$', '^mcp__parley',
  ])('tool matcher %j: targets Parley', (m) => { expect(toolMatcherClass(m)).toBe('parley'); });
  it.each(['mcp__github__create_issue', 'mcp__github', 'Bash|mcp__other__x', 'mcp__harnas__get_map'])(
    'tool matcher %j: another server, maybe one of Parley\'s runtime keys: unresolved (mcp)', (m) => { expect(toolMatcherClass(m)).toBe('mcp'); });
  it.each([
    // Unanchored regex alternatives are tested against alias and family names a file reader cannot list (H1).
    'Edit.*', 'get.*', 'harnas.*', '.*harnas', 'mcp__.*', 'mcp__.*__get_map', '.*parley.*', 'Bash|Edit.*', '^Edit|Write.*',
    // An unanchored regex naming Parley: still unresolved, never clear (classic either way).
    'mcp__parley__*', 'mcp__parley__.*',
    // Anchored, but the literal can start or prefix an mcp__ name.
    '^mc.*', '^mcp__.*', '^mcp__github__.*', '^MCP',
    // Outside the grammar: never run, doubtful.
    '(a+)+$', '^(Edit|Write)$', 'Edit[0-9]', '\\w+',
  ])('tool matcher %j: unresolved (regex)', (m) => { expect(toolMatcherClass(m)).toBe('regex'); });
  it.each([
    // Simple matchers are compared exactly with the tool name and its aliases, which all start with mcp__ (H1).
    'Bash', 'Edit|Write', 'Edit, Write', 'harnas', 'get_map', 'Notebook Edit', '|',
    // Anchored regex whose literal cannot begin an mcp__ name.
    '^Edit', '^Notebook.*', '^Bash$', '^Edit|^Write',
  ])('tool matcher %j: disjoint', (m) => { expect(toolMatcherClass(m)).toBe('disjoint'); });
  it('a stalling-shaped regex is classified without running it', () => {
    const started = Date.now();
    expect(toolMatcherClass('(a+)+$' + 'a'.repeat(5000))).toBe('regex');
    expect(Date.now() - started).toBeLessThan(500);
  });
  it.each([['parley', 'parley'], ['Parley', 'parley'], ['github|parley', 'parley'], ['github', 'mcp'], ['harnas', 'mcp'], ['^git.*', 'regex'], ['', 'general'], ['.*', 'parley']] as const)(
    'Elicitation matcher %j: %s', (m, cls) => { expect(serverMatcherClass(m)).toBe(cls); });

  const hook = (event: string, matcher?: string, handler: Record<string, unknown> = { type: 'command', command: 'never-read' }): unknown =>
    ({ [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [handler] }] });
  it('per event: tool events and Elicitation classified; PostToolBatch and unknown events only with a matcher; other events never', () => {
    expect(hooksVerdict(hook('PreToolUse', 'mcp__parley__get_map'))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    for (const e of ['PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']) {
      expect(hooksVerdict(hook(e, 'mcp__parley__get_map'))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    }
    expect(hooksVerdict(hook('PreToolUse', 'Edit.*'))).toEqual({ kind: 'uninspected', sourceClass: 'hooks-regex-matcher' });
    expect(hooksVerdict(hook('PreToolUse', 'mcp__github__x'))).toEqual({ kind: 'uninspected', sourceClass: 'hooks-mcp-matcher' });
    expect(hooksVerdict(hook('PreToolUse', 'Bash'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('PreToolUse'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('Elicitation', 'parley'))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    expect(hooksVerdict(hook('ElicitationResult', 'github'))).toEqual({ kind: 'uninspected', sourceClass: 'hooks-mcp-matcher' });
    expect(hooksVerdict(hook('PostToolBatch'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('PostToolBatch', 'Bash'))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    expect(hooksVerdict(hook('BrandNewEvent'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('BrandNewEvent', 'Bash'))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    // Valid non-tool matchers are not about tools (plan): no trigger.
    expect(hooksVerdict(hook('PreModelSwitch', '.*opus.*'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('SubagentStart', '^my-plugin:reviewer$'))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('SessionStart', 'mcp__parley'))).toEqual({ kind: 'clear' });
  });
  it('a handler `if` is a permission rule (ruleClass); the command is never read', () => {
    expect(hooksVerdict(hook('PreToolUse', '', { type: 'command', command: 'x', if: 'mcp__parley__get_map' }))).toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    expect(hooksVerdict(hook('PreToolUse', '', { type: 'command', command: 'x', if: '*' }))).toEqual({ kind: 'uninspected', sourceClass: 'hooks-if' });
    expect(hooksVerdict(hook('PreToolUse', '', { type: 'command', command: 'x', if: 'Bash(git *)' }))).toEqual({ kind: 'clear' });
    expect(hooksVerdict(hook('PreToolUse', '', { type: 'command', command: 'mcp__parley__get_map', if: 'Bash' }))).toEqual({ kind: 'clear' });
  });
  it('malformed shapes are a trigger', () => {
    for (const bad of ['x', [], { PreToolUse: {} }, { PreToolUse: ['x'] }, { PreToolUse: [{ hooks: 'x' }] }, { PreToolUse: [{ matcher: 3, hooks: [] }] },
      { PreToolUse: [{ hooks: ['x'] }] }, { PreToolUse: [{ hooks: [{ if: 3 }] }] }]) {
      expect(hooksVerdict(bad)).toEqual({ kind: 'trigger', reason: 'hooks-unparsable' });
    }
  });
  it('in a settings file: a hook trigger wins over an unresolved rule; an unresolved hook is reported', () => {
    expect(settingsTextVerdict(JSON.stringify({ permissions: { deny: ['mcp__github'] }, hooks: hook('PreToolUse', 'mcp__parley') }), false))
      .toEqual({ kind: 'trigger', reason: 'hooks-targeted' });
    expect(settingsTextVerdict(JSON.stringify({ hooks: hook('PreToolUse', 'Edit.*') }), true)).toEqual({ kind: 'uninspected', sourceClass: 'hooks-regex-matcher' });
    expect(settingsTextVerdict(JSON.stringify({ hooks: hook('PreToolUse', 'Bash'), disableAllHooks: false, allowManagedHooksOnly: true }), true)).toEqual({ kind: 'clear' });
  });
  it('Parley\'s own --settings files classify clear: none of its hooks has a matcher (Q4: no identity exclusion)', () => {
    const variants = [{}, { hookUrl: 'http://127.0.0.1:1/hooks' }, { hookUrl: 'http://127.0.0.1:1/hooks', provider: 'glm' as const }, { autonomous: true, sessionId: 's-1' },
      { allowBrowser: true, disablePlugins: ['x@y'] }, { hookUrl: 'http://127.0.0.1:1/hooks', hookEvents: [...CLAUDE_HOOK_EVENTS] }];
    for (const options of variants) expect(settingsTextVerdict(workSettingsJson(options), false)).toEqual({ kind: 'clear' });
  });
});

describe('one settings file\'s text', () => {
  const t = (o: unknown, managed = false): unknown => settingsTextVerdict(JSON.stringify(o), managed);
  it('unparsable, or not an object, or a permissions/deny/ask of the wrong shape: trigger', () => {
    expect(settingsTextVerdict('{', false)).toEqual({ kind: 'trigger', reason: 'settings-unparsable' });
    for (const bad of [[], 'x', { permissions: [] }, { permissions: 'x' }, { permissions: { deny: 'mcp__github' } }, { permissions: { ask: {} } }, { permissions: { deny: [42] } }, { permissions: { ask: ['Bash', null] } }]) {
      expect(t(bad)).toEqual({ kind: 'trigger', reason: 'settings-unparsable' });
    }
  });
  it('a targeted deny or ask is a trigger, a disjoint one and allow are clear', () => {
    expect(t({ permissions: { deny: ['Bash', 'mcp__parley__*'] } })).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    expect(t({ permissions: { ask: ['mcp__parley__get_map'] } })).toEqual({ kind: 'trigger', reason: 'settings-ask' });
    expect(t({ permissions: { deny: ['Bash(rm:*)', 'Read(./.env)'], ask: ['WebFetch'], allow: ['mcp__parley__*', 'mcp__github'], defaultMode: 'plan' } })).toEqual({ kind: 'clear' });
    // Another MCP server's tool or an unresolvable glob (C2a.1): uninspected, the named cost; a Parley rule in the same file still wins.
    expect(t({ permissions: { deny: ['mcp__github__create_issue'] } })).toEqual({ kind: 'uninspected', sourceClass: 'settings-mcp-rule' });
    expect(t({ permissions: { ask: ['*__get_map'] } })).toEqual({ kind: 'uninspected', sourceClass: 'settings-mcp-rule' });
    expect(t({ permissions: { deny: ['mcp__github'], ask: ['mcp__parley__get_map'] } })).toEqual({ kind: 'trigger', reason: 'settings-ask' });
    expect(t({ permissions: { deny: ['Bash*', 'Web*'] } })).toEqual({ kind: 'clear' });
  });
  it('a user or project file is not judged by its other keys (hooks and plugins are C2b and C2c)', () => {
    expect(t({ hooks: { PreToolUse: [] }, enabledPlugins: { 'x@y': true }, allowedMcpServers: [], whatever: 1 })).toEqual({ kind: 'clear' });
  });
  it('a managed file: an MCP-ruling key is a trigger, a key outside the table is uninspected, listed keys are clear', () => {
    for (const key of ['allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly', 'enableAllProjectMcpServers', 'managedMcpServers']) {
      expect(t({ [key]: [] }, true)).toEqual({ kind: 'trigger', reason: 'managed-mcp' });
    }
    expect(t({ policyHelper: 'x' }, true)).toEqual({ kind: 'uninspected', sourceClass: 'managed-key' });
    expect(t({ brandNewKey: 1 }, true)).toEqual({ kind: 'uninspected', sourceClass: 'managed-key' });
    expect(t({ model: 'opus', theme: 'dark', hooks: {}, enabledPlugins: {}, permissions: { deny: ['Bash'] } }, true)).toEqual({ kind: 'clear' });
    // A trigger anywhere wins over an earlier uninspected key.
    expect(t({ brandNewKey: 1, deniedMcpServers: [] }, true)).toEqual({ kind: 'trigger', reason: 'managed-mcp' });
  });
  it.each([false, true])('the env of any file (B3 m-7585; managed %s): a relocating CLAUDE_/ANTHROPIC_ name, an MCP name, a non-object env: uninspected', (managed) => {
    for (const env of [{ CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/tmp/m.json' }, { ANTHROPIC_AUTH_TOKEN: 'x' }, { claude_project_dir: '/x' }, { MCP_TIMEOUT: '1' }, { my_mcp_thing: '1' }, 'x', [], null]) {
      expect(t({ env }, managed)).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
    }
    expect(t({ env: { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }, managed)).toEqual({ kind: 'clear' });
    // CLAUDE_CONFIG_DIR is recorded only from the launch env; from a settings file it would move the root unrecorded (B3a m-7593).
    expect(t({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }, managed)).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
    // A deny still wins over the env.
    expect(t({ env: { MCP_TIMEOUT: '1' }, permissions: { deny: ['mcp__parley'] } }, managed)).toEqual({ kind: 'trigger', reason: 'settings-deny' });
  });
  it('a managed MCP key still wins over a managed env', () => {
    expect(t({ env: { MCP_TIMEOUT: '1' }, deniedMcpServers: [] }, true)).toEqual({ kind: 'trigger', reason: 'managed-mcp' });
  });
});

describe('the settings class, over a real tree', () => {
  let root = '';
  let configRoot = '';
  let cwd = '';
  let gitRoot = '';
  let managed: ManagedLayer;
  const plist = (): string => path.join(root, 'mdm', 'com.anthropic.claudecode.plist');
  const write = (file: string, data: unknown): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
  const DENY = { permissions: { deny: ['mcp__parley__*'] } };
  const BENIGN = { permissions: { deny: ['Bash(rm:*)'] }, model: 'opus' };
  const cls = (over: Record<string, unknown> = {}) => claudeSettingsClass({ configRoot, cwd, ...over }, managed);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-settings-')));
    configRoot = path.join(root, 'config');
    gitRoot = path.join(root, 'repo');
    cwd = path.join(gitRoot, 'sub');
    mkdirSync(cwd, { recursive: true });
    managed = { dir: path.join(root, 'managed'), presenceOnly: [plist()] };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('nothing present: clear; no config root or no cwd recorded: uninspected', () => {
    expect(cls().check()).toEqual({ kind: 'clear' });
    expect(claudeSettingsClass({ cwd }, managed).check()).toEqual({ kind: 'uninspected', sourceClass: 'settings' });
    expect(claudeSettingsClass({ configRoot }, managed).check()).toEqual({ kind: 'uninspected', sourceClass: 'settings' });
    expect(claudeSettingsClass(undefined, managed).check()).toEqual({ kind: 'uninspected', sourceClass: 'settings' });
  });

  it.each([
    ['user settings', () => path.join(configRoot, 'settings.json'), {}],
    ['project settings at cwd', () => path.join(cwd, '.claude', 'settings.json'), {}],
    ['local settings at cwd', () => path.join(cwd, '.claude', 'settings.local.json'), {}],
    ['project settings at the git root', () => path.join(gitRoot, '.claude', 'settings.json'), { gitRoot: true }],
    ['local settings at the git root', () => path.join(gitRoot, '.claude', 'settings.local.json'), { gitRoot: true }],
    ['the --settings file', () => path.join(root, 'work', 'settings', 's-1.json'), { flag: true }],
  ])('%s: a deny on Parley is a trigger; a relocating env is uninspected (B3); a benign file is clear', (_name, file, opts) => {
    const over = { ...((opts as { gitRoot?: boolean }).gitRoot ? { gitRoot } : {}), ...((opts as { flag?: boolean }).flag ? { settings: { path: file(), sha256: 'a'.repeat(64) } } : {}) };
    write(file(), BENIGN);
    expect(cls(over).check()).toEqual({ kind: 'clear' });
    write(file(), DENY);
    expect(cls(over).check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    write(file(), { ...BENIGN, env: { CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/tmp/m.json' } });
    expect(cls(over).check()).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
  });

  it('a project settings env setting CLAUDE_CONFIG_DIR: uninspected (B3a m-7593)', () => {
    write(path.join(cwd, '.claude', 'settings.json'), { env: { CLAUDE_CONFIG_DIR: path.join(root, 'other-config') } });
    expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
  });

  it('the git root is not read when it is not recorded', () => {
    write(path.join(gitRoot, '.claude', 'settings.local.json'), DENY);
    expect(cls().check()).toEqual({ kind: 'clear' });
    expect(cls({ gitRoot }).check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
  });

  it('both directions between checks: a deny file that appears is a trigger at the next check; deleted, the next check is clear; a benign edit stays clear', () => {
    const c = cls();
    const project = path.join(cwd, '.claude', 'settings.json');
    expect(c.check()).toEqual({ kind: 'clear' });
    write(project, DENY);
    expect(c.check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    unlinkSync(project);
    expect(c.check()).toEqual({ kind: 'clear' });
    write(project, BENIGN);
    expect(c.check()).toEqual({ kind: 'clear' });
    write(project, { ...BENIGN, model: 'sonnet' });
    expect(c.check()).toEqual({ kind: 'clear' });
  });

  it('a FIFO, an oversized file, an unparsable file: triggers, and the FIFO does not stall the check', () => {
    const project = path.join(cwd, '.claude', 'settings.json');
    mkdirSync(path.dirname(project), { recursive: true });
    execFileSync('/usr/bin/mkfifo', [project]);
    const started = Date.now();
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-not-a-file' });
    expect(Date.now() - started).toBeLessThan(2_000);
    unlinkSync(project);
    write(project, ' '.repeat(SETTINGS_MAX_BYTES + 1));
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-too-large' });
    write(project, '{ not json');
    expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-unparsable' });
  });

  describe('one symlink level is followed (s-296 m-7561)', () => {
    const user = (): string => path.join(configRoot, 'settings.json');
    const link = (target: string): void => { mkdirSync(configRoot, { recursive: true }); try { unlinkSync(user()); } catch { /* none */ } symlinkSync(target, user()); };

    it('a link to a regular file is read: clear, or a trigger on a deny', () => {
      const dot = path.join(root, 'dotfiles', 'settings.json');
      write(dot, BENIGN);
      link(dot);
      expect(cls().check()).toEqual({ kind: 'clear' });
      write(dot, DENY);
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    });
    it('a deny written into the target behind an unchanged link is a trigger at the next check', () => {
      const dot = path.join(root, 'dotfiles', 'settings.json');
      write(dot, BENIGN);
      link(dot);
      const c = cls();
      expect(c.check()).toEqual({ kind: 'clear' });
      write(dot, DENY);
      expect(c.check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    });
    it('a link retargeted between two checks is re-read and gives the new verdict', () => {
      const a = path.join(root, 'dotfiles', 'a.json');
      const b = path.join(root, 'dotfiles', 'b.json');
      write(a, BENIGN);
      write(b, DENY);
      link(a);
      const c = cls();
      expect(c.check()).toEqual({ kind: 'clear' });
      link(b);
      expect(c.check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
      link(a);
      expect(c.check()).toEqual({ kind: 'clear' });
    });
    it('a chain of two links is uninspected, never "unreadable"; a dangling link is absent', () => {
      const dot = path.join(root, 'dotfiles', 'settings.json');
      const middle = path.join(root, 'dotfiles', 'middle.json');
      write(dot, BENIGN);
      symlinkSync(dot, middle);
      link(middle);
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'settings' });
      link(path.join(root, 'nowhere.json'));
      expect(cls().check()).toEqual({ kind: 'clear' });
    });
    it('a relative link resolves against the link\'s own directory', () => {
      write(path.join(configRoot, 'real.json'), DENY);
      link('real.json');
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
    });
  });

  describe('the managed layer', () => {
    const m = (name: string): string => path.join(managed.dir, name);
    it('managed-mcp.json present: trigger; an unknown file in the dir: uninspected', () => {
      write(m('managed-mcp.json'), {});
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'managed-mcp' });
      unlinkSync(m('managed-mcp.json'));
      write(m('notes.txt'), 'x');
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed-file' });
    });
    it('managed-settings.json: a deny, an MCP key: triggers; a benign one: clear; a key outside the table: uninspected', () => {
      write(m('managed-settings.json'), { model: 'opus' });
      expect(cls().check()).toEqual({ kind: 'clear' });
      write(m('managed-settings.json'), DENY);
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
      write(m('managed-settings.json'), { deniedMcpServers: [{ serverName: 'x' }] });
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'managed-mcp' });
      write(m('managed-settings.json'), { policyHelpers: [] });
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed-key' });
      write(m('managed-settings.json'), { env: { CLAUDE_CODE_REMOTE_SETTINGS_PATH: '/x' } });
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'settings-env' });
    });
    it('drop-ins: each .json is read, sorted; another entry is uninspected; over the bound is uninspected', () => {
      write(m('managed-settings.d/10-a.json'), { model: 'opus' });
      expect(cls().check()).toEqual({ kind: 'clear' });
      write(m('managed-settings.d/20-b.json'), DENY);
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
      unlinkSync(m('managed-settings.d/20-b.json'));
      write(m('managed-settings.d/README'), 'x');
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed-file' });
      unlinkSync(m('managed-settings.d/README'));
      for (let i = 0; i <= DROPIN_MAX_ENTRIES; i++) write(m(`managed-settings.d/${String(i).padStart(3, '0')}.json`), {});
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed' });
    });
    it('a policy layer never parsed here (an MDM plist, server-managed settings) present: uninspected; a trigger elsewhere still wins', () => {
      write(plist(), 'x');
      expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed-policy' });
      write(path.join(cwd, '.claude', 'settings.json'), DENY);
      expect(cls().check()).toEqual({ kind: 'trigger', reason: 'settings-deny' });
      unlinkSync(plist());
      unlinkSync(path.join(cwd, '.claude', 'settings.json'));
      for (const name of ['remote-settings.json', 'policy-limits.json']) {
        write(path.join(configRoot, name), {});
        expect(cls().check()).toEqual({ kind: 'uninspected', sourceClass: 'managed-policy' });
        unlinkSync(path.join(configRoot, name));
      }
      expect(cls().check()).toEqual({ kind: 'clear' });
    });
  });
});
