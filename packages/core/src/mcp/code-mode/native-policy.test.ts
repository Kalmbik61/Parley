import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { buildCatalog, canonicalSha256, sha256 } from './catalog.js';
import { ContractError, admitCall, computeApiRevision } from './contracts.js';
import { FIXTURE_HOST, type FixtureRule, createFixturePolicySource } from '../../../../../tests/fixtures/code-mode/native-policy.js';
import { RUN_LIMITS } from './limits.js';
import * as NP from './native-policy.js';
import { LIVE_POLICY_UNAVAILABLE, NativePolicyError, POLICY_STATES, type PolicyState, claimFixtureSourceMint, openPolicyGate, resolveLiveNativePolicy } from './native-policy.js';
import { RunLedger } from './scheduler.js';
import { ARG_LIMITS, canonicalStrict } from './validation.js';

const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
const catalog = buildCatalog(TOOLS);
const DOCUMENTED = catalog.entries.filter((e) => e.documented).map((e) => e.name).sort();
/** The expected effective snapshot and apiRevision, computed independently of the gate. */
const snapshotOf = (sourceId = 'fixture-policy', policyRevision = 'fixture-rev-1', methods: readonly string[] = DOCUMENTED) => `np1.${canonicalSha256({ sourceId, policyRevision, methods })}`;
const revOf = (launch: string, sourceId?: string, policyRevision?: string, methods?: readonly string[]) => computeApiRevision({ catalog, launch, policySnapshot: snapshotOf(sourceId, policyRevision, methods) });
const REV = revOf('fixture-launch-1');
const allow: FixtureRule = () => 'allow';

/** A fixture host that counts dispatches; the test dispatches only through `dispatch`, and only on an ok authorization. */
function harness(rule: FixtureRule, manifest?: readonly string[]) {
  const fake = createFixturePolicySource(FIXTURE_HOST, rule);
  const gate = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-1', ...(manifest ? { manifest } : {}) });
  const host: string[] = [];
  const dispatch = (decision: unknown, method: unknown, args: unknown) => {
    const a = gate.authorize(decision, method, args);
    if (a.ok) host.push(`${a.method} ${a.argsText}`);
    return a;
  };
  return { fake, gate, host, dispatch };
}

