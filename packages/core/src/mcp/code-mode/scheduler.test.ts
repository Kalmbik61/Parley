import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { buildCatalog } from './catalog.js';
import { compileCallValidators, computeApiRevision } from './contracts.js';
import { RUN_LIMITS, type RunLimits } from './limits.js';
import { GUEST_MESSAGES, type LedgerEntry, RunLedger, SessionScheduler, readSettlement } from './scheduler.js';

const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
const catalog = buildCatalog(TOOLS);
const REV = computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
const VAL = compileCallValidators(catalog, REV);
const ledger = (limits: Partial<RunLimits> = {}, methods: string[] = ['get_map', 'read_room']) => new RunLedger('run-test', VAL, REV, methods, { ...RUN_LIMITS, ...limits });
const ok = (text: string) => ({ kind: 'ok', text });

describe('typed fixture settlement (m-4126, accepted m-4131)', () => {
  it('accepts exactly the four shapes and freezes them', () => {
    expect(readSettlement({ kind: 'ok', text: '{}' })).toEqual({ kind: 'ok', text: '{}' });
    for (const kind of ['error', 'cancelled', 'unknown']) expect(readSettlement({ kind })).toEqual({ kind });
    expect(Object.isFrozen(readSettlement({ kind: 'error' }))).toBe(true);
  });

  it('anything else is not a settlement', () => {
    const getter = Object.defineProperty({}, 'kind', { get: () => 'error', enumerable: true });
    class Receipt { kind = 'error'; }
    for (const v of [null, undefined, 'ok', [{ kind: 'error' }], {}, { kind: 'ok' }, { kind: 'ok', text: 1 }, { kind: 'error', message: SECRET }, { kind: 'succeeded' }, getter, new Receipt(), new Error('x'), Promise.resolve({ kind: 'error' })]) {
      expect(readSettlement(v), String(v)).toBeNull();
    }
  });

  it('proxies, hidden extras and accessors are refused without being read; a throwing trap never escapes (B3)', () => {
    let reads = 0;
    const throwing = new Proxy({}, { get() { throw new Error(SECRET); }, ownKeys() { throw new Error(SECRET); }, getOwnPropertyDescriptor() { throw new Error(SECRET); }, getPrototypeOf() { throw new Error(SECRET); } });
    const plainProxy = new Proxy({ kind: 'error' }, {});
    const hidden = Object.defineProperty({ kind: 'error' }, 'message', { value: SECRET, enumerable: false });
    const symbolExtra = { kind: 'error', [Symbol('x')]: SECRET };
    const textGetter = Object.defineProperty({ kind: 'ok' }, 'text', { get: () => { reads++; return '{}'; }, enumerable: true });
    for (const v of [throwing, plainProxy, hidden, symbolExtra, textGetter]) expect(() => readSettlement(v)).not.toThrow();
    for (const v of [throwing, plainProxy, hidden, symbolExtra, textGetter]) expect(readSettlement(v)).toBeNull();
    expect(reads).toBe(0);
  });
});

describe('host assessment (plan T6c)', () => {
  it('is accepted on ok and error only, with exactly the three values', () => {
    for (const assessment of ['complete', 'partial', 'unknown']) {
      expect(readSettlement({ kind: 'ok', text: '{}', assessment })).toEqual({ kind: 'ok', text: '{}', assessment });
      expect(readSettlement({ kind: 'error', text: '{}', assessment, observedBytes: 3 })).toEqual({ kind: 'error', text: '{}', assessment, observedBytes: 3 });
    }
    for (const assessment of ['Complete', '', 'done', 1, true, null, undefined, {}, ['complete']]) {
      expect(readSettlement({ kind: 'ok', text: '{}', assessment }), String(assessment)).toBeNull();
    }
  });

  it('on cancelled or unknown it makes the settlement malformed, so the call is unknown with that reason', () => {
    for (const kind of ['cancelled', 'unknown']) {
      for (const assessment of ['complete', 'partial', 'unknown']) expect(readSettlement({ kind, assessment }), `${kind} ${assessment}`).toBeNull();
    }
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'unknown', assessment: 'complete' });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unknown', unknownWhy: 'malformed-settlement', assessment: null });
  });

  it('an accessor is refused without being read', () => {
    let reads = 0;
    const v = Object.defineProperty({ kind: 'ok', text: '{}' }, 'assessment', { get: () => { reads++; return 'complete'; }, enumerable: true });
    expect(readSettlement(v)).toBeNull();
    expect(reads).toBe(0);
  });

  it.each([
    ['ok', 'complete', 'succeeded', false],
    ['ok', 'partial', 'succeeded', true],
    ['ok', 'unknown', 'succeeded', true],
    ['error', 'complete', 'failed', false],
    ['error', 'partial', 'failed', true],
    ['error', 'unknown', 'failed', true],
  ] as const)('%s with %s: the ledger keeps it and the evidence floors it', (kind, assessment, state, incomplete) => {
    const l = ledger();
    l.settle(l.admit(1, 'get_map', '{}').entry, { kind, text: '{}', assessment });
    expect(l.snapshot().entries[0]).toMatchObject({ state, assessment });
    expect(l.evidence()[0]).toMatchObject({ outcome: state, incomplete });
  });

  it('absent stays what it was for the historical fixtures: recorded as null and not floored by the ledger', () => {
    const l = ledger();
    l.settle(l.admit(1, 'get_map', '{}').entry, ok('{}'));
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'succeeded', assessment: null });
    expect(l.evidence()[0]).toMatchObject({ incomplete: false });
  });

  it('is monotonic: a second settlement cannot lower it, and one incomplete read stays in the evidence next to complete ones', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'ok', text: '{}', assessment: 'partial' });
    expect(l.settle(a.entry, { kind: 'ok', text: '{}', assessment: 'complete' })).toBeNull();
    l.settle(l.admit(2, 'get_map', '{}').entry, { kind: 'ok', text: '{}', assessment: 'complete' });
    expect(l.snapshot().entries.map((e) => e.assessment)).toEqual(['partial', 'complete']);
    expect(l.evidence().map((e) => e.incomplete)).toEqual([true, false]);
  });

  it('a late receipt while draining records its assessment too', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.end();
    expect(l.settle(a.entry, { kind: 'ok', text: '{}', assessment: 'partial' })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'succeeded', assessment: 'partial' });
  });

  it('an undeliverable read stays floored by the delivery failure, whatever the assessment says', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'ok', text: 'not json', assessment: 'complete' });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'succeeded', assessment: 'complete', deliveryFailure: 'response-not-json' });
    expect(l.evidence()[0]).toMatchObject({ incomplete: true });
  });
});

