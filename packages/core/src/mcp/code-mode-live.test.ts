// The live path of a session process (plan T12a slice C1): the live proof, the live mint, the gate's recheck, the broker refusing before
// its lease, the live backend and its memo. PROVEN is empty in the product; this file patches the table at load, as T8h's tests do, and
// adds a fixture provider row, so the live path can be reached at all. Nothing here reaches a real host.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const table = vi.hoisted(() => ({ proven: ['fixture-proven'] as string[], rows: {} as Record<string, () => readonly unknown[]> }));
vi.mock('./code-mode/proven.js', () => ({ PROVEN_PROVIDERS: table.proven }));
vi.mock('./code-mode/provider-rows.js', () => ({
  PROVIDER_ROWS: table.rows,
  providerSourceClasses: (provider: string) => (Object.hasOwn(table.rows, provider) ? table.rows[provider]!() : null),
}));

const NP = await import('./code-mode/native-policy.js');
const { createDetector, createLiveSource } = await import('./code-mode/detector.js');
const { createBroker, nativePolicyReason } = await import('./code-mode/broker.js');
const { buildCatalog } = await import('./code-mode/catalog.js');
const { writeLaunchDecision } = await import('./code-mode/launch-decision.js');
const { BackendRetry, createCodeModeSurface, launchProvider, liveBackend, replacementSurfaceFactory } = await import('./code-mode-tools.js');
const { TOOLS } = await import('./tools.js');

