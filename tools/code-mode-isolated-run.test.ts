// The isolated run (lead m-7346): its refusals by name, and one real run against this tree's host with a fake `claude` on PATH. The host and its
// launch are real; the provider binary is the run's own stub, so no model is called.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IsolatedRunRefused,
  LIVE_STORE_OPTIONS,
  PAID_TURN_OPTIONS,
  PAID_TURN_VARIABLES,
  isolatedRun,
  liveHomes,
  parseOptions,
  refuseLiveDirectory,
  refusePaidTurnVariables,
  settingsFacts,
} from './code-mode-isolated-run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refused = (f: () => unknown, text: string): void => {
  let caught: unknown;
  try { f(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(IsolatedRunRefused);
  expect((caught as Error).message).toContain(text);
};

describe('options: a paid turn or a live workspace is refused by name', () => {
  it.each(PAID_TURN_OPTIONS.map((o) => [o]))('%s, alone or with a value', (option) => {
    refused(() => parseOptions([option]), `${option} would start a model turn`);
    refused(() => parseOptions([`${option}=hello`]), `${option} would start a model turn`);
    refused(() => parseOptions(['--keep', option, 'hello']), `${option} would start a model turn`);
  });
  it.each(LIVE_STORE_OPTIONS.map((o) => [o]))('%s', (option) => {
    refused(() => parseOptions([option, '/Users/x/.parley']), `${option} names a home or workspace`);
    refused(() => parseOptions([`${option}=w-0054`]), `${option} names a home or workspace`);
  });
  it('anything unknown is refused; the three known options parse', () => {
    refused(() => parseOptions(['--dangerously-skip-permissions']), 'unknown option');
    refused(() => parseOptions(['--app']), '--app needs a value');
    expect(parseOptions(['--app', '/a/Parley.app', '--out=/tmp/r.json', '--keep'])).toEqual({ app: '/a/Parley.app', out: '/tmp/r.json', keep: true });
    expect(parseOptions([])).toEqual({ app: null, out: null, keep: false });
  });
});

describe('variables: a provider binary override in the caller is refused', () => {
  it.each(PAID_TURN_VARIABLES.map((v) => [v]))('%s', (name) => {
    refused(() => refusePaidTurnVariables({ [name]: '/usr/local/bin/claude' }), `${name} is set`);
    refused(() => refusePaidTurnVariables({ [name]: '' }), `${name} is set`);
  });
  it('none set: no refusal', () => {
    expect(() => refusePaidTurnVariables({ PATH: '/usr/bin' })).not.toThrow();
  });
});

describe('directories: only inside the temp directory, never at, under or around a live home', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'isolated-test-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const fakeHome = path.join(temp, 'person');

  it('the live homes are ~/.parley, ~/.harnas and what PARLEY_HOME and HARNAS_HOME name', () => {
    const live = liveHomes({ PARLEY_HOME: path.join(temp, 'p'), HARNAS_HOME: path.join(temp, 'h') }, fakeHome);
    expect(live.map((h) => path.basename(h))).toEqual(['.parley', '.harnas', 'p', 'h']);
    expect(liveHomes({ PARLEY_HOME: '' }, fakeHome)).toHaveLength(2);
  });
  it('a home or project at or under ~/.parley, or the live w-0054 store under the caller\'s PARLEY_HOME: refused', () => {
    const live = liveHomes({ PARLEY_HOME: path.join(temp, 'live') }, homedir());
    refused(() => refuseLiveDirectory('home', path.join(homedir(), '.parley'), live), 'is or lies under the live Parley home');
    refused(() => refuseLiveDirectory('home', path.join(homedir(), '.parley', 'works', 'w-0054'), live), 'is or lies under the live Parley home');
    refused(() => refuseLiveDirectory('project', path.join(homedir(), '.harnas', 'x'), live), 'is or lies under the live Parley home');
    refused(() => refuseLiveDirectory('home', path.join(temp, 'live', 'host'), live, temp), 'is or lies under the live Parley home');
    refused(() => refuseLiveDirectory('project', temp, live, temp), 'contains the live Parley home');
  });
  it('outside the temp directory, or the temp directory itself: refused', () => {
    refused(() => refuseLiveDirectory('project', path.join(homedir(), 'some-project'), [], temp), 'is not inside the temporary directory');
    refused(() => refuseLiveDirectory('home', temp, [], temp), 'is not inside the temporary directory');
    refused(() => refuseLiveDirectory('home', '/', [], temp), 'is not inside the temporary directory');
  });
  it('a fresh directory inside the temp directory, away from every live home: allowed', () => {
    expect(() => refuseLiveDirectory('home', path.join(temp, 'run', 'home'), liveHomes({}, fakeHome), temp)).not.toThrow();
  });
});

