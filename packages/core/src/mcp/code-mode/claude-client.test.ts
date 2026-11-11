// T12a-Claude C1: the client probe at launch and the client-process check in the session process (s-296 R1 m-7516, lead m-7515).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ParentReader, REVIEWED_CLAUDE_VERSIONS, clientClass, clientVersionReviewed, probeClaudeClient } from './claude-client.js';
import { createDetector } from './detector.js';
import { providerSourceClasses } from './provider-rows.js';

const coreDir = fileURLToPath(new URL('../../../', import.meta.url));
let dir = '';
beforeAll(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-client-'))); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const script = (name: string, body: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const REVIEWED = REVIEWED_CLAUDE_VERSIONS[0]!;

describe('the probe at launch: realpath, inode and the version of exactly that file', () => {
  it('through a symlink: the realpath and its inode, and the version it prints', async () => {
    const real = script('claude-real', `echo "${REVIEWED} (Claude Code)"`);
    const link = path.join(dir, 'claude-link');
    symlinkSync(real, link);
    const probe = await probeClaudeClient(link);
    expect(probe).toEqual({ ok: true, client: { path: real, version: REVIEWED, inode: statSync(real, { bigint: true }).ino.toString() } });
    expect(clientVersionReviewed(probe)).toBe(true);
  });

  it.each([
    ['another version', 'echo "9.9.9 (Claude Code)"', true],
    ['a version line of another program', 'echo "v22.23.3"', false],
    ['extra text on the line', `echo "${REVIEWED} (Claude Code) beta"`, false],
    ['a non-zero exit', `echo "${REVIEWED} (Claude Code)"; exit 3`, false],
    ['no output', 'true', false],
  ])('%s: never reviewed', async (_name, body, parses) => {
    const probe = await probeClaudeClient(script(`claude-${Math.random().toString(16).slice(2)}`, body));
    expect(probe.ok).toBe(parses);
    expect(clientVersionReviewed(probe)).toBe(false);
  });

  it('a missing file, a directory: not a file, and never reviewed', async () => {
    mkdirSync(path.join(dir, 'a-dir'), { recursive: true });
    expect(await probeClaudeClient(path.join(dir, 'nope'))).toEqual({ ok: false, reason: 'not-a-file' });
    expect(await probeClaudeClient(path.join(dir, 'a-dir'))).toEqual({ ok: false, reason: 'not-a-file' });
    expect(clientVersionReviewed(undefined)).toBe(false);
  });

  it('a binary that hangs is cut at the bound and is not reviewed; the event loop keeps turning meanwhile', async () => {
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 100);
    try {
      expect(await probeClaudeClient(script('claude-hang', 'exec sleep 30'))).toEqual({ ok: false, reason: 'no-version' });
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThanOrEqual(10);
  }, 20_000);
});

describe('the client class: the client process, never the PATH binary', () => {
  const recorded = { path: '/opt/claude/versions/2.1.322', version: REVIEWED, inode: '1152921500312611996' };
  const reader = (over: Partial<{ text: ParentReader['text']; comm: ParentReader['comm']; ppid: number }> = {}): ParentReader & { set(o: typeof over): void } => {
    let state = { text: (): ReturnType<ParentReader['text']> => ({ path: recorded.path, inode: recorded.inode }), comm: (): string | null => recorded.path, ppid: 4242, ...over };
    return { text: (p) => state.text(p), comm: (p) => state.comm(p), ppid: () => state.ppid, set(o) { state = { ...state, ...o }; } };
  };

  it('no recorded client: uninspected', () => {
    expect(clientClass(undefined, reader()).check()).toEqual({ kind: 'uninspected', sourceClass: 'client' });
  });
  it('the recorded file is the parent\'s image: clear, and stays clear while the parent is the same', () => {
    const c = clientClass(recorded, reader());
    expect(c.check()).toEqual({ kind: 'clear' });
    expect(c.check()).toEqual({ kind: 'clear' });
  });
  it.each([
    ['another path', { text: () => ({ path: '/opt/claude/versions/2.1.400', inode: recorded.inode }) }],
    ['the same path, another inode (swapped before the spawn)', { text: () => ({ path: recorded.path, inode: '7' }) }],
  ])('first check, %s: trigger', (_name, over) => {
    expect(clientClass(recorded, reader(over)).check()).toEqual({ kind: 'trigger', reason: 'client-process' });
  });
  it('the parent cannot be read: uninspected, at the first check and later', () => {
    expect(clientClass(recorded, reader({ text: () => null })).check()).toEqual({ kind: 'uninspected', sourceClass: 'client' });
    const r = reader();
    const c = clientClass(recorded, r);
    c.check();
    r.set({ comm: () => null });
    expect(c.check()).toEqual({ kind: 'uninspected', sourceClass: 'client' });
  });
  it('later: an exec in place (another accounting name) or another parent is a trigger', () => {
    const r = reader();
    const c = clientClass(recorded, r);
    expect(c.check()).toEqual({ kind: 'clear' });
    r.set({ comm: () => '/usr/bin/other' });
    expect(c.check()).toEqual({ kind: 'trigger', reason: 'client-process' });
    const r2 = reader();
    const c2 = clientClass(recorded, r2);
    c2.check();
    r2.set({ ppid: 1 });
    expect(c2.check()).toEqual({ kind: 'trigger', reason: 'client-process' });
  });
});

describe('the Claude row: the client first, then settings (C2a); every reader still to come uninspected (lead m-7515 Q3)', () => {
  it('its classes, in order; with no recorded client the scan is uninspected at the client', () => {
    const classes = providerSourceClasses('claude', { cwd: dir })!;
    expect(classes.map((c) => c.name)).toEqual(['client', 'settings', 'plugins', 'nested-sources']);
    expect(createDetector({ classes, configFile: path.join(dir, 'no-config.json') }).scan()).toEqual({ kind: 'uninspected', sourceClass: 'client' });
  });
  it('a clear client with no recorded config root leaves the row uninspected at settings', () => {
    const recorded = { path: '/opt/claude/x', version: REVIEWED, inode: '9' };
    const fake: ParentReader = { text: () => ({ path: recorded.path, inode: recorded.inode }), comm: () => recorded.path, ppid: () => 7 };
    const classes = [clientClass(recorded, fake), ...providerSourceClasses('claude', { cwd: dir, identities: { client: recorded } })!.slice(1)];
    expect(createDetector({ classes, configFile: path.join(dir, 'no-config.json') }).scan()).toEqual({ kind: 'uninspected', sourceClass: 'settings' });
  });
});

describe.skipIf(process.platform !== 'darwin')('the real parent process (s-296 R1)', () => {
  // A copy of node plays the client: it starts a child that runs the check with the real reader against what the launch would have recorded.
  // In between, the child retargets the PATH symlink to another copy: the running client does not change, so the check stays clear.
  const clone = (name: string): string => {
    const to = path.join(dir, name);
    try { execFileSync('/bin/cp', ['-c', process.execPath, to]); } catch { copyFileSync(process.execPath, to); }
    chmodSync(to, 0o755);
    return to;
  };
  const run = (client: string, recordedPath: string, link: string, retargetTo: string): { first: unknown; second: unknown } => {
    const checker = path.join(dir, 'checker.mjs');
    writeFileSync(checker, `import { symlinkSync, unlinkSync, statSync } from 'node:fs';
const { clientClass } = await import(${JSON.stringify(pathToFileURL(path.join(coreDir, 'dist/mcp/code-mode/claude-client.js')).href)});
const recorded = { path: ${JSON.stringify(recordedPath)}, version: '2.1.322', inode: statSync(${JSON.stringify(recordedPath)}, { bigint: true }).ino.toString() };
const c = clientClass(recorded);
const first = c.check();
unlinkSync(${JSON.stringify(link)}); symlinkSync(${JSON.stringify(retargetTo)}, ${JSON.stringify(link)});
const second = c.check();
process.stdout.write(JSON.stringify({ first, second }));
`);
    const parent = `const { spawnSync } = require('node:child_process'); const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(checker)}], { encoding: 'utf8' }); process.stdout.write(r.stdout); process.stderr.write(r.stderr);`;
    const out = spawnSync(client, ['-e', parent], { encoding: 'utf8', timeout: 30_000 });
    expect(out.stderr).toBe('');
    return JSON.parse(out.stdout) as { first: unknown; second: unknown };
  };

  it('the client is the recorded file; the PATH symlink is retargeted mid-session: clear, then still clear', () => {
    const a = clone('client-a');
    const b = clone('client-b');
    const link = path.join(dir, 'claude');
    try { unlinkSync(link); } catch { /* none */ }
    symlinkSync(a, link);
    expect(run(a, a, link, b)).toEqual({ first: { kind: 'clear' }, second: { kind: 'clear' } });
  }, 60_000);

  it('the client running is not the recorded file: a trigger at the first check', () => {
    const a = clone('client-c');
    const b = clone('client-d');
    const link = path.join(dir, 'claude2');
    symlinkSync(b, link);
    expect(run(a, b, link, a)).toMatchObject({ first: { kind: 'trigger', reason: 'client-process' } });
  }, 60_000);
});
