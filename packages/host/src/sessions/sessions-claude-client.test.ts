// T12a-Claude C1 (s-296 R1 m-7516): the host resolves claude once, by realpath, probes exactly that file and spawns exactly that file. A real PTY
// with a stub in claude's place, reached through a symlink, and a real work store; the launch decision is read back. Only for a proven provider
// with Code Mode requested (s-292 B1 m-7532): with no proven provider the launch runs no probe and spawns as it always did.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CodeModeGateSeams, REVIEWED_CLAUDE_VERSIONS, createWork, readLaunchDecision, workPaths, writeSecret } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';

vi.setConfig({ testTimeout: 30_000 });

const ENV = ['PARLEY_CLAUDE_BIN', 'PARLEY_SKILL_NAVIGATOR', 'PARLEY_HOME', 'STUB_SPAWNED'] as const;
const saved = ENV.map((k) => process.env[k]);
let root = '';

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-claude-client-host-')));
  process.env['PARLEY_SKILL_NAVIGATOR'] = '0';
  process.env['PARLEY_HOME'] = path.join(root, 'home');
});
afterEach(() => {
  ENV.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeHost(): HostContext {
  const log = (): void => {};
  return {
    version: '0.0.0', startedAt: new Date().toISOString(), paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: log, warn: log, error: log }, clients: () => [], liveSessions: () => 0, broadcast: () => {},
    onShutdown: () => {}, shutdown: async () => {}, busy: () => {},
  };
}
const fakeWorks = (): WorksService => ({ start: async () => {}, snapshot: () => ({ entries: [], branches: {} }), entry: () => undefined, firstReadDone: () => false, onChange: () => () => {}, stop: async () => {} });
const fakeActivity = (): ActivityService => ({ start: async () => {}, get: () => undefined, markSeen: () => {}, onChange: () => () => {}, stop: async () => {} });

/** A claude stand-in: `--version` counts itself in a file named in its source (the probe passes only PATH and HOME) and prints `version`; any other start writes the path it was executed by, then waits. */
function stub(version: string): { real: string; link: string; spawned: string; versions: string } {
  const real = path.join(root, 'versions', 'claude-real');
  const spawned = path.join(root, 'spawned.txt');
  const versions = path.join(root, 'versions.txt');
  mkdirSync(path.dirname(real), { recursive: true });
  writeFileSync(real, `#!/usr/bin/env node
if (process.argv.includes('--version')) { require('node:fs').appendFileSync(${JSON.stringify(versions)}, 'v\\n'); process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)}); process.exit(0); }
require('node:fs').writeFileSync(process.env.STUB_SPAWNED, process.argv[1]);
process.stdin.resume();
`);
  chmodSync(real, 0o755);
  const link = path.join(root, 'bin', 'claude');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(real, link);
  process.env['PARLEY_CLAUDE_BIN'] = link;
  process.env['STUB_SPAWNED'] = spawned;
  return { real, link, spawned, versions };
}
const PROVEN_CLAUDE: Pick<CodeModeGateSeams, 'proven' | 'requested'> = { proven: ['claude'], requested: async () => true };

async function launch(codeModeGates?: Pick<CodeModeGateSeams, 'proven' | 'requested'>, provider = 'claude'): Promise<{ dir: string; sessionId: string; stop: () => Promise<void> }> {
  const host = fakeHost();
  // GLM checks the CLI version it runs on (minVersion): the cached answer is the reviewed one.
  const providerVersions = { ready: Promise.resolve(), get: () => REVIEWED_CLAUDE_VERSIONS[0]!, fresh: async () => REVIEWED_CLAUDE_VERSIONS[0]! };
  const service = createSessionsService(host, fakeWorks(), createPtyManager(host), fakeActivity(), { providerVersions, ...(codeModeGates === undefined ? {} : { codeModeGates }) });
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  const work = await createWork(project, { title: 'C1', goal: '' });
  const ref = await service.create({ projectPath: project, workId: work.work.id, provider, label: 'c1', task: 'wait', parent: null });
  return { dir: workPaths(project, work.work.id).dir, sessionId: ref.sessionId, stop: () => service.stop(ref) };
}
const until = async (cond: () => boolean): Promise<void> => { const end = Date.now() + 10_000; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const exists = (f: string): boolean => { try { statSync(f); return true; } catch { return false; } };

describe('the host spawns the claude it probed, by realpath (T12a-Claude C1)', () => {
  it('no proven provider (the shipped PROVEN_PROVIDERS): no probe at all, the PTY runs what findRunnerBinary gives, and no client is recorded', async () => {
    // No seam: the launch reads the shipped proven set, which is empty until a T12b activates claude.
    const s = stub(REVIEWED_CLAUDE_VERSIONS[0]!);
    const { dir, sessionId, stop } = await launch();
    await until(() => exists(s.spawned));
    expect(readFileSync(s.spawned, 'utf8')).toBe(s.link);
    expect(exists(s.versions)).toBe(false);
    const read = readLaunchDecision(dir, sessionId) as { decision: Record<string, unknown> };
    expect(read.decision).toMatchObject({ v: 2, effective: 'classic', nonce: null });
    expect(read.decision).not.toHaveProperty('client');
    await stop();
  });

  it('proven but Code Mode not requested: no probe either', async () => {
    const s = stub(REVIEWED_CLAUDE_VERSIONS[0]!);
    const { stop } = await launch({ proven: ['claude'], requested: async () => false });
    await until(() => exists(s.spawned));
    expect(readFileSync(s.spawned, 'utf8')).toBe(s.link);
    expect(exists(s.versions)).toBe(false);
    await stop();
  });

  it('GLM runs `claude` too: proven and requested, it still runs no probe and spawns as before; Claude\'s review is never inherited (s-296 G1)', async () => {
    await writeSecret('zai', 'fake-key');
    const s = stub(REVIEWED_CLAUDE_VERSIONS[0]!);
    const { dir, sessionId, stop } = await launch({ proven: ['glm'], requested: async () => true }, 'glm');
    await until(() => exists(s.spawned));
    expect(readFileSync(s.spawned, 'utf8')).toBe(s.link);
    expect(exists(s.versions)).toBe(false);
    const read = readLaunchDecision(dir, sessionId) as { decision: Record<string, unknown> };
    expect(read.decision).toMatchObject({ v: 2, provider: 'glm', effective: 'classic' });
    expect(read.decision).not.toHaveProperty('client');
    await stop();
  });

  it('proven and requested, a reviewed version: one probe, the decision records the realpath, version and inode, and the PTY runs exactly that file, not the symlink', async () => {
    const s = stub(REVIEWED_CLAUDE_VERSIONS[0]!);
    const { dir, sessionId, stop } = await launch(PROVEN_CLAUDE);
    await until(() => exists(s.spawned));
    expect(readFileSync(s.spawned, 'utf8')).toBe(s.real);
    expect(readFileSync(s.versions, 'utf8')).toBe('v\n');
    expect(readLaunchDecision(dir, sessionId)).toMatchObject({ kind: 'decision', decision: { v: 2, effective: 'classic', client: { path: s.real, version: REVIEWED_CLAUDE_VERSIONS[0], inode: statSync(s.real, { bigint: true }).ino.toString() } } });
    await stop();
  });

  it('proven and requested, an unreviewed version is still recorded and still spawned by realpath (a launch with no agent channel stops at not-parley-launched before the version gate)', async () => {
    const s = stub('9.9.9');
    const { dir, sessionId, stop } = await launch(PROVEN_CLAUDE);
    await until(() => exists(s.spawned));
    expect(readFileSync(s.spawned, 'utf8')).toBe(s.real);
    expect(readLaunchDecision(dir, sessionId)).toMatchObject({ decision: { v: 2, client: { version: '9.9.9' } } });
    await stop();
  });
});