describe('live launches have no native-policy authority (design §5.1, until T12a)', () => {
  it('every input, the fixture identity and a fixture source included, resolves to unavailable without being read', () => {
    let reads = 0;
    const hostile = new Proxy({}, { get: () => { reads++; return 'allow'; }, has: () => { reads++; return true; }, ownKeys: () => { reads++; return []; } });
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const inputs: unknown[] = [
      undefined, null, 'fixture', 'acct-fixture', { provider: 'claude', account: 'fixture' }, { provider: 'fixture', transport: 'fixture' },
      { env: { PARLEY_CODE_MODE_FIXTURE: '1', PARLEY_NATIVE_POLICY: 'allow' } }, { manifest: { get_map: 'allow' } }, { wrapperApproved: true },
      { nativePolicy: 'allow', apiKey: SECRET }, JSON.parse('{"source":{"sourceId":"fixture-policy","authority":"fixture"}}'),
      FIXTURE_HOST, fake.source, fake, hostile,
    ];
    for (const input of inputs) expect(resolveLiveNativePolicy(input)).toBe(LIVE_POLICY_UNAVAILABLE);
    expect(LIVE_POLICY_UNAVAILABLE).toEqual({ available: false, reason: 'native-policy-unproven', fallback: 'classic' });
    expect(Object.isFrozen(LIVE_POLICY_UNAVAILABLE)).toBe(true);
    expect(reads).toBe(0);
    expect(fake.queries).toHaveLength(0);
  });

  it('environment flags change nothing: attempted fake-to-live selection yields zero calls', () => {
    const keys = ['PARLEY_CODE_MODE_FIXTURE', 'PARLEY_NATIVE_POLICY', 'PARLEY_CODE_MODE', 'PARLEY_FIXTURE_HOST'];
    const saved = keys.map((k) => process.env[k]);
    const hostCalls: string[] = [];
    try {
      for (const k of keys) process.env[k] = k === 'PARLEY_NATIVE_POLICY' ? 'allow' : '1';
      // A "live" route: only an available policy could lead to a host call; there is none.
      for (const launch of [{ account: 'fixture' }, { provider: 'fixture' }, { manifest: ['get_map'] }, { wrapperApproved: true }, FIXTURE_HOST]) {
        const live = resolveLiveNativePolicy(launch) as { available: boolean };
        if (live.available) hostCalls.push('get_map');
      }
      // Look-alike sources from configuration, accounts or JSON cannot open a gate either.
      for (const s of ['fixture-policy', 'acct-fixture', { sourceId: 'fixture-policy', authority: 'fixture' }, JSON.parse('{"sourceId":"fixture-policy","authority":"fixture"}'), FIXTURE_HOST, null]) {
        expect(() => openPolicyGate(s as never, catalog, { launchId: 'fixture-launch-1' })).toThrow(new NativePolicyError('invalid-source'));
      }
    } finally {
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
    expect(hostCalls).toEqual([]);
  });

  it('a fake source needs the synthetic fixture host object; strings, account ids, JSON and symbols are refused', () => {
    for (const id of ['fixture', 'FIXTURE_HOST', 'acct-1', 'fixture-launch-1', {}, Object.create(null), JSON.parse('{"fixture":true}'), Symbol.for('parley.fixture'), Symbol('FIXTURE_HOST'), { ...FIXTURE_HOST }, undefined]) {
      expect(() => createFixturePolicySource(id, allow)).toThrow('a synthetic fixture host identity is required');
    }
    expect(Object.isFrozen(FIXTURE_HOST)).toBe(true);
  });

  it('the module surface: the fixture mint is already claimed, and the live mint (T12a) takes nothing but a proof, which PROVEN, empty, never issues', () => {
    expect(Object.keys(NP).sort()).toEqual(['LIVE_POLICY_UNAVAILABLE', 'NativePolicyError', 'POLICY_STATES', 'claimFixtureSourceMint', 'mintLiveSource', 'openPolicyGate', 'resolveLiveNativePolicy']);
    expect(() => claimFixtureSourceMint()).toThrow(new NativePolicyError('mint-claimed'));
    for (const proof of [LIVE_POLICY_UNAVAILABLE, resolveLiveNativePolicy('claude'), resolveLiveNativePolicy('codex'), { available: true, provider: 'claude' }, FIXTURE_HOST, null]) {
      expect(() => NP.mintLiveSource(proof, 'live-detector', { revision: () => 'r', decide: () => 'allow' })).toThrow(new NativePolicyError('invalid-source'));
    }
  });
});

describe('fixture gate: the six states (plan T5a)', () => {
  it.each(POLICY_STATES)('%s: only allow dispatches; every other state is zero calls and a classic fallback', (state) => {
    const h = harness(() => state);
    const d = h.gate.decide('get_map', {});
    expect(d).toMatchObject({ launchId: 'fixture-launch-1', apiRevision: REV, sourceId: 'fixture-policy', authority: 'fixture', policyRevision: 'fixture-rev-1', method: 'get_map', state });
    expect(Object.isFrozen(d)).toBe(true);
    const a = h.dispatch(d, 'get_map', {});
    if (state === 'allow') {
      expect(a).toMatchObject({ ok: true, method: 'get_map', argsText: '{}', argsSha256: sha256('{}') });
      expect(h.host).toEqual(['get_map {}']);
    } else {
      expect(a).toEqual({ ok: false, reason: state, fallback: 'classic' });
      expect(h.host).toEqual([]);
    }
  });

  it('a source answer that is not exactly a state, or a throw, is unknown', () => {
    const answers: unknown[] = ['ALLOW', 'allow ', { state: 'allow' }, ['allow'], new String('allow'), true, 1, null, undefined, Symbol('allow')];
    for (const v of answers) {
      const h = harness(() => v);
      const d = h.gate.decide('get_map', {});
      expect(d.state, String(v)).toBe('unknown');
      expect(h.dispatch(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'unknown' });
      expect(h.host).toEqual([]);
    }
    const h = harness(() => { throw new Error(SECRET); });
    const d = h.gate.decide('get_map', {});
    expect(d.state).toBe('unknown');
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(h.dispatch(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'unknown' });
    expect(h.host).toEqual([]);
  });

  it('a manifest only narrows: an absent method is deny, a source deny stays deny, an unknown name grants nothing', () => {
    const h = harness((q) => (q.method === 'read_guide' ? 'deny' : 'allow'), ['get_map', 'read_guide', 'create_session', 'report']);
    expect(h.gate.launch.methods).toEqual(['get_map', 'read_guide']);
    const room = h.gate.decide('read_room', { room: 'r-1' });
    expect(room.state).toBe('deny');
    expect(h.dispatch(room, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'deny' });
    expect(h.gate.decide('read_guide', {}).state).toBe('deny');
    expect(() => h.gate.decide('create_session', {})).toThrow(ContractError);
    expect(() => h.gate.decide('report', {})).toThrow(ContractError);
    const map = h.gate.decide('get_map', {});
    expect(h.dispatch(map, 'get_map', {}).ok).toBe(true);
    expect(h.host).toEqual(['get_map {}']);
    // The source is never asked about a method outside the manifest.
    expect(h.fake.queries.map((q) => q.method)).toEqual(['read_guide', 'get_map', 'get_map']);
  });

  it('there is no wrapper-approval input: an outer approval cannot turn ask into allow', () => {
    const h = harness(() => 'ask');
    const d = h.gate.decide('get_map', {});
    const a = (h.gate.authorize as (...x: unknown[]) => NP.DispatchAuthorization)(d, 'get_map', {}, { wrapperApproved: true, approval: 'allow' });
    expect(a).toMatchObject({ ok: false, reason: 'ask' });
    expect(h.host).toEqual([]);
  });

  it('calls the genuine handle does not admit get no decision', () => {
    const h = harness(allow);
    expect(() => h.gate.decide('create_session', {})).toThrow(new ContractError('unknown-method'));
    expect(() => h.gate.decide('constructor', {})).toThrow(new ContractError('unknown-method'));
    expect(() => h.gate.decide('read_room', { room: 1 })).toThrow(ContractError);
    expect(() => h.gate.decide('read_room', { room: 'r-1', limit: SECRET })).toThrow(ContractError);
    expect(h.gate.status()).toMatchObject({ decisions: 0, authorized: 0 });
    expect(h.fake.queries).toHaveLength(0);
  });
});

describe('fixture gate: argument-dependent decisions and exact call binding', () => {
  const byRoom: FixtureRule = (q) => (q.method === 'read_room' && (q.args as { room: string }).room === 'r-secret' ? 'deny' : 'allow');

  it('the same method gets different decisions for different arguments; the source sees the canonical validated call', () => {
    const h = harness(byRoom);
    const open = h.gate.decide('read_room', { room: 'r-1', limit: 5 });
    const closed = h.gate.decide('read_room', { room: 'r-secret' });
    expect([open.state, closed.state]).toEqual(['allow', 'deny']);
    const canonical = sha256(canonicalStrict({ limit: 5, room: 'r-1' }, ARG_LIMITS));
    expect(open.argsSha256).toBe(canonical);
    expect(h.fake.queries[0]).toEqual({ launchId: 'fixture-launch-1', policyRevision: 'fixture-rev-1', method: 'read_room', args: { room: 'r-1', limit: 5 }, argsSha256: canonical });
    expect(Object.isFrozen(h.fake.queries[0]!.args)).toBe(true);
    expect(h.dispatch(closed, 'read_room', { room: 'r-secret' })).toMatchObject({ ok: false, reason: 'deny' });
    // Key order does not change the call identity; the dispatched text is the validated text of this call.
    expect(h.dispatch(open, 'read_room', { limit: 5, room: 'r-1' })).toMatchObject({ ok: true, argsText: '{"limit":5,"room":"r-1"}', argsSha256: canonical });
    expect(h.host).toEqual(['read_room {"limit":5,"room":"r-1"}']);
  });

  it('an allow decision cannot be spent on other arguments, another method or invalid arguments', () => {
    const h = harness(byRoom);
    const cases: [unknown, unknown][] = [['read_room', { room: 'r-secret' }], ['read_room', { room: 'r-1', limit: 6 }], ['get_map', {}], ['read_room', { room: 2 }], ['create_session', { room: 'r-1' }], [{ toString: () => 'read_room' }, { room: 'r-1' }]];
    for (const [method, args] of cases) {
      const d = h.gate.decide('read_room', { room: 'r-1' });
      expect(d.state).toBe('allow');
      expect(h.dispatch(d, method, args)).toEqual({ ok: false, reason: 'mismatch', fallback: 'classic' });
    }
    expect(h.host).toEqual([]);
    // Same arguments, another method: the decision names its method, not only its argument hash.
    const getMap = h.gate.decide('get_map', {});
    expect(getMap.state).toBe('allow');
    expect(h.dispatch(getMap, 'list_roles', {})).toEqual({ ok: false, reason: 'mismatch', fallback: 'classic' });
    expect(h.host).toEqual([]);
    // The rejected attempt consumed the decision: it cannot be retried with the right call.
    const d = h.gate.decide('read_room', { room: 'r-1' });
    expect(h.dispatch(d, 'get_map', {}).ok).toBe(false);
    expect(h.dispatch(d, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'consumed' });
    expect(h.host).toEqual([]);
  });
});

describe('fixture gate: forged, mutated and mismatched decisions are never consumed as allow', () => {
  it('copies, clones, proxies, prototypes and JSON look-alikes are forged', () => {
    const h = harness(allow);
    const d = h.gate.decide('get_map', {});
    const lookAlikes: unknown[] = [{ ...d }, JSON.parse(JSON.stringify(d)), structuredClone(d), Object.create(d), new Proxy(d, {}), { ...d, state: 'allow' }, Object.assign(Object.create(null), d), null, 'allow', undefined];
    for (const f of lookAlikes) expect(h.dispatch(f, 'get_map', {})).toEqual({ ok: false, reason: 'forged', fallback: 'classic' });
    expect(h.host).toEqual([]);
    // The genuine one still works once.
    expect(h.dispatch(d, 'get_map', {}).ok).toBe(true);
    expect(h.host).toHaveLength(1);
  });

  it('a decision cannot be mutated into allow', () => {
    const h = harness(() => 'deny');
    const d = h.gate.decide('get_map', {}) as { state: PolicyState; argsSha256: string };
    expect(() => { d.state = 'allow'; }).toThrow(TypeError);
    expect(() => Object.defineProperty(d, 'state', { value: 'allow' })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(d, { state: 'allow' })).toThrow(TypeError);
    expect(d.state).toBe('deny');
    expect(h.dispatch(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'deny' });
    expect(h.host).toEqual([]);
  });

  it('a decision of another gate is a mismatch, even for the same source, launch id and call', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const g1 = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-1' });
    const g2 = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-1' });
    const g3 = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-2' });
    const d1 = g1.decide('get_map', {});
    expect(g2.authorize(d1, 'get_map', {})).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(g3.authorize(d1, 'get_map', {})).toMatchObject({ ok: false, reason: 'mismatch' });
    // A refusal by another gate does not spend d1 with its own gate.
    expect(g1.authorize(d1, 'get_map', {}).ok).toBe(true);
    expect(g1.authorize(d1, 'get_map', {})).toMatchObject({ ok: false, reason: 'consumed' });
  });

  it('a gate opens only on a minted source, a catalogue and a valid launch id', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    expect(() => openPolicyGate({ ...fake.source }, catalog, { launchId: 'fixture-launch-1' })).toThrow(new NativePolicyError('invalid-source'));
    for (const launchId of ['', 'has space', 'x'.repeat(129), 7, undefined]) {
      expect(() => openPolicyGate(fake.source, catalog, { launchId } as never)).toThrow(new NativePolicyError('invalid-launch'));
    }
    expect(() => openPolicyGate(fake.source, catalog, { launchId: 'l-1', manifest: 'get_map' as never })).toThrow(new NativePolicyError('invalid-launch'));
    for (const bad of [null, {}, { revision: 'x', entries: 7 }, 'catalog']) {
      expect(() => openPolicyGate(fake.source, bad as never, { launchId: 'l-1' })).toThrow(new NativePolicyError('invalid-launch'));
    }
    expect(fake.queries).toHaveLength(0);
  });

  it('one launch identity: the gate computes its apiRevision from the catalogue, its launch id and the policy revision, and owns the handle', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const a = openPolicyGate(fake.source, catalog, { launchId: 'launch-A' });
    const b = openPolicyGate(fake.source, catalog, { launchId: 'launch-B' });
    const revA = revOf('launch-A');
    const revB = revOf('launch-B');
    expect([a.launch.apiRevision, a.validators.apiRevision, b.launch.apiRevision, b.validators.apiRevision]).toEqual([revA, revA, revB, revB]);
    expect(revA).not.toBe(revB);
    // The gate's handle is genuine (admission works) and is bound to its own launch: a revision computed for A is stale on B.
    expect(admitCall(a.validators, revA, 'get_map', {}).method).toBe('get_map');
    expect(() => admitCall(b.validators, revA, 'get_map', {})).toThrow(expect.objectContaining({ code: 'stale-revision' }));
    // A handle's methods are the catalogue's documented ones; the policy revision is part of the API identity too.
    expect(a.validators.methods).toEqual(catalog.entries.filter((e) => e.documented).map((e) => e.name).sort());
    expect(revOf('launch-A', 'fixture-policy', 'fixture-rev-2')).not.toBe(revA);
    // Same launch works; B's decision names B and is refused by A.
    const dA = a.decide('get_map', {});
    const dB = b.decide('get_map', {});
    expect([dA.launchId, dA.apiRevision, dB.launchId, dB.apiRevision]).toEqual(['launch-A', revA, 'launch-B', revB]);
    expect(a.authorize(dB, 'get_map', {})).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(a.authorize(dA, 'get_map', {})).toMatchObject({ ok: true, argsText: '{}' });
    expect(b.authorize(dB, 'get_map', {})).toMatchObject({ ok: true, argsText: '{}' });
  });

  it('there is no way to pass a handle or revision: options other than launchId and manifest are ignored', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const g = openPolicyGate(fake.source, catalog, { launchId: 'launch-A', apiRevision: REV, validators: {}, policySnapshot: 'x' } as never);
    expect(g.launch.apiRevision).toBe(revOf('launch-A'));
    expect(g.launch.policySnapshot).toBe(snapshotOf());
    expect(g.launch.policySnapshot).not.toBe('x');
    expect(g.launch.apiRevision).not.toBe(REV);
  });

  it('the effective snapshot binds the source: sources A and B at the same revision give different apiRevisions', () => {
    const a = openPolicyGate(createFixturePolicySource(FIXTURE_HOST, allow, 'source-A').source, catalog, { launchId: 'launch-1' });
    const b = openPolicyGate(createFixturePolicySource(FIXTURE_HOST, allow, 'source-B').source, catalog, { launchId: 'launch-1' });
    expect([a.launch.policyRevision, b.launch.policyRevision]).toEqual(['fixture-rev-1', 'fixture-rev-1']);
    expect(a.launch.policySnapshot).toMatch(/^np1\.[0-9a-f]{64}$/);
    expect([a.launch.policySnapshot, b.launch.policySnapshot]).toEqual([snapshotOf('source-A'), snapshotOf('source-B')]);
    expect([a.launch.apiRevision, b.launch.apiRevision]).toEqual([revOf('launch-1', 'source-A'), revOf('launch-1', 'source-B')]);
    expect(a.launch.apiRevision).not.toBe(b.launch.apiRevision);
    expect(() => admitCall(b.validators, a.launch.apiRevision, 'get_map', {})).toThrow(expect.objectContaining({ code: 'stale-revision' }));
    expect(admitCall(b.validators, b.launch.apiRevision, 'get_map', {}).method).toBe('get_map');
  });

  it('the effective snapshot binds the narrowed method set: manifests {get_map} and {read_room} give different apiRevisions', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const m = openPolicyGate(fake.source, catalog, { launchId: 'launch-1', manifest: ['get_map'] });
    const r = openPolicyGate(fake.source, catalog, { launchId: 'launch-1', manifest: ['read_room'] });
    expect([m.launch.methods, r.launch.methods]).toEqual([['get_map'], ['read_room']]);
    expect([m.launch.apiRevision, r.launch.apiRevision]).toEqual([revOf('launch-1', undefined, undefined, ['get_map']), revOf('launch-1', undefined, undefined, ['read_room'])]);
    expect(m.launch.apiRevision).not.toBe(r.launch.apiRevision);
    expect(() => admitCall(r.validators, m.launch.apiRevision, 'read_room', { room: 'r-1' })).toThrow(expect.objectContaining({ code: 'stale-revision' }));
    expect(m.authorize(m.decide('get_map', {}), 'get_map', {}).ok).toBe(true);
    expect(r.authorize(r.decide('read_room', { room: 'r-1' }), 'read_room', { room: 'r-1' }).ok).toBe(true);
  });

  it('reordered, duplicate and unknown manifest entries with the same effective set keep the same apiRevision', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const open = (manifest?: readonly string[]) => openPolicyGate(fake.source, catalog, { launchId: 'launch-1', ...(manifest ? { manifest } : {}) }).launch;
    const base = open(['get_map', 'read_room']);
    for (const manifest of [['read_room', 'get_map'], ['get_map', 'read_room', 'get_map', 'read_room'], ['read_room', 'create_session', 'get_map', 'nope', 'report']]) {
      expect(open(manifest).apiRevision, manifest.join(',')).toBe(base.apiRevision);
    }
    // No manifest and a manifest naming every documented method are the same effective set.
    expect(open([...DOCUMENTED].reverse()).apiRevision).toBe(open().apiRevision);
    expect(open(['get_map']).apiRevision).not.toBe(base.apiRevision);
    // An empty effective set is its own snapshot too.
    expect(open(['create_session']).methods).toEqual([]);
    expect(open(['create_session']).apiRevision).toBe(open([]).apiRevision);
  });

  it('after a policy change the old revision is refused on the new gate, and the current launch works', () => {
    const fake = createFixturePolicySource(FIXTURE_HOST, allow);
    const before = openPolicyGate(fake.source, catalog, { launchId: 'launch-1' });
    fake.bump();
    const after = openPolicyGate(fake.source, catalog, { launchId: 'launch-1' });
    expect(after.launch.policyRevision).toBe('fixture-rev-2');
    expect(after.launch.apiRevision).toBe(revOf('launch-1', 'fixture-policy', 'fixture-rev-2'));
    expect(after.launch.apiRevision).not.toBe(before.launch.apiRevision);
    expect(() => admitCall(after.validators, before.launch.apiRevision, 'get_map', {})).toThrow(expect.objectContaining({ code: 'stale-revision' }));
    expect(before.decide('get_map', {}).state).toBe('revoked');
    const d = after.decide('get_map', {});
    expect(d.apiRevision).toBe(after.launch.apiRevision);
    expect(after.authorize(d, 'get_map', {})).toMatchObject({ ok: true, argsText: '{}' });
  });

  it('a source id must be an opaque identity', () => {
    for (const id of ['', 'bad id', 'x'.repeat(129)]) expect(() => createFixturePolicySource(FIXTURE_HOST, allow, id)).toThrow(new NativePolicyError('invalid-source'));
  });
});