describe('not-dispatched (the host has no route, spec §5.2)', () => {
  it('needs its bytes, and takes nothing else', () => {
    expect(readSettlement({ kind: 'not-dispatched', observedBytes: 9 })).toEqual({ kind: 'not-dispatched', observedBytes: 9 });
    for (const v of [{ kind: 'not-dispatched' }, { kind: 'not-dispatched', observedBytes: -1 }, { kind: 'not-dispatched', observedBytes: 5, text: '{}' }, { kind: 'not-dispatched', observedBytes: 5, assessment: 'unknown' }, { kind: 'not-dispatched', observedBytes: 5, why: '404' }]) {
      expect(readSettlement(v), JSON.stringify(v)).toBeNull();
    }
  });

  it('turns the call into a refusal: zero dispatch, the fixed unavailable message, bytes charged, settled, and the lease can go', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    expect(l.settle(a.entry, { kind: 'not-dispatched', observedBytes: 9 })).toEqual({ ok: false, message: GUEST_MESSAGES.unavailable });
    expect(l.snapshot()).toMatchObject({ refused: 1, dispatched: 0, inFlight: 0, unknown: 0, hostBytes: 9 });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'refused', refusal: 'host-unavailable', responseBytes: 9 });
    expect(l.outstanding).toBe(0);
    expect(l.allSettled).toBe(true);
    expect(l.evidence()[0]).toMatchObject({ dispatched: false, outcome: 'refused', responseBytes: null });
    l.end();
    l.lifecycleClosed();
    expect(l.quiescent).toBe(true);
  });

  it('while draining it is recorded and nobody is told; a later settlement cannot change it', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.end();
    expect(l.settle(a.entry, { kind: 'not-dispatched', observedBytes: 0 })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'refused', refusal: 'host-unavailable' });
    expect(l.settle(a.entry, { kind: 'ok', text: '{}', assessment: 'complete' })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'refused' });
  });

  it('cannot reach an entry that already has an outcome', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'unknown', observedBytes: 0 });
    expect(l.settle(a.entry, { kind: 'not-dispatched', observedBytes: 0 })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unknown', refusal: null });
  });
});

