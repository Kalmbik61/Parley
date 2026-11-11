// The launcher's Code Mode decision (plan T12a slice B): the gate order, a decision written for every launch, and a nonce in the MCP config
// only after a replacement decision was written as `true`. PROVEN is empty, so a real launch is always classic; replacement is reached here
// only through the test seam `codeModeGates`.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchDecisionPath, readLaunchDecision } from '../mcp/code-mode/launch-decision.js';
import { MIGRATABLE_READS, MIGRATION_REGISTRY, type MigrationRegistry } from '../mcp/code-mode/migration-registry.js';
import { createRunRecordStore, type RecordView } from '../mcp/code-mode/run-record.js';
import { bootstrapText, heldRunRouting } from './code-mode-instructions.js';
import { CODE_MODE_REASONS } from '../mcp/code-mode/mode-state.js';
import { type CodeModeGateSeams, createPendingSession, planLaunch, wantsClientProbe } from './launch.js';
import { REVIEWED_CLAUDE_VERSIONS } from '../mcp/code-mode/claude-client.js';
import { claudeEnvVerdict } from '../mcp/code-mode/claude-launch-sources.js';
import { createHash } from 'node:crypto';
import { decideLaunchExposure, firstRefusal, type GateFacts, PROVEN_PROVIDERS } from './launch-exposure.js';
import { createWork, readMap, workPaths } from './store.js';

const ROLE_CLEAR = { role: { status: 'compatible', names: [] } } as never;

/** Facts that all pass; each async gate counts its calls. */
function facts(over: Partial<GateFacts> = {}): { facts: GateFacts; calls: string[] } {
  const calls: string[] = [];
  const gate = <T>(name: string, value: T) => async (): Promise<T> => { calls.push(name); return value; };
  return {
    calls,
    facts: {
      provider: 'claude', confined: false, parleyLaunched: true, deliverable: true, proven: ['claude'],
      clientVersionReviewed: gate('client-version', true),
      helperAvailable: gate('helper', true),
      registryOk: gate('registry', true),
      detector: gate('detector', { kind: 'clear' } as const),
      routingReport: gate('routing', {}),
      ...over,
    },
  };
}

describe('firstRefusal: one order, the first refusal is the reason, later gates are never asked', () => {
  const ORDER: [string, Partial<GateFacts>, string[]][] = [
    ['confined-attempt', { confined: true }, []],
    ['not-parley-launched', { parleyLaunched: false }, []],
    ['provider-unproven', { proven: [] }, []],
    ['client-version', { clientVersionReviewed: async () => false }, []],
    ['instructions-undeliverable', { deliverable: false }, ['client-version']],
    ['helper-unavailable', { helperAvailable: async () => false }, ['client-version']],
    ['registry', { registryOk: async () => false }, ['client-version', 'helper']],
    ['detector', { detector: async () => ({ kind: 'trigger' }) }, ['client-version', 'helper', 'registry']],
    ['uninspected-source:nested-claude', { detector: async () => ({ kind: 'uninspected', sourceClass: 'nested-claude' }) }, ['client-version', 'helper', 'registry']],
  ];
  it.each(ORDER)('%s', async (reason, over, before) => {
    const f = facts(over);
    expect(await firstRefusal(f.facts)).toBe(reason);
    // Only the gates before it ran (the refusing one is replaced, so it does not log); nothing after it.
    expect(f.calls).toEqual(before);
  });
  it('every gate refusing at once: the earliest wins, so the order is the order of the list', async () => {
    const all = facts({ confined: true, parleyLaunched: false, proven: [], clientVersionReviewed: async () => false, deliverable: false });
    expect(await firstRefusal(all.facts)).toBe('confined-attempt');
    expect(await firstRefusal({ ...all.facts, confined: false })).toBe('not-parley-launched');
    expect(await firstRefusal({ ...all.facts, confined: false, parleyLaunched: true })).toBe('provider-unproven');
  });
  const INCOMPATIBLE = {
    role: { role: { status: 'incompatible', names: ['x'] } },
    playbook: { playbook: { status: 'incompatible', names: ['x'] } },
    skills: { skills: { status: 'incompatible', skills: [{ names: ['x'] }] } },
  } as const;
  it.each(['role', 'playbook', 'skills'] as const)('a %s verdict that selects classic is the reason, after every other gate', async (source) => {
    const f = facts({ routingReport: async () => INCOMPATIBLE[source] as never });
    expect(await firstRefusal(f.facts)).toBe(source);
    expect(f.calls).toEqual(['client-version', 'helper', 'registry', 'detector']);
  });
  it('all pass: null, every gate asked once', async () => {
    const f = facts({ routingReport: async () => ROLE_CLEAR });
    expect(await firstRefusal(f.facts)).toBeNull();
    const g = facts();
    expect(await firstRefusal(g.facts)).toBeNull();
    expect(g.calls).toEqual(['client-version', 'helper', 'registry', 'detector', 'routing']);
  });
  it('every fixed reason it can return is on the closed list the indicator shows', async () => {
    const keys = Object.keys(CODE_MODE_REASONS);
    for (const [reason] of ORDER) expect(keys).toContain(reason.startsWith('uninspected-source:') ? 'uninspected-source' : reason);
    for (const source of ['role', 'playbook', 'skills', 'not-requested', 'held-run', 'decision-write-failed']) expect(keys).toContain(source);
  });
});