describe('fixture gate: re-evaluation and revocation between decision and dispatch', () => {
  it('a revision change after an allow decision revokes the queued call and every later one; the source is not asked again', () => {
    const h = harness(allow);
    const d = h.gate.decide('get_map', {});
    expect(d.state).toBe('allow');
    h.fake.bump();
    expect(h.dispatch(d, 'get_map', {})).toEqual({ ok: false, reason: 'revoked', fallback: 'classic' });
    expect(h.gate.status()).toMatchObject({ terminal: 'revoked', authorized: 0, refused: 1 });
    const asked = h.fake.queries.length;
    const later = h.gate.decide('read_room', { room: 'r-1' });
    expect(later.state).toBe('revoked');
    expect(h.dispatch(later, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'revoked' });
    expect(h.fake.queries).toHaveLength(asked);
    expect(h.host).toEqual([]);
  });

  it('a rule change without a revision change is caught by the re-evaluation at dispatch', () => {
    const h = harness(allow);
    const d = h.gate.decide('read_room', { room: 'r-1' });
    h.fake.setRule(() => 'deny');
    expect(h.dispatch(d, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'deny' });
    h.fake.setRule(() => 'ask');
    const d2 = h.gate.decide('get_map', {});
    expect(d2.state).toBe('ask');
    h.fake.setRule(allow);
    // A non-allow decision is never upgraded; ask/deny/unknown do not end the gate.
    expect(h.dispatch(d2, 'get_map', {})).toMatchObject({ ok: false, reason: 'ask' });
    expect(h.host).toEqual([]);
    expect(h.gate.status().terminal).toBeNull();
    const fresh = h.gate.decide('get_map', {});
    expect(h.dispatch(fresh, 'get_map', {}).ok).toBe(true);
    expect(h.host).toEqual(['get_map {}']);
  });

  it('an explicit revoked answer is terminal: a later allow at the same revision is still revoked, the source is not asked again', () => {
    const h = harness(allow);
    const queued = h.gate.decide('get_map', {});
    expect(queued.state).toBe('allow');
    h.fake.setRule(() => 'revoked');
    const r = h.gate.decide('read_room', { room: 'r-1' });
    expect(r.state).toBe('revoked');
    expect(h.gate.status().terminal).toBe('revoked');
    const asked = h.fake.queries.length;
    h.fake.setRule(allow);
    expect(h.gate.decide('read_guide', {}).state).toBe('revoked');
    expect(h.dispatch(queued, 'get_map', {})).toMatchObject({ ok: false, reason: 'revoked' });
    expect(h.dispatch(r, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'revoked' });
    expect(h.fake.queries).toHaveLength(asked);
    expect(h.host).toEqual([]);
  });

  it('a revoked answer at dispatch time is terminal too', () => {
    const h = harness(allow);
    const d = h.gate.decide('get_map', {});
    h.fake.setRule(() => 'revoked');
    expect(h.dispatch(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'revoked' });
    h.fake.setRule(allow);
    expect(h.gate.decide('get_map', {}).state).toBe('revoked');
    expect(h.gate.status().terminal).toBe('revoked');
    expect(h.host).toEqual([]);
  });

  it('an explicit stale answer is terminal too: a later allow under the same snapshot is still stale, the source is not asked again', () => {
    const h = harness(allow);
    const queued = h.gate.decide('get_map', {});
    expect(queued.state).toBe('allow');
    h.fake.setRule(() => 'stale');
    const d = h.gate.decide('read_room', { room: 'r-1' });
    expect(d.state).toBe('stale');
    expect(h.gate.status().terminal).toBe('stale');
    const asked = h.fake.queries.length;
    h.fake.setRule(allow);
    expect(h.gate.decide('read_guide', {}).state).toBe('stale');
    expect(h.dispatch(queued, 'get_map', {})).toEqual({ ok: false, reason: 'stale', fallback: 'classic' });
    expect(h.dispatch(d, 'read_room', { room: 'r-1' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.fake.queries).toHaveLength(asked);
    expect(h.host).toEqual([]);
    // A later revision change does not rewrite the recorded terminal reason.
    h.fake.bump();
    expect(h.gate.status().terminal).toBe('stale');
  });

  it('a stale answer at dispatch time is terminal; recovery is a new gate with a fresh snapshot', () => {
    const h = harness(allow);
    const d = h.gate.decide('get_map', {});
    h.fake.setRule(() => 'stale');
    expect(h.dispatch(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'stale' });
    h.fake.setRule(allow);
    expect(h.gate.decide('get_map', {}).state).toBe('stale');
    expect(h.host).toEqual([]);
    h.fake.bump();
    const next = openPolicyGate(h.fake.source, catalog, { launchId: 'fixture-launch-1' });
    expect(next.launch.policyRevision).toBe('fixture-rev-2');
    const fresh = next.decide('get_map', {});
    expect(next.authorize(fresh, 'get_map', {}).ok).toBe(true);
    expect(h.gate.status().terminal).toBe('stale');
  });

  it('a revision change while the source is deciding revokes the decision itself', () => {
    const fake: ReturnType<typeof createFixturePolicySource> = createFixturePolicySource(FIXTURE_HOST, () => { fake.bump(); return 'allow'; });
    const gate = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-1' });
    const d = gate.decide('get_map', {});
    expect(d.state).toBe('revoked');
    expect(gate.authorize(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('a revision change during the dispatch-time re-evaluation refuses that dispatch', () => {
    let n = 0;
    const fake: ReturnType<typeof createFixturePolicySource> = createFixturePolicySource(FIXTURE_HOST, () => { if (++n === 2) fake.bump(); return 'allow'; });
    const gate = openPolicyGate(fake.source, catalog, { launchId: 'fixture-launch-1' });
    const d = gate.decide('get_map', {});
    expect(d.state).toBe('allow');
    expect(gate.authorize(d, 'get_map', {})).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('several queued allow decisions are all revoked by one change', () => {
    const h = harness(allow);
    const queued = [h.gate.decide('get_map', {}), h.gate.decide('read_room', { room: 'r-1' }), h.gate.decide('read_guide', {})];
    h.fake.bump();
    expect([h.dispatch(queued[0], 'get_map', {}), h.dispatch(queued[1], 'read_room', { room: 'r-1' }), h.dispatch(queued[2], 'read_guide', {})].map((a) => a.ok || a.reason)).toEqual(['revoked', 'revoked', 'revoked']);
    expect(h.host).toEqual([]);
  });

  it('queued revocation is not the settlement of a started call: the started call keeps its own ledger outcome', async () => {
    const h = harness(allow);
    const ledger = new RunLedger('run-t5a', h.gate.validators, h.gate.launch.apiRevision, ['get_map', 'read_room'], RUN_LIMITS);
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    // Call A is authorized and started.
    const dA = h.gate.decide('get_map', {});
    const aA = h.dispatch(dA, 'get_map', {});
    expect(aA.ok).toBe(true);
    const admA = ledger.admit(1, 'get_map', aA.ok ? aA.argsText : null);
    expect(admA.kind).toBe('dispatch');
    const started = pending.then(() => ({ kind: 'ok', text: '{"map":1}' }));
    // Call B is decided (allow) and queued; the policy changes before its dispatch.
    const dB = h.gate.decide('read_room', { room: 'r-1' });
    expect(dB.state).toBe('allow');
    h.fake.bump();
    const aB = h.dispatch(dB, 'read_room', { room: 'r-1' });
    expect(aB).toMatchObject({ ok: false, reason: 'revoked' });
    // B never reaches the ledger or the host; A is still in flight, neither refused nor cancelled by the revocation.
    expect(ledger.snapshot().entries.map((e) => [e.method, e.state])).toEqual([['get_map', 'dispatched']]);
    expect(h.host).toEqual(['get_map {}']);
    release();
    const receipt = await started;
    expect(ledger.settle(admA.entry, receipt)).toEqual({ ok: true, text: '{"map":1}' });
    expect(ledger.snapshot().entries.map((e) => [e.method, e.state])).toEqual([['get_map', 'succeeded']]);
    // The gate's own account is unchanged by the settlement: one authorized, one refused, revoked.
    expect(h.gate.status()).toMatchObject({ terminal: 'revoked', decisions: 2, authorized: 1, refused: 1 });
  });
});

describe('static guard: the fake source is confined to the repository-root fixture module and tests', () => {
  const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const repo = path.resolve(coreDir, '../..');
  const FIXTURE = 'tests/fixtures/code-mode/native-policy.ts';
  const CONTRACT = 'packages/core/src/mcp/code-mode/native-policy.ts';
  const sources = (pattern: RegExp, grepPattern: string): string[] => {
    // Every code file of the repository (tracked and untracked, not ignored), outside docs and dependencies.
    const code = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.json'];
    const tracked = spawnSync('git', ['grep', '-l', '-E', grepPattern, '--', ...code], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...code], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter((f) => pattern.test(readFileSync(path.join(repo, f), 'utf8')));
    return [...new Set([...tracked, ...untracked])].sort();
  };
  const isTest = (f: string) => /\.test\.tsx?$/.test(f);

  it('the fixture lives outside every workspace package; no package source tree holds a fake source', () => {
    expect(existsSync(path.join(repo, FIXTURE))).toBe(true);
    expect(FIXTURE.startsWith('packages/')).toBe(false);
    expect(existsSync(path.join(coreDir, 'src/mcp/code-mode/fixtures'))).toBe(false);
    const inPackages = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n')
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f) && /\bFIXTURE_HOST\b|createFixturePolicySource|[=(,]\s*claimFixtureSourceMint\(\)/.test(readFileSync(path.join(repo, f), 'utf8')));
    expect(inPackages).toEqual([]);
  });

  it('only the fixture module (and tests) refers to the source mint', () => {
    const files = sources(/claimFixtureSourceMint/, 'claimFixtureSourceMint').filter((f) => !isTest(f));
    expect(files).toEqual([CONTRACT, FIXTURE]);
    const src = readFileSync(path.join(repo, CONTRACT), 'utf8');
    expect(src.match(/\bclaimFixtureSourceMint\(/g)).toHaveLength(1); // the definition; never called here
  });

  it('only the live detector (and tests) refers to the live mint, and it calls it once (T12a)', () => {
    const files = sources(/\bmintLiveSource\b/, 'mintLiveSource').filter((f) => !isTest(f));
    expect(files).toEqual(['packages/core/src/mcp/code-mode/detector.ts', CONTRACT]);
    expect(readFileSync(path.join(repo, 'packages/core/src/mcp/code-mode/detector.ts'), 'utf8').match(/\bmintLiveSource\(/g)).toHaveLength(1);
    expect(readFileSync(path.join(repo, CONTRACT), 'utf8').match(/\bmintLiveSource\(/g)).toHaveLength(1); // the definition
  });

  it('only tests import the fixture module; nothing re-exports it', () => {
    // Any quoted module specifier naming the fixture: static imports, re-exports, dynamic imports and require. The
    // importers are exactly these four tests (T5b3, s-292 m-4283; T7a-wrappers added code-mode-tools.test.ts for its real-broker legs, s-292 m-5950); any other file, test or not, needs review first.
    const files = sources(/fixtures\/code-mode\/native-policy(\.[jt]s)?['"`]/, "fixtures/code-mode/native-policy(\\.[jt]s)?['\"`]").filter((f) => f !== FIXTURE);
    expect(files.filter((f) => !isTest(f))).toEqual([]);
    expect(files).toEqual(['packages/core/src/mcp/code-mode-tools.test.ts', 'packages/core/src/mcp/code-mode/broker.test.ts', 'packages/core/src/mcp/code-mode/native-policy.test.ts', 'packages/host/src/agent/code-mode-broker.test.ts']);
    expect(sources(/\bFIXTURE_HOST\b|createFixturePolicySource/, 'FIXTURE_HOST|createFixturePolicySource').filter((f) => !isTest(f))).toEqual([FIXTURE]);
  });

  it('neither module reads the environment, configuration or files, and the contract never imports the fixture', () => {
    for (const f of [CONTRACT, FIXTURE]) {
      const src = readFileSync(path.join(repo, f), 'utf8');
      expect(src, f).not.toMatch(/process\.|node:fs|from 'fs'|readFile|require\(|import\(/);
    }
    const contract = readFileSync(path.join(repo, CONTRACT), 'utf8');
    expect([...contract.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1])).toEqual(['./catalog.js', './contracts.js', './proven.js', './validation.js']);
    const fixture = readFileSync(path.join(repo, FIXTURE), 'utf8');
    expect([...fixture.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1])).toEqual(['../../../packages/core/src/mcp/code-mode/native-policy.js']);
  });
});