describe('unread (T5b-budget-wedge)', () => {
  it('needs its bytes, and takes nothing else', () => {
    expect(readSettlement({ kind: 'unread', observedBytes: 5 })).toEqual({ kind: 'unread', observedBytes: 5 });
    for (const v of [{ kind: 'unread' }, { kind: 'unread', observedBytes: -1 }, { kind: 'unread', observedBytes: 5, text: '{}' }, { kind: 'unread', observedBytes: 5, assessment: 'unknown' }, { kind: 'unread', observedBytes: 5, why: 'x' }]) {
      expect(readSettlement(v), JSON.stringify(v)).toBeNull();
    }
  });

  it('runBudgetCut: true on an unread is kept as typed evidence; anything else, or on another kind, is malformed', async () => {
    expect(readSettlement({ kind: 'unread', observedBytes: 5, runBudgetCut: true })).toEqual({ kind: 'unread', observedBytes: 5, runBudgetCut: true });
    for (const v of [{ kind: 'unread', observedBytes: 5, runBudgetCut: false }, { kind: 'unread', observedBytes: 5, runBudgetCut: 'yes' }, { kind: 'unknown', observedBytes: 5, runBudgetCut: true }, { kind: 'cancelled', runBudgetCut: true }, { kind: 'ok', text: '{}', runBudgetCut: true }, { kind: 'error', runBudgetCut: true }]) {
      expect(readSettlement(v), JSON.stringify(v)).toBeNull();
    }
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'unread', observedBytes: 70, runBudgetCut: true });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unread', runBudgetCut: true });
    const plain = ledger();
    const b = plain.admit(1, 'get_map', '{}');
    plain.settle(b.entry, { kind: 'unread', observedBytes: 70 });
    expect(plain.snapshot().entries[0]).toMatchObject({ state: 'unread', runBudgetCut: false });
  });

  it('is a terminal receipt: bytes charged, the fixed refusal to the guest, incomplete, and it counts as settled', async () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    expect(l.settle(a.entry, { kind: 'unread', observedBytes: 70 })).toEqual({ ok: false, message: GUEST_MESSAGES.undeliverable });
    expect(l.snapshot()).toMatchObject({ hostBytes: 70, deliveredBytes: 0, unknown: 0, receipts: 1, inFlight: 0 });
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unread', responseBytes: 70, assessment: null, unknownWhy: null });
    expect(l.outstanding).toBe(0);
    expect(l.allSettled).toBe(true);
    expect(l.evidence()[0]).toMatchObject({ outcome: 'unread', dispatched: true, responseBytes: 70, incomplete: true });
    l.end();
    l.lifecycleClosed();
    expect(l.quiescent).toBe(true);
  });

  it('while draining it records and tells no one, and the lease is free once the lifecycle closes', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.end();
    expect(l.settle(a.entry, { kind: 'unread', observedBytes: 9 })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unread', responseBytes: 9 });
    l.lifecycleClosed();
    expect(l.quiescent).toBe(true);
  });

  it('a later settlement cannot change it', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}');
    l.settle(a.entry, { kind: 'unread', observedBytes: 9 });
    expect(l.settle(a.entry, { kind: 'ok', text: '{}', assessment: 'complete' })).toBeNull();
    expect(l.snapshot().entries[0]).toMatchObject({ state: 'unread', assessment: null });
  });

  it('an unknown stays what it was: it still holds the capacity and the lease', () => {
    const l = ledger();
    l.settle(l.admit(1, 'get_map', '{}').entry, { kind: 'unknown', observedBytes: 9 });
    expect(l.outstanding).toBe(1);
    expect(l.allSettled).toBe(false);
    l.end();
    l.lifecycleClosed();
    expect(l.quiescent).toBe(false);
  });
});