const AGENT = { url: 'http://127.0.0.1:9/agent/browser', token: 'ab'.repeat(32) };
const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
let dir: string;
let config: string;
const savedHome = process.env['PARLEY_HOME'];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'parley-t12a-live-'));
  roots.push(dir);
  config = path.join(dir, 'config.json');
  writeFileSync(config, '{"codeMode":true}');
  process.env['PARLEY_HOME'] = dir;
  table.proven.splice(0, table.proven.length, 'fixture-proven');
  for (const k of Object.keys(table.rows)) delete table.rows[k];
  table.rows['fixture-proven'] = () => [];
});
afterEach(() => { if (savedHome === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = savedHome; });

const catalog = buildCatalog(TOOLS as Tool[]);

describe('the live proof and the live mint', () => {
  it('only a proven provider id, as a string, gets a proof; it is frozen and one-use', () => {
    const proof = NP.resolveLiveNativePolicy('fixture-proven');
    expect(proof).toEqual({ available: true, provider: 'fixture-proven' });
    expect(Object.isFrozen(proof)).toBe(true);
    for (const other of ['claude', 'codex', { provider: 'fixture-proven' }, undefined, null]) expect(NP.resolveLiveNativePolicy(other)).toBe(NP.LIVE_POLICY_UNAVAILABLE);
    const d = createDetector({ classes: [], configFile: config });
    expect(createLiveSource(proof, d)).toMatchObject({ authority: 'live' });
    expect(() => createLiveSource(proof, d)).toThrow(new NP.NativePolicyError('invalid-source'));
  });
  it('a hand-built or copied proof mints nothing', () => {
    const d = createDetector({ classes: [], configFile: config });
    for (const fake of [{ available: true, provider: 'fixture-proven' }, { ...NP.resolveLiveNativePolicy('fixture-proven') }, null, 'fixture-proven']) {
      expect(() => createLiveSource(fake, d)).toThrow(new NP.NativePolicyError('invalid-source'));
    }
  });
  it('with PROVEN empty, nothing gets a proof', () => {
    table.proven.splice(0);
    expect(NP.resolveLiveNativePolicy('fixture-proven')).toBe(NP.LIVE_POLICY_UNAVAILABLE);
  });
});

const liveGate = () => NP.openPolicyGate(createLiveSource(NP.resolveLiveNativePolicy('fixture-proven'), createDetector({ classes: table.rows['fixture-proven']?.() as never ?? null, configFile: config })), catalog, { launchId: 'live-launch-1' });

describe('the gate over a live source', () => {
  it('opens clear, with live authority', () => {
    const gate = liveGate();
    expect(gate.launch.authority).toBe('live');
    expect(gate.recheck()).toBeNull();
    expect(gate.decide('get_map', {})).toMatchObject({ authority: 'live', state: 'allow' });
  });
  it('classifies at open: a dirty state never becomes the baseline (human off, or no provider row)', () => {
    writeFileSync(config, '{"codeMode":false}');
    expect(() => liveGate()).toThrow(new NP.NativePolicyError('source-unavailable'));
    writeFileSync(config, '{"codeMode":true}');
    delete table.rows['fixture-proven'];
    expect(() => liveGate()).toThrow(new NP.NativePolicyError('source-unavailable'));
  });
  it('recheck: the human\'s off mid-session revokes, latched even after on again', async () => {
    const gate = liveGate();
    await Promise.resolve();
    writeFileSync(config, '{"codeMode":false}');
    expect(gate.recheck()).toBe('revoked');
    writeFileSync(config, '{"codeMode":true}');
    await Promise.resolve();
    expect(gate.recheck()).toBe('revoked');
    expect(gate.decide('get_map', {}).state).toBe('revoked');
  });
  it('a benign config edit keeps the gate open: the revision is constant while clear', async () => {
    const gate = liveGate();
    await Promise.resolve();
    writeFileSync(config, '{"codeMode":true,"fontSize":15}');
    expect(gate.recheck()).toBeNull();
  });
});

describe('the broker refuses before its lease (B2)', () => {
  const broker = () => createBroker({
    source: createLiveSource(NP.resolveLiveNativePolicy('fixture-proven'), createDetector({ classes: [], configFile: config })),
    catalog, launchId: 'live-launch-1', agent: AGENT, launch: {}, hold: { workDir: dir, sessionId: 's-1' },
  });
  it('human off before a run with no call: refused, nothing spawned, no host call', async () => {
    const b = broker();
    await Promise.resolve();
    writeFileSync(config, '{"codeMode":false}');
    const r = await b.run('return 1', b.launch.apiRevision);
    expect(r).toMatchObject({ status: 'unavailable', reason: nativePolicyReason('revoked'), spawned: false, hostCalls: 0, runId: null });
  });
});

describe('the live backend', () => {
  const context = (over: Record<string, unknown> = {}) => ({ projectPath: dir, workDir: dir, sessionId: 's-1', agent: AGENT, codeModeLaunch: 'a'.repeat(32), ...over }) as never;
  const decide = (provider: string, nonce: string | null, effective: 'replacement' | 'classic' = 'replacement') =>
    writeLaunchDecision(dir, 's-1', { v: 1, nonce, effective, requested: true, reason: effective === 'classic' ? 'provider-unproven' : null, provider, at: new Date(0).toISOString() });

  it('the provider comes from this launch\'s own decision, only with this process\'s nonce', () => {
    expect(decide('fixture-proven', 'a'.repeat(32))).toBe(true);
    expect(launchProvider(context())).toBe('fixture-proven');
    expect(launchProvider(context({ codeModeLaunch: 'b'.repeat(32) }))).toBeNull();
    expect(launchProvider(context({ codeModeLaunch: undefined }))).toBeNull();
    decide('fixture-proven', null, 'classic');
    expect(launchProvider(context())).toBeNull();
  });
  it('a proven provider with a clear row: a broker with live authority', async () => {
    decide('fixture-proven', 'a'.repeat(32));
    const b = await liveBackend(catalog, 'live-launch-1', context());
    expect(b.broker?.launch.authority).toBe('live');
  });
  it('an unproven provider: no broker', async () => {
    decide('claude', 'a'.repeat(32));
    expect((await liveBackend(catalog, 'live-launch-1', context())).broker).toBeNull();
  });
  it('a proven provider with no row: the gate refuses at open, so building throws (final)', async () => {
    decide('fixture-proven', 'a'.repeat(32));
    delete table.rows['fixture-proven'];
    await expect(liveBackend(catalog, 'live-launch-1', context())).rejects.toThrow('source-unavailable');
  });
  it('the detector reads this home\'s config.json: the human\'s off refuses the broker at open (final)', async () => {
    decide('fixture-proven', 'a'.repeat(32));
    writeFileSync(config, '{"codeMode":false}');
    await expect(liveBackend(catalog, 'live-launch-1', context())).rejects.toThrow('source-unavailable');
  });
  it('a classic decision never names the provider, even one carrying this process\'s nonce', () => {
    expect(decide('fixture-proven', 'a'.repeat(32), 'classic')).toBe(true);
    expect(launchProvider(context())).toBeNull();
  });
  it('no agent channel: throws, never a broker without one', async () => {
    decide('fixture-proven', 'a'.repeat(32));
    await expect(liveBackend(catalog, 'live-launch-1', context({ agent: undefined }))).rejects.toThrow('agent channel');
  });
});

describe('the memo (§6.3)', () => {
  const unavailable = async (s: ReturnType<typeof createCodeModeSurface>) => JSON.stringify((await s.call('code_search', { query: 'map' })).content).includes('not available');
  it('a list that could not be read is not final: the next call tries again, and succeeds', async () => {
    let calls = 0;
    const s = createCodeModeSurface({ backend: async () => { calls++; if (calls === 1) throw new BackendRetry(); return { catalog, launchId: 'l', broker: null }; } });
    expect(await unavailable(s)).toBe(true);
    expect(await unavailable(s)).toBe(false);
    expect(await unavailable(s)).toBe(false);
    expect(calls).toBe(2);
  });
  it('through the replacement surface: a list that fails to read is retried, not final', async () => {
    let lists = 0;
    const surface = replacementSurfaceFactory({ projectPath: dir, workDir: dir, sessionId: null, channel: false, codeModeExposure: 'replacement' } as never)(async () => {
      lists++;
      if (lists === 1) throw new Error('host not responding');
      return TOOLS as Tool[];
    });
    expect(await unavailable(surface)).toBe(true);
    expect(await unavailable(surface)).toBe(false);
    expect(lists).toBe(2);
  });
  it('two calls during one failing attempt share it; one retry follows', async () => {
    let calls = 0;
    const s = createCodeModeSurface({ backend: async () => { calls++; await Promise.resolve(); if (calls === 1) throw new BackendRetry(); return { catalog, launchId: 'l', broker: null }; } });
    await Promise.all([s.call('code_search', { query: 'map' }), s.call('code_search', { query: 'map' })]);
    expect(calls).toBe(1);
    await s.call('code_search', { query: 'map' });
    expect(calls).toBe(2);
  });
  it('any other failure is final: integrity, never retried', async () => {
    let calls = 0;
    const s = createCodeModeSurface({ backend: async () => { calls++; throw new Error('registry'); } });
    expect(await unavailable(s)).toBe(true);
    expect(await unavailable(s)).toBe(true);
    expect(calls).toBe(1);
  });
});