describe('settings facts: hook event names with counts and plugin names, never values', () => {
  it('a hook command and an env value never appear', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'isolated-settings-'));
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({
      env: { SECRET: 'PARLEY_CANARY_ENV_7f3a' },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo PARLEY_CANARY_HOOK_7f3a' }] }], Stop: [{}, {}] },
      enabledPlugins: { 'b@m': true, 'a@m': true, 'off@m': false },
    }));
    const facts = settingsFacts(file);
    expect(facts).toEqual({ file, exists: true, hooks: { PreToolUse: 1, Stop: 2 }, plugins: ['a@m', 'b@m'] });
    expect(JSON.stringify(facts)).not.toContain('CANARY');
    writeFileSync(file, '{torn');
    expect(settingsFacts(file)).toEqual({ file, exists: true, hooks: {}, plugins: [], unreadable: true });
    expect(settingsFacts(path.join(dir, 'none.json'))).toEqual({ file: path.join(dir, 'none.json'), exists: false, hooks: {}, plugins: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('one real run against this tree\'s host', () => {
  let bin = '';
  beforeAll(() => {
    // The host this run starts is this tree's build.
    execFileSync('pnpm', ['--filter', '@parley/host', 'build'], { cwd: ROOT, stdio: 'ignore' });
    bin = mkdtempSync(path.join(tmpdir(), 'isolated-bin-'));
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo "9.9.9 (fake claude)"; exit 0; }\necho "a turn was attempted" >&2\nexit 3\n');
    chmodSync(path.join(bin, 'claude'), 0o755);
  }, 180_000);
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  const runEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: process.env['HOME'] ?? homedir() };
    if (process.env['PARLEY_HOME'] !== undefined) env['PARLEY_HOME'] = process.env['PARLEY_HOME'];
    return env;
  };
  const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('parley-isolated-'));

  it('the launch is the host\'s own, classic for provider-unproven, with no turn; the detector and settings are recorded; nothing is left', async () => {
    const before = leftovers();
    const report = await isolatedRun({ app: null, out: null, keep: false }, runEnv());
    expect(report.host.kind).toBe('dev');
    expect(report.claude).toEqual({ path: path.join(bin, 'claude'), version: '9.9.9 (fake claude)', turns: 0 });
    expect(report.decision).toMatchObject({ kind: 'decision', decision: { effective: 'classic', requested: true, reason: 'provider-unproven', provider: 'claude', nonce: null } });
    expect(report.codeMode).toEqual({ mode: 'classic', reason: 'provider-unproven' });
    expect(report.detector).toEqual({ kind: 'uninspected', sourceClass: 'no-provider-row' });
    expect(report.launch.mcpServers).toEqual(['parley']);
    expect(report.launch.argv).not.toContain('--version');
    expect(report.launch.codeModeLaunch).toBe(false);
    expect(report.launch.argv).toContain('--mcp-config');
    expect(report.settings.map((s) => path.basename(s.file))).toEqual(['settings.json', 'settings.json', 'settings.local.json', 's-01.json']);
    expect(report.settings[3]).toMatchObject({ exists: true });
    expect(Object.keys(report.settings[3]!.hooks).length).toBeGreaterThan(0);
    expect(report.home).toBeNull();
    expect(leftovers()).toEqual(before);
  }, 120_000);

  it('a caller whose PARLEY_HOME is the temp directory: the run\'s own home would lie under a live home, so it is refused and nothing is left', async () => {
    const before = leftovers();
    await expect(isolatedRun({ app: null, out: null, keep: false }, { ...runEnv(), PARLEY_HOME: tmpdir() })).rejects.toThrow(/the home .* is or lies under the live Parley home/);
    expect(leftovers()).toEqual(before);
  });

  it('no claude on PATH: no run, and nothing is left', async () => {
    const before = leftovers();
    await expect(isolatedRun({ app: null, out: null, keep: false }, { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? homedir() })).rejects.toThrow('no usable claude on PATH');
    expect(leftovers()).toEqual(before);
  });

  it('a caller with PARLEY_CLAUDE_BIN set is refused before any home, host or process exists', async () => {
    const before = leftovers();
    await expect(isolatedRun({ app: null, out: null, keep: false }, { ...runEnv(), PARLEY_CLAUDE_BIN: path.join(bin, 'claude') })).rejects.toThrow(IsolatedRunRefused);
    expect(leftovers()).toEqual(before);
  });

  it('--keep leaves the run\'s directory with the stub\'s record of its launch', async () => {
    const report = await isolatedRun({ app: null, out: null, keep: true }, runEnv());
    try {
      expect(report.home).not.toBeNull();
      expect(existsSync(path.join(report.home!, 'launch.json'))).toBe(true);
      mkdirSync(path.join(report.home!, 'checked'));
    } finally {
      rmSync(report.home!, { recursive: true, force: true });
    }
  }, 120_000);
});