describe('decideLaunchExposure: the record, then the setting, then the gates', () => {
  const FREE: RecordView = { kind: 'free' };
  it('not requested: classic not-requested, and no gate is asked', async () => {
    const f = facts();
    expect(await decideLaunchExposure({ requested: false, record: FREE, gates: f.facts })).toEqual({ effective: 'classic', reason: 'not-requested' });
    expect(f.calls).toEqual([]);
  });
  it.each<[string, RecordView, string]>([
    ['held-live', { kind: 'held-live', methods: ['get_map'] }, 'may-be-finishing'],
    ['unaccounted', { kind: 'unaccounted', methods: ['get_map'] }, 'unaccounted'],
    ['unreadable', { kind: 'unreadable' }, 'unaccounted'],
  ])('a %s record wins over a passing setting and gates: classic held-run, no gate asked', async (_name, record, held) => {
    const f = facts();
    expect(await decideLaunchExposure({ requested: true, record, gates: f.facts })).toEqual({ effective: 'classic', reason: 'held-run', held });
    expect(f.calls).toEqual([]);
  });
  it('a held record naming a non-read method blocks', async () => {
    expect(await decideLaunchExposure({ requested: true, record: { kind: 'held-live', methods: ['send_message'] }, gates: facts().facts }))
      .toEqual({ effective: 'blocked', reason: 'non-read-record' });
  });
  it('writesExist comes from the registry: false for the shipped one (unreadable is classic), true for a fixture with a write (unreadable blocks)', async () => {
    const unreadable: RecordView = { kind: 'unreadable' };
    expect(await decideLaunchExposure({ requested: true, record: unreadable, gates: facts().facts })).toEqual({ effective: 'classic', reason: 'held-run', held: 'unaccounted' });
    const withWrite: MigrationRegistry = { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'send_message'] };
    const f = facts();
    expect(await decideLaunchExposure({ requested: true, record: unreadable, gates: f.facts, registry: withWrite })).toEqual({ effective: 'blocked', reason: 'unreadable-record' });
    expect(await decideLaunchExposure({ requested: false, record: unreadable, gates: f.facts, registry: withWrite })).toEqual({ effective: 'blocked', reason: 'unreadable-record' });
    expect(f.calls).toEqual([]);
  });
  it('a held record naming a migrated non-cohort read: classic held-run under a registry that allows it, blocked under one that does not', async () => {
    // `fixture_read`: a name the inventory does not enter, entered as a read in this fixture's own inventory only (never a real tool, never a `browser_*`, m-7370).
    const record: RecordView = { kind: 'unaccounted', methods: ['get_map', 'fixture_read'] };
    const six: MigrationRegistry = {
      ...MIGRATION_REGISTRY, entries: [...MIGRATION_REGISTRY.entries, { name: 'fixture_read', cohort: false, effect: 'read', removal: 'fixture' }], migratable: [...MIGRATABLE_READS, 'fixture_read'],
    };
    expect(await decideLaunchExposure({ requested: true, record, gates: facts().facts, registry: six })).toEqual({ effective: 'classic', reason: 'held-run', held: 'unaccounted' });
    expect(await decideLaunchExposure({ requested: true, record, gates: facts().facts })).toEqual({ effective: 'blocked', reason: 'non-read-record' });
  });
  it('requested, free, a refusal: classic with that reason', async () => {
    expect(await decideLaunchExposure({ requested: true, record: FREE, gates: facts({ proven: [] }).facts })).toEqual({ effective: 'classic', reason: 'provider-unproven' });
  });
  it('requested, free, all pass: replacement', async () => {
    expect(await decideLaunchExposure({ requested: true, record: FREE, gates: facts().facts })).toEqual({ effective: 'replacement', reason: null });
  });
  it('PROVEN is empty: with the shipped list, a requested launch stops at provider-unproven before any costly gate', async () => {
    expect(PROVEN_PROVIDERS).toEqual([]);
    for (const provider of ['claude', 'codex', 'glm']) {
      const f = facts({ provider, proven: PROVEN_PROVIDERS });
      expect(await decideLaunchExposure({ requested: true, record: FREE, gates: f.facts })).toEqual({ effective: 'classic', reason: 'provider-unproven' });
      expect(f.calls).toEqual([]);
    }
  });
});