describe('admission', () => {
  it('a valid call is dispatched with the exact validated text', () => {
    const l = ledger();
    const a = l.admit(1, 'read_room', '{"room":"r-1", "limit" : 2}');
    expect(a).toMatchObject({ kind: 'dispatch', call: { method: 'read_room', argsText: '{"room":"r-1","limit":2}' } });
    expect(l.snapshot()).toMatchObject({ admitted: 1, dispatched: 1, inFlight: 1, refused: 0 });
  });

  it('unknown calls keep their capacity: unanswered at the bound is a violation, outstanding at the bound is a refusal (B1/R1)', () => {
    const l = ledger();
    l.settleUncertain(l.admit(1, 'get_map', '{}').entry, 'host-rejected');
    l.settleUncertain(l.admit(2, 'get_map', '{}').entry, 'host-rejected');
    expect(l.snapshot()).toMatchObject({ inFlight: 0, unknown: 2 });
    expect(l.outstanding).toBe(2);
    expect(l.admit(3, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'unsettled-capacity' });
    const m = ledger();
    m.admit(1, 'get_map', '{}');
    m.admit(2, 'get_map', '{}');
    expect(m.admit(3, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'in-flight' });
  });

  it('a call that may no longer be dispatched is refused run-ended and never becomes dispatched (no phantom entry)', () => {
    const l = ledger();
    const a = l.admit(1, 'get_map', '{}', () => ({ ok: false, reason: 'run-ended' }));
    expect(a).toMatchObject({ kind: 'refuse', reason: 'run-ended', entry: { state: 'refused' } });
    expect(l.snapshot()).toMatchObject({ dispatched: 0, inFlight: 0 });
    const m = ledger();
    m.stopAdmission();
    expect(m.admit(1, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
  });

  it('protocol violations: duplicate rid, a method outside the run, budget, in-flight, oversized arguments', () => {
    const l = ledger({ maxRpcs: 4 }, ['get_map']);
    expect(l.admit(1, 'get_map', '{}').kind).toBe('dispatch');
    expect(l.admit(1, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'duplicate-rid' });
    expect(l.admit(2, 'read_room', '{"room":"r"}')).toMatchObject({ kind: 'violation', reason: 'method-not-in-run', entry: { method: null } });
    expect(l.admit(3, SECRET, '{}')).toMatchObject({ kind: 'violation', reason: 'method-not-in-run', entry: { method: null } });
    expect(l.admit(4, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'call-budget' });
    expect(JSON.stringify(l.snapshot())).not.toContain('SYNTHETIC');
    const m = ledger({ maxInFlight: 1 });
    m.admit(1, 'get_map', '{}');
    expect(m.admit(2, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'in-flight' });
    const n = ledger({ argBytes: 16 });
    expect(n.admit(1, 'get_map', '{"session":"s-0123456789"}')).toMatchObject({ kind: 'violation', reason: 'arguments-too-large' });
    expect(n.admit(2, 'get_map', 42)).toMatchObject({ kind: 'violation', reason: 'arguments-too-large' });
  });

  it('refusals the guest sees: non-JSON, schema, after the run ended, response budget exhausted — never in flight', () => {
    const l = ledger({ responseBytes: 4 });
    expect(l.admit(1, 'get_map', '{"a":1,"a":2}')).toMatchObject({ kind: 'refuse', reason: 'not-json' });
    expect(l.admit(2, 'get_map', '{"maxBytes":1}')).toMatchObject({ kind: 'refuse', reason: 'invalid-arguments' });
    expect(l.admit(3, 'get_map', `{"token":"${SECRET}"}`)).toMatchObject({ kind: 'refuse', reason: 'invalid-arguments' });
    const d = l.admit(4, 'get_map', '{}');
    l.settle(d.entry, ok('[1,2]'));
    expect(l.tryCharge(d.entry, 5)).toBe(false);
    expect(l.tryCharge(d.entry, 4)).toBe(true);
    expect(l.admit(5, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'response-budget-exhausted' });
    l.end();
    expect(l.admit(6, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(l.snapshot()).toMatchObject({ admitted: 6, refused: 5, inFlight: 0 });
    expect(JSON.stringify(l.snapshot())).not.toContain('SYNTHETIC');
  });
});

describe('settlement', () => {
  const one = (limits: Partial<RunLimits> = {}) => { const l = ledger(limits); return { l, e: l.admit(1, 'get_map', '{}').entry }; };

  it('ok → succeeded with the text; error → failed with a fixed message', () => {
    const a = one();
    expect(a.l.settle(a.e, ok('{"x":1}'))).toEqual({ ok: true, text: '{"x":1}' });
    expect(a.l.snapshot().entries[0]).toMatchObject({ state: 'succeeded', responseBytes: 7, delivered: false, deliveryFailure: null });
    expect(a.l.tryCharge(a.e, 40)).toBe(true);
    expect(a.l.snapshot()).toMatchObject({ hostBytes: 7, deliveredBytes: 40, entries: [{ delivered: true, deliveredBytes: 40 }] });
    const b = one();
    expect(b.l.settle(b.e, { kind: 'error' })).toEqual({ ok: false, message: GUEST_MESSAGES.failed });
    expect(b.l.snapshot().entries[0]).toMatchObject({ state: 'failed' });
  });

  it('an authoritative ok whose response is oversized or not JSON still settles succeeded; its bytes are observed; delivery fails', () => {
    const a = one({ responseBytes: 8 });
    expect(a.l.settle(a.e, ok('"0123456789"'))).toEqual({ ok: true, text: '"0123456789"' });
    expect(a.l.tryCharge(a.e, 9)).toBe(false);
    a.l.markUndeliverable(a.e);
    expect(a.l.snapshot()).toMatchObject({ hostBytes: 12, deliveredBytes: 0, entries: [{ state: 'succeeded', deliveryFailure: 'response-budget', responseBytes: 12, delivered: false }] });
    expect(a.l.tryCharge(null, 8)).toBe(true);
    expect(a.l.tryCharge(null, 1)).toBe(false);
    const b = one();
    expect(b.l.settle(b.e, ok(`not json ${SECRET}`))).toEqual({ ok: false, message: GUEST_MESSAGES.undeliverable });
    expect(b.l.snapshot().entries[0]).toMatchObject({ state: 'succeeded', deliveryFailure: 'response-not-json' });
    expect(JSON.stringify(b.l.snapshot())).not.toContain('SYNTHETIC');
    expect(b.l.evidence()[0]).toMatchObject({ outcome: 'succeeded', incomplete: true });
  });

  it('cancelled is accepted only after a parent request; otherwise it is unknown', () => {
    const a = one();
    expect(a.l.settle(a.e, { kind: 'cancelled' })).toEqual({ ok: false, message: GUEST_MESSAGES.unknown });
    expect(a.l.snapshot().entries[0]).toMatchObject({ state: 'unknown', unknownWhy: 'unrequested-cancel' });
    const b = one();
    b.l.requestCancel(b.e);
    b.l.settle(b.e, { kind: 'cancelled' });
    expect(b.l.snapshot().entries[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
  });

  it('rejection, a throw, a malformed value and explicit unknown are all unknown — an AbortError after a cancel too', () => {
    for (const [settle, why] of [
      [(l: RunLedger, e: LedgerEntry) => l.settleUncertain(e, 'host-rejected'), 'host-rejected'],
      [(l: RunLedger, e: LedgerEntry) => l.settleUncertain(e, 'host-threw'), 'host-threw'],
      [(l: RunLedger, e: LedgerEntry) => l.settle(e, { kind: 'error', message: SECRET }), 'malformed-settlement'],
      [(l: RunLedger, e: LedgerEntry) => l.settle(e, { kind: 'unknown' }), 'host-unknown'],
    ] as const) {
      const a = one();
      a.l.requestCancel(a.e);
      expect(settle(a.l, a.e)).toEqual({ ok: false, message: GUEST_MESSAGES.unknown });
      expect(a.l.snapshot().entries[0]).toMatchObject({ state: 'unknown', unknownWhy: why });
    }
  });

  it('outcomes are monotonic: a second settlement never changes a recorded outcome', () => {
    const a = one();
    a.l.requestCancel(a.e);
    a.l.settle(a.e, { kind: 'cancelled' });
    expect(a.l.settle(a.e, ok('{}'))).toBeNull();
    expect(a.l.settleUncertain(a.e, 'host-rejected')).toBeNull();
    expect(a.l.snapshot().entries[0]!.state).toBe('cancelled');
    const b = one();
    b.l.settleUncertain(b.e, 'host-rejected');
    expect(b.l.settle(b.e, ok('{}'))).toBeNull();
    expect(b.l.snapshot().entries[0]!.state).toBe('unknown');
  });

  it('after the run ends, dispatched calls drain; a late receipt updates the entry but is not delivered', () => {
    const a = one();
    a.l.end();
    expect(a.l.snapshot()).toMatchObject({ draining: 1, quiescent: false });
    expect(a.l.settle(a.e, ok('{}'))).toBeNull();
    expect(a.l.snapshot()).toMatchObject({ draining: 0, receipts: 1, quiescent: true, entries: [{ state: 'succeeded', delivered: false }] });
  });

  it('entries of another ledger are rejected', () => {
    const a = one();
    const b = one();
    expect(() => a.l.settle(b.e, ok('{}'))).toThrow();
  });
});

describe('evidence and quiescence', () => {
  it('maps the ledger to T3b operation evidence, minted against the handle', () => {
    const l = ledger();
    const s = l.admit(1, 'get_map', '{}');
    l.settle(s.entry, ok('{}'));
    const u = l.admit(2, 'read_room', '{"room":"r"}');
    l.settleUncertain(u.entry, 'host-threw');
    l.admit(3, 'get_map', '{"maxBytes":1}');
    l.admit(4, 'get_map', '{}');
    l.end();
    expect(l.evidence().map((e) => [e.ordinal, e.method, e.dispatched, e.outcome, e.incomplete])).toEqual([
      [1, 'get_map', true, 'succeeded', false],
      [2, 'read_room', true, 'unknown', true],
      [3, 'get_map', false, 'refused', false],
      [4, 'get_map', true, 'draining', true],
    ]);
  });

  it('a protocol violation stays in the ledger but is not an operation in the evidence', () => {
    const l = ledger({ maxRpcs: 1 });
    l.settle(l.admit(1, 'get_map', '{}').entry, ok('{}'));
    expect(l.admit(2, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'call-budget' });
    expect(l.snapshot().admitted).toBe(2);
    expect(l.evidence().map((e) => e.ordinal)).toEqual([1]);
  });

  it('quiescent only when ended, cleanup known, and every started call has a terminal receipt', async () => {
    const l = ledger();
    const e = l.admit(1, 'get_map', '{}').entry;
    expect(l.quiescent).toBe(false);
    l.end();
    expect(l.quiescent).toBe(false);
    let resolved = false;
    void l.whenQuiescent().then(() => { resolved = true; });
    l.settle(e, { kind: 'error' });
    await Promise.resolve();
    expect(resolved).toBe(true);
    const c = ledger();
    c.end();
    c.markCleanupUnknown();
    expect(c.quiescent).toBe(false);
    const u = ledger();
    u.settleUncertain(u.admit(1, 'get_map', '{}').entry, 'host-rejected');
    u.end();
    expect(u.quiescent).toBe(false);
  });

  it('waitForInFlight resolves true on settlement and false on timeout', async () => {
    const l = ledger();
    const e = l.admit(1, 'get_map', '{}').entry;
    const pending = l.waitForInFlight(1000);
    l.settle(e, ok('{}'));
    expect(await pending).toBe(true);
    const m = ledger();
    m.admit(1, 'get_map', '{}');
    expect(await m.waitForInFlight(20)).toBe(false);
  });
});

describe('session lease (one run per session)', () => {
  const make = (runId: string) => new RunLedger(runId, VAL, REV, ['get_map'], RUN_LIMITS);

  it('a second acquire is refused at once with the holder and why; release follows quiescence', async () => {
    const s = new SessionScheduler();
    const a = s.acquire(make);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = s.acquire(make);
    expect(b).toEqual({ ok: false, reason: 'busy: a run is active', holder: a.lease.runId });
    const e = a.lease.ledger.admit(1, 'get_map', '{}').entry;
    a.lease.ledger.end();
    expect(s.acquire(make)).toMatchObject({ ok: false, reason: 'busy: previous run draining' });
    a.lease.ledger.settle(e, ok('{}'));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.holder).toBeNull();
    expect(s.acquire(make).ok).toBe(true);
  });

  it('an unknown outcome keeps the lease (U2), named distinctly from draining', async () => {
    const s = new SessionScheduler();
    const a = s.acquire(make);
    if (!a.ok) throw new Error('expected lease');
    a.lease.ledger.settleUncertain(a.lease.ledger.admit(1, 'get_map', '{}').entry, 'host-rejected');
    a.lease.ledger.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.acquire(make)).toMatchObject({ ok: false, reason: 'busy: previous run has calls with unknown outcome', holder: a.lease.runId });
  });

  it('cleanup unknown keeps the lease with its own reason', async () => {
    const s = new SessionScheduler();
    const a = s.acquire(make);
    if (!a.ok) throw new Error('expected lease');
    a.lease.ledger.markCleanupUnknown();
    a.lease.ledger.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.acquire(make)).toMatchObject({ ok: false, reason: 'busy: previous run cleanup unknown' });
  });

  it('concurrent acquires in the same tick: exactly one wins', () => {
    const s = new SessionScheduler();
    const results = Array.from({ length: 5 }, () => s.acquire(make));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a run with no calls releases the lease as soon as it ends', async () => {
    const s = new SessionScheduler();
    const a = s.acquire(make);
    if (!a.ok) throw new Error('expected lease');
    a.lease.ledger.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.holder).toBeNull();
  });
});

// ----- T5b2: observed bytes, error results, the typed dispatch edge -----

const started = (l: RunLedger, rid: number) => { const a = l.admit(rid, 'get_map', '{}'); if (a.kind !== 'dispatch') throw new Error(a.kind); return a.entry; };

describe('T5b2: settlements carry parent-measured observed bytes', () => {
  it('accepts observedBytes on every kind and a text on error; refuses anything that is not a safe non-negative integer', () => {
    expect(readSettlement({ kind: 'ok', text: '{}', observedBytes: 9 })).toEqual({ kind: 'ok', text: '{}', observedBytes: 9 });
    expect(readSettlement({ kind: 'error', text: '{"content":[],"isError":true}', observedBytes: 40 })).toEqual({ kind: 'error', text: '{"content":[],"isError":true}', observedBytes: 40 });
    expect(readSettlement({ kind: 'error', text: '{}' })).toEqual({ kind: 'error', text: '{}' });
    for (const kind of ['error', 'cancelled', 'unknown']) expect(readSettlement({ kind, observedBytes: 0 })).toEqual({ kind, observedBytes: 0 });
    const bad = [-1, 1.5, Number.NaN, Infinity, '5', null, Number.MAX_SAFE_INTEGER + 1];
    for (const observedBytes of bad) for (const kind of ['ok', 'error', 'unknown']) {
      expect(readSettlement({ kind, ...(kind === 'ok' ? { text: '{}' } : {}), observedBytes }), `${kind} ${String(observedBytes)}`).toBeNull();
    }
    expect(readSettlement(Object.defineProperty({ kind: 'unknown' }, 'observedBytes', { get: () => 5, enumerable: true }))).toBeNull();
    expect(readSettlement({ kind: 'unknown', text: '{}' })).toBeNull();
    expect(readSettlement({ kind: 'cancelled', text: '{}' })).toBeNull();
    expect(readSettlement({ kind: 'error', text: 7 })).toBeNull();
    expect(readSettlement({ kind: 'ok', observedBytes: 3 })).toBeNull();
    expect(readSettlement({ kind: 'error', text: '{}', observedBytes: 1, extra: 1 })).toBeNull();
  });

  it('the raw budget is charged observedBytes for every kind, not the text length; legacy receipts fall back to text length', () => {
    const l = ledger({ maxInFlight: 2 });
    const a = started(l, 1);
    const b = started(l, 2);
    l.settle(a, { kind: 'ok', text: '{}', observedBytes: 500 });
    l.settle(b, { kind: 'unknown', observedBytes: 70 });
    const c = started(l, 3);
    l.settle(c, { kind: 'error', text: '{"content":[],"isError":true}', observedBytes: 41 });
    const legacy = started(l, 4);
    l.settle(legacy, ok('[1,2,3]'));
    const legacyErr = started(l, 5);
    l.settle(legacyErr, { kind: 'error' });
    const s = l.snapshot();
    expect(s.entries.map((e) => [e.state, e.responseBytes])).toEqual([['succeeded', 500], ['unknown', 70], ['failed', 41], ['succeeded', 7], ['failed', null]]);
    expect(s.hostBytes).toBe(500 + 70 + 41 + 7);
    expect(l.rawRemaining).toBe(RUN_LIMITS.responseBytes - 618);
  });

  it('a budget exhausted by unknown bodies refuses the next call before it reaches the host', () => {
    // Exact: an unknown body of the whole budget exhausts it; one under leaves room for the next call.
    const under = ledger({ responseBytes: 1000 });
    under.settle(started(under, 1), { kind: 'unknown', observedBytes: 999 });
    expect(under.admit(2, 'get_map', '{}').kind).toBe('dispatch');
    const exact = ledger({ responseBytes: 1000 });
    exact.settle(started(exact, 1), { kind: 'unknown', observedBytes: 1000 });
    expect(exact.snapshot()).toMatchObject({ hostBytes: 1000, unknown: 1 });
    expect(exact.admit(2, 'get_map', '{}')).toMatchObject({ kind: 'refuse', reason: 'response-budget-exhausted' });
    expect(exact.rawRemaining).toBe(0);
  });

  it('an error with its result is delivered as data and stays failed; a non-JSON result keeps failed with response-not-json', () => {
    const l = ledger();
    const text = '{"content":[{"type":"text","text":"not a member"}],"isError":true}';
    expect(l.settle(started(l, 1), { kind: 'error', text, observedBytes: text.length })).toEqual({ ok: true, text });
    expect(l.settle(started(l, 2), { kind: 'error', text: `not json ${SECRET}`, observedBytes: 5 })).toEqual({ ok: false, message: GUEST_MESSAGES.failed });
    const s = l.snapshot();
    expect(s.entries.map((e) => [e.state, e.deliveryFailure])).toEqual([['failed', null], ['failed', 'response-not-json']]);
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it('an undeliverable result keeps the receipt: failed and succeeded both stay terminal with response-budget', () => {
    const l = ledger();
    const e1 = started(l, 1);
    const e2 = started(l, 2);
    l.settle(e1, { kind: 'error', text: '{}', observedBytes: 2 });
    l.settle(e2, { kind: 'ok', text: '{}', observedBytes: 2 });
    l.markUndeliverable(e1);
    l.markUndeliverable(e2);
    expect(l.snapshot().entries.map((e) => [e.state, e.deliveryFailure])).toEqual([['failed', 'response-budget'], ['succeeded', 'response-budget']]);
    expect(l.allSettled).toBe(true);
  });
});

describe('T5b2: the typed dispatch edge', () => {
  it('is asked last, with the admitted call and ordinal; ok dispatches', () => {
    const l = ledger();
    const seen: unknown[] = [];
    const a = l.admit(1, 'read_room', '{"room":"r-1"}', (call, ordinal) => { seen.push([call.method, call.argsText, call.args, ordinal]); return { ok: true }; });
    expect(a).toMatchObject({ kind: 'dispatch', entry: { state: 'dispatched', policy: null } });
    expect(seen).toEqual([['read_room', '{"room":"r-1"}', { room: 'r-1' }, 1]]);
    // Not asked when an earlier check already refused or violated.
    let asked = 0;
    const edge = () => { asked++; return { ok: true } as const; };
    l.admit(1, 'get_map', '{}', edge);
    l.admit(2, 'get_map', 'not json', edge);
    l.admit(3, 'read_room', '{}', edge);
    expect(asked).toBe(0);
  });

  it('a policy refusal is a refused entry with zero dispatch evidence that counts toward the call budget', () => {
    const l = ledger({ maxRpcs: 2 });
    const a = l.admit(1, 'get_map', '{}', () => ({ ok: false, reason: 'policy', policy: 'revoked', terminal: true }));
    expect(a).toMatchObject({ kind: 'refuse', reason: 'policy', entry: { state: 'refused', refusal: 'policy', policy: 'revoked', argsText: null } });
    expect(l.admit(2, 'get_map', '{}', () => ({ ok: false, reason: 'transport-too-large' }))).toMatchObject({ kind: 'refuse', reason: 'transport-too-large', entry: { policy: null } });
    expect(l.admit(3, 'get_map', '{}')).toMatchObject({ kind: 'violation', reason: 'call-budget' });
    expect(l.snapshot()).toMatchObject({ dispatched: 0, inFlight: 0, refused: 3 });
    expect(l.evidence().map((e) => [e.dispatched, e.outcome])).toEqual([[false, 'refused'], [false, 'refused']]);
  });

  it('fails closed: a malformed verdict, an unknown policy, a proxy or a throw is run-ended', () => {
    const malformed: unknown[] = [false, true, null, undefined, 'ok', { ok: true, extra: 1 }, { ok: 'true' }, { ok: false }, { ok: false, reason: 'later' },
      { ok: false, reason: 'policy', policy: 'allow', terminal: false }, { ok: false, reason: 'policy', policy: 'deny' }, { ok: false, reason: 'policy', policy: 'deny', terminal: 'yes' },
      new Proxy({ ok: true }, {})];
    const l = ledger({ maxRpcs: 32 });
    let rid = 0;
    for (const v of malformed) expect(l.admit(++rid, 'get_map', '{}', () => v as never), String(v)).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(l.admit(++rid, 'get_map', '{}', () => { throw new Error('edge'); })).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(l.snapshot().dispatched).toBe(0);
  });

  it('awaitingReceipt and waitForReceipts count dispatched and draining calls', async () => {
    const l = ledger();
    const a = started(l, 1);
    l.stopAdmission();
    expect([l.inFlight, l.awaitingReceipt]).toEqual([0, 1]);
    expect(await l.waitForReceipts(20)).toBe(false);
    setTimeout(() => l.settle(a, { kind: 'ok', text: '{}', observedBytes: 2 }), 10);
    expect(await l.waitForReceipts(1000)).toBe(true);
  });

  it('a preflight still pending when the run returned reads as such in busy', () => {
    const sched = new SessionScheduler();
    const lease = sched.acquire((runId) => new RunLedger(runId, VAL, REV, ['get_map'], RUN_LIMITS));
    if (!lease.ok) throw new Error('lease');
    lease.lease.ledger.markPreflightPending();
    lease.lease.ledger.stopAdmission();
    expect(sched.acquire((runId) => new RunLedger(runId, VAL, REV, ['get_map'], RUN_LIMITS))).toMatchObject({ ok: false, reason: 'busy: previous run preflight pending' });
    lease.lease.ledger.lifecycleClosed();
    expect(lease.lease.ledger.preflightPending).toBe(false);
  });
});

describe('T5b2 r4: the edge verdict is read without running caller code (s-290 m-4409)', () => {
  const admitWith = (v: unknown) => { const l = ledger(); return { l, a: l.admit(1, 'get_map', '{}', () => v as never) }; };

  it('an accessor anywhere is never invoked and refuses: ok, reason, policy, terminal', () => {
    let reads = 0;
    const getter = (value: unknown) => ({ get: () => { reads++; return value; }, enumerable: true, configurable: true });
    const shapes = [
      Object.defineProperty({}, 'ok', getter(true)),
      Object.defineProperty({ ok: false }, 'reason', getter('run-ended')),
      Object.defineProperty({ ok: false, reason: 'policy', terminal: false }, 'policy', getter('deny')),
      Object.defineProperty({ ok: false, reason: 'policy', policy: 'deny' }, 'terminal', getter(false)),
    ];
    for (const v of shapes) {
      const { l, a } = admitWith(v);
      expect(a).toMatchObject({ kind: 'refuse', reason: 'run-ended', entry: { state: 'refused', policy: null } });
      expect(l.snapshot().dispatched).toBe(0);
    }
    expect(reads).toBe(0);
  });

  it('a getter that would advance a clock past the deadline is never run, so it cannot cross time or dispatch', () => {
    let now = 0;
    const v = Object.defineProperty({}, 'ok', { get: () => { now = 1e9; return true; }, enumerable: true });
    const { l, a } = admitWith(v);
    expect(a).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(now).toBe(0);
    expect(l.snapshot().dispatched).toBe(0);
  });

  it('arrays, hidden and symbol extras, class instances, inherited fields and boxed values refuse', () => {
    class Verdict { ok = true; }
    const hidden = Object.defineProperty({ ok: true }, 'extra', { value: 1, enumerable: false });
    const symbolExtra = { ok: true, [Symbol('x')]: 1 };
    const policySymbol = { ok: false, reason: 'policy', policy: 'deny', terminal: false, [Symbol('y')]: 1 };
    const cases: unknown[] = [Object.assign([], { ok: true }), hidden, symbolExtra, policySymbol, new Verdict(), Object.create({ ok: true }), Object(true), new Proxy({ ok: true }, {}), Object.create({ ok: true }, { ok: { value: true, enumerable: true } })];
    for (const v of cases) {
      const { l, a } = admitWith(v);
      expect(a, String(Object.prototype.toString.call(v))).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
      expect(l.snapshot().dispatched).toBe(0);
    }
  });

  it('a hostile proxy trap is never reached', () => {
    let traps = 0;
    const handler: ProxyHandler<object> = { get: () => { traps++; return true; }, ownKeys: () => { traps++; return ['ok']; }, getPrototypeOf: () => { traps++; return Object.prototype; }, getOwnPropertyDescriptor: () => { traps++; return { value: true, enumerable: true, configurable: true }; } };
    const { a } = admitWith(new Proxy({}, handler));
    expect(a).toMatchObject({ kind: 'refuse', reason: 'run-ended' });
    expect(traps).toBe(0);
  });

  it('exact plain shapes still work, null-prototype included, and the verdict is a fresh frozen copy', () => {
    const np = Object.assign(Object.create(null) as Record<string, unknown>, { ok: true });
    expect(admitWith(np).a).toMatchObject({ kind: 'dispatch' });
    const policyNp = Object.assign(Object.create(null) as Record<string, unknown>, { ok: false, reason: 'policy', policy: 'stale', terminal: true });
    expect(admitWith(policyNp).a).toMatchObject({ kind: 'refuse', reason: 'policy', entry: { policy: 'stale' } });
    expect(admitWith({ ok: false, reason: 'transport-too-large' }).a).toMatchObject({ kind: 'refuse', reason: 'transport-too-large' });
    // Mutating the caller's object after admission changes nothing recorded.
    const v: Record<string, unknown> = { ok: false, reason: 'policy', policy: 'deny', terminal: false };
    const { l } = admitWith(v);
    v['policy'] = 'stale';
    expect(l.snapshot().entries[0]).toMatchObject({ refusal: 'policy', policy: 'deny' });
  });
});