// ---- The launch path itself.

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'stub-agent.mjs');
const AGENT = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };
const PASSING: CodeModeGateSeams = {
  proven: ['claude', 'codex'],
  clientVersionReviewed: async () => true,
  helperAvailable: async () => true,
  detector: async () => ({ kind: 'clear' }),
  requested: async () => true,
};

let home = '';
let project = '';
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-t12a-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-t12a-project-'));
  setEnv('PARLEY_HOME', home);
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CODEX_BIN', STUB);
  setEnv('PARLEY_GLM_BIN', '');
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('HARNAS_SKILL_NAVIGATOR', undefined);
  setEnv('PARLEY_CODE_MODE_LAUNCH', undefined);
  setEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude-config'));
});
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pending(provider: string) {
  const created = await createWork(project, { title: 'Code Mode', goal: 'launch decision' });
  const workId = created.work.id;
  const sessionId = await createPendingSession(project, workId, { provider, label: 'x', task: 'y' });
  const session = (await readMap(project, workId)).sessions.find((s) => s.id === sessionId)!;
  return { workId, session, dir: workPaths(project, workId).dir };
}

/** The nonce the launch handed its MCP server: from the Claude config file, or from Codex's `-c` env table. */
async function configNonce(plan: { args: readonly string[] }): Promise<string | null> {
  const at = plan.args.indexOf('--mcp-config');
  const text = at >= 0 ? await readFile(plan.args[at + 1]!, 'utf8') : plan.args.join('\n');
  const m = /PARLEY_CODE_MODE_LAUNCH[^0-9a-f]+([0-9a-f]{16,})/.exec(text);
  return m === null ? null : m[1]!;
}

describe('the launch writes its decision every time, and only a written replacement gets a nonce', () => {
  it.each(['claude', 'codex'])('%s, shipped gates: classic is written with its reason and no nonce, and the config carries none', async (provider) => {
    const { workId, session, dir } = await pending(provider);
    const plan = await planLaunch(project, workId, session, { agent: AGENT });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'provider-unproven', written: true });
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ kind: 'decision', decision: { effective: 'classic', reason: 'provider-unproven', nonce: null, requested: true, provider } });
    expect(await configNonce(plan)).toBeNull();
  });
  it('no agent channel: not-parley-launched, and no costly gate is asked', async () => {
    const { workId, session, dir } = await pending('claude');
    const helperAvailable = vi.fn(async () => true);
    const plan = await planLaunch(project, workId, session, { codeModeGates: { ...PASSING, helperAvailable } });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'not-parley-launched', written: true });
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { nonce: null, reason: 'not-parley-launched' } });
    expect(helperAvailable).not.toHaveBeenCalled();
  });
  it('the human turned it off: not-requested, and the gates are not asked', async () => {
    const { workId, session } = await pending('claude');
    const helperAvailable = vi.fn(async () => true);
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...PASSING, helperAvailable, requested: async () => false } });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'not-requested', written: true });
    expect(helperAvailable).not.toHaveBeenCalled();
  });
  it('the setting cannot be read: off, not-requested', async () => {
    const { workId, session } = await pending('claude');
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...PASSING, requested: async () => { throw new Error('x'); } } });
    expect(plan.codeModeDecision).toMatchObject({ reason: 'not-requested' });
  });
  it.each(['claude', 'codex'])('%s, every gate passing (test seam): replacement written, and the config carries exactly its nonce', async (provider) => {
    const { workId, session, dir } = await pending(provider);
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING });
    expect(plan.codeModeDecision).toEqual({ effective: 'replacement', reason: null, written: true });
    const read = readLaunchDecision(dir, session.id);
    expect(read).toMatchObject({ kind: 'decision', decision: { effective: 'replacement', reason: null, provider } });
    const nonce = (read as { decision: { nonce: string } }).decision.nonce;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await configNonce(plan)).toBe(nonce);
  });
  describe('the Claude row at launch (T12a-Claude C2a)', () => {
    // Every gate passes except the detector, which is the launch's own Claude scan. The env is cleaned of the dev shell's CLAUDE_* and
    // ANTHROPIC_* names; CLAUDE_CONFIG_DIR is the temp one beforeEach sets. The machine's managed layer is read as it is (absent here).
    const noDetector: CodeModeGateSeams = { proven: PASSING.proven!, clientVersionReviewed: PASSING.clientVersionReviewed!, helperAvailable: PASSING.helperAvailable!, requested: PASSING.requested! };
    const cleanEnv = (): void => {
      for (const name of Object.keys(process.env)) {
        const upper = name.toUpperCase();
        if ((upper.startsWith('CLAUDE_') || upper.startsWith('ANTHROPIC_')) && name !== 'CLAUDE_CONFIG_DIR') setEnv(name, undefined);
      }
    };
    const settingsArg = (args: readonly string[]): string => args[args.indexOf('--settings') + 1]!;

    it('clean: the scan is clear, and the decision records cwd, the config root and the --settings file by path and sha256 of what was written', async () => {
      cleanEnv();
      const { workId, session, dir } = await pending('claude');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: noDetector });
      expect(plan.codeModeDecision).toEqual({ effective: 'replacement', reason: null, written: true });
      const file = settingsArg(plan.args);
      const read = readLaunchDecision(dir, session.id) as { decision: Record<string, unknown> };
      expect(read.decision).toMatchObject({ v: 2, cwd: project, configRoot: process.env['CLAUDE_CONFIG_DIR'], settings: { path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') } });
      expect(read.decision).not.toHaveProperty('gitRoot');
    });
    it('the positive control (lead m-7563): from a host env of PATH and HOME only, the env the plan gives claude reads clear', async () => {
      cleanEnv();
      const { workId, session } = await pending('claude');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: noDetector });
      expect(Object.keys(plan.env).some((k) => k.startsWith('CLAUDE_'))).toBe(false);
      expect(claudeEnvVerdict({ PATH: '/usr/bin:/bin', HOME: home, ...plan.env })).toEqual({ kind: 'clear' });
    });
    it('a relocating variable in the launch env: classic uninspected-source:env (s-296 E1)', async () => {
      cleanEnv();
      setEnv('CLAUDE_CODE_MANAGED_SETTINGS_PATH', path.join(home, 'elsewhere.json'));
      const { workId, session, dir } = await pending('claude');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: noDetector });
      expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'uninspected-source:env', written: true });
      expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { nonce: null, cwd: project } });
    });
    it('a project deny on Parley: classic detector', async () => {
      cleanEnv();
      await mkdir(path.join(project, '.claude'), { recursive: true });
      await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp__parley__*'] } }));
      const { workId, session } = await pending('claude');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: noDetector });
      expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'detector', written: true });
    });
  });

  describe('the client the host probed (T12a-Claude C1)', () => {
    it('the host probes only for a proven provider with Code Mode requested; the proven check comes first, so nothing is read otherwise (s-292 B1)', async () => {
      let reads = 0;
      const requested = (answer: boolean) => async (): Promise<boolean> => { reads += 1; return answer; };
      expect(PROVEN_PROVIDERS).toEqual([]);
      expect(await wantsClientProbe('claude')).toBe(false);
      expect(await wantsClientProbe('claude', { requested: requested(true) })).toBe(false);
      expect(await wantsClientProbe('claude', { proven: ['codex'], requested: requested(true) })).toBe(false);
      expect(reads).toBe(0);
      expect(await wantsClientProbe('claude', { proven: ['claude'], requested: requested(false) })).toBe(false);
      expect(await wantsClientProbe('claude', { proven: ['claude'], requested: requested(true) })).toBe(true);
      expect(await wantsClientProbe('claude', { proven: ['claude'], requested: async () => { throw new Error('unreadable'); } })).toBe(false);
      expect(reads).toBe(2);
    });
    const withoutVersionSeam: CodeModeGateSeams = { proven: PASSING.proven!, helperAvailable: PASSING.helperAvailable!, detector: PASSING.detector!, requested: PASSING.requested! };
    const client = { path: '/opt/claude/versions/x', version: REVIEWED_CLAUDE_VERSIONS[0]!, inode: '42' };
    it('a reviewed version answers the gate, and the decision (v2) records the client', async () => {
      const { workId, session, dir } = await pending('claude');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...withoutVersionSeam, client: { ok: true, client } } });
      expect(plan.codeModeDecision).toEqual({ effective: 'replacement', reason: null, written: true });
      expect(readLaunchDecision(dir, session.id)).toMatchObject({ kind: 'decision', decision: { v: 2, effective: 'replacement', client } });
    });
    it('an unreviewed version: classic client-version, and the client is still recorded', async () => {
      const { workId, session, dir } = await pending('claude');
      const other = { ...client, version: '9.9.9' };
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...withoutVersionSeam, client: { ok: true, client: other } } });
      expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'client-version', written: true });
      expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { v: 2, nonce: null, client: other } });
    });
    it('GLM runs `claude` too: a reviewed claude probe and a proven seam with glm still end classic client-version, with no client (s-296 G1)', async () => {
      const { workId, session, dir } = await pending('glm');
      const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...withoutVersionSeam, proven: ['glm'], client: { ok: true, client } } });
      expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'client-version', written: true });
      const read = readLaunchDecision(dir, session.id) as { decision: Record<string, unknown> };
      expect(read.decision).toMatchObject({ v: 2, provider: 'glm', nonce: null });
      expect(read.decision).not.toHaveProperty('client');
    });
    it('a failed probe, or none: classic client-version, and no client recorded', async () => {
      for (const gates of [{ ...withoutVersionSeam, client: { ok: false as const, reason: 'no-version' as const } }, withoutVersionSeam]) {
        const { workId, session, dir } = await pending('claude');
        const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: gates });
        expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'client-version', written: true });
        const read = readLaunchDecision(dir, session.id) as { decision: Record<string, unknown> };
        expect(read.decision['v']).toBe(2);
        expect(read.decision).not.toHaveProperty('client');
      }
    });
  });

  it('the plan renders the bootstrap only when its own nonce is the one on disk after the write (s-296 m-7184)', async () => {
    const { replacementRouting } = await import('./code-mode-instructions.js');
    const BOOT = bootstrapText(replacementRouting());
    const onDisk = (dir: string, id: string): string | null => {
      const read = readLaunchDecision(dir, id);
      return read.kind === 'decision' ? read.decision.nonce : null;
    };
    // Written: the layer carries the bootstrap, and the config's nonce is the one on disk.
    const a = await pending('claude');
    const ok = await planLaunch(project, a.workId, a.session, { agent: AGENT, codeModeGates: PASSING });
    expect(ok.args.join('\n')).toContain(BOOT);
    expect(await configNonce(ok)).toBe(onDisk(a.dir, a.session.id));
    expect(onDisk(a.dir, a.session.id)).not.toBeNull();
    // Not written: no bootstrap, no nonce in the config, none on disk.
    const b = await pending('claude');
    await mkdir(path.join(b.dir, 'code-mode'), { recursive: true, mode: 0o700 });
    await chmod(path.join(b.dir, 'code-mode'), 0o700);
    await mkdir(path.join(launchDecisionPath(b.dir, b.session.id), 'x'), { recursive: true });
    const failed = await planLaunch(project, b.workId, b.session, { agent: AGENT, codeModeGates: PASSING });
    expect(failed.args.join('\n')).not.toContain(BOOT);
    expect(await configNonce(failed)).toBeNull();
    expect(onDisk(b.dir, b.session.id)).toBeNull();
  });
  it('a relaunch writes a new decision: the old nonce stops matching', async () => {
    const { workId, session, dir } = await pending('claude');
    await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING });
    const first = (readLaunchDecision(dir, session.id) as { decision: { nonce: string } }).decision.nonce;
    await planLaunch(project, workId, session, { agent: AGENT });
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { effective: 'classic', nonce: null } });
    await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING });
    expect((readLaunchDecision(dir, session.id) as { decision: { nonce: string } }).decision.nonce).not.toBe(first);
  });
  it('the decision cannot be written: classic decision-write-failed, and no nonce reaches the config', async () => {
    const { workId, session, dir } = await pending('claude');
    // A non-empty directory at the decision path: the directory passes the rules (a looser one would make the run record unreadable,
    // which is held-run), and the rename itself fails, for the replacement and for the classic fallback alike.
    await mkdir(path.join(dir, 'code-mode'), { recursive: true, mode: 0o700 });
    await chmod(path.join(dir, 'code-mode'), 0o700);
    await mkdir(path.join(launchDecisionPath(dir, session.id), 'x'), { recursive: true });
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'decision-write-failed', written: false });
    expect(await configNonce(plan)).toBeNull();
    expect(readLaunchDecision(dir, session.id).kind).not.toBe('decision');
  });
  it('a refusing detector, through the seam: uninspected-source with its class, classic, no nonce', async () => {
    const { workId, session, dir } = await pending('claude');
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...PASSING, detector: async () => ({ kind: 'uninspected', sourceClass: 'nested-claude' }) } });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'uninspected-source:nested-claude', written: true });
    expect(await configNonce(plan)).toBeNull();
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { reason: 'uninspected-source:nested-claude', nonce: null } });
  });
  it.each([
    ['claude', 'clone'], ['claude', 'artifacts'], ['codex', 'clone'], ['codex', 'artifacts'],
  ] as const)('%s, a confined %s workspace: confined-attempt, even with every other gate passing', async (provider, kind) => {
    const { workId, session, dir } = await pending(provider);
    const workspace = kind === 'clone' ? { kind, path: project, branch: 'b', sha: 'a'.repeat(40) } : { kind, path: project };
    const helperAvailable = vi.fn(async () => true);
    const plan = await planLaunch(project, workId, { ...session, workspace }, { agent: AGENT, codeModeGates: { ...PASSING, helperAvailable } });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'confined-attempt', written: true });
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { reason: 'confined-attempt', nonce: null } });
    expect(await configNonce(plan)).toBeNull();
    expect(helperAvailable).not.toHaveBeenCalled();
  });
  it('a held run of reads in this session: classic held-run with the held routing, no nonce, and no gate asked', async () => {
    const { workId, session, dir } = await pending('claude');
    const store = createRunRecordStore({ workDir: dir, sessionId: session.id, launchId: 'l' });
    expect(store.open('run-1').ok).toBe(true);
    expect(store.intent('run-1', 1, 'get_map', 'a'.repeat(64))).toBe(true);
    const helperAvailable = vi.fn(async () => true);
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: { ...PASSING, helperAvailable } });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'held-run', written: true });
    // The held routing reaches the layer: its line says the earlier run may still be finishing (the holder here is this live process).
    expect(plan.args.join('\n')).toContain(bootstrapText(heldRunRouting('may-be-finishing')));
    expect(await configNonce(plan)).toBeNull();
    expect(helperAvailable).not.toHaveBeenCalled();
  });
  it('a held run naming a non-read method: the launch is blocked and nothing starts; the decision says classic with no nonce', async () => {
    const { workId, session, dir } = await pending('claude');
    const store = createRunRecordStore({ workDir: dir, sessionId: session.id, launchId: 'l' });
    expect(store.open('run-1').ok).toBe(true);
    expect(store.intent('run-1', 1, 'send_message', 'a'.repeat(64))).toBe(true);
    await expect(planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING })).rejects.toThrow('code-mode-blocked: non-read-record');
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { effective: 'classic', reason: 'non-read-record', nonce: null } });
  });
  it.each(['fixture_read', 'new_tool'])('a held run naming %s, a method this build does not allow as a read (a downgrade, or a record from a restored R batch): blocked, never classic', async (method) => {
    const { workId, session, dir } = await pending('claude');
    const store = createRunRecordStore({ workDir: dir, sessionId: session.id, launchId: 'l' });
    expect(store.open('run-1').ok).toBe(true);
    expect(store.intent('run-1', 1, method, 'a'.repeat(64))).toBe(true);
    await expect(planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING })).rejects.toThrow('code-mode-blocked: non-read-record');
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { effective: 'classic', reason: 'non-read-record', nonce: null } });
  });
  it('a runner whose template cannot carry the bootstrap: instructions-undeliverable, classic, and the launch still starts', async () => {
    const { workId, session, dir } = await pending('codex');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: { args: ['CUSTOM', '{mcpConfig}', '{prompt}'] } }));
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeModeGates: PASSING });
    expect(plan.codeModeDecision).toEqual({ effective: 'classic', reason: 'instructions-undeliverable', written: true });
    expect(plan.args[0]).toBe('CUSTOM');
    expect(readLaunchDecision(dir, session.id)).toMatchObject({ decision: { reason: 'instructions-undeliverable', nonce: null } });
  });
  it('the render-only seam `codeMode` never writes a nonce: a fixture route cannot reach a replacement server', async () => {
    const { workId, session } = await pending('claude');
    const { fixtureRouting } = await import('./code-mode-instructions.js');
    const { MIGRATION_REGISTRY } = await import('../mcp/code-mode/migration-registry.js');
    const migrated = MIGRATION_REGISTRY.entries.filter((e) => e.cohort).map((e) => e.name);
    const plan = await planLaunch(project, workId, session, { agent: AGENT, codeMode: fixtureRouting(migrated) }).catch((e: Error) => e);
    if (plan instanceof Error) {
      // A fixture route may be refused by the bootstrap check; then nothing launches at all.
      expect(plan.message).toMatch(/code-mode/);
      return;
    }
    expect(await configNonce(plan)).toBeNull();
  });
});
