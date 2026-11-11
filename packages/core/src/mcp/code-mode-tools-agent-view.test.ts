// The agent view through the wrappers (contract v4): the reachable error kinds, the catalogue the view is made against, and the answers when the
// view itself cannot be made. Stubbed brokers only; the real helper and broker are in code-mode-tools.test.ts.
import { vi, describe, expect, it } from 'vitest';
import type { Broker, BrokerRunResult } from './code-mode/broker.js';
import { type Catalog, INITIAL_COHORT, buildCatalog } from './code-mode/catalog.js';
import { ERROR_MESSAGES, compileCallValidators, computeApiRevision, operationEvidence } from './code-mode/contracts.js';
import { createCodeModeSurface } from './code-mode-tools.js';
import { TOOLS } from './tools.js';

// `renderAgentView` is replaced by a switch: it renders for real unless a test says it fails, so every other check stays the product's.
const render = vi.hoisted(() => ({ failFirst: 0, calls: 0 }));
vi.mock('./code-mode/contracts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./code-mode/contracts.js')>();
  return {
    ...real,
    renderAgentView: (...args: Parameters<typeof real.renderAgentView>): string => {
      render.calls++;
      if (render.calls <= render.failFirst) throw new real.ContractError('invalid-output', [], 'agent view: forced');
      return real.renderAgentView(...args);
    },
  };
});

const catalog = buildCatalog(TOOLS);
const LAUNCH = 'launch-fixture-1';
const POLICY = `np1.${'a'.repeat(64)}`;
const REVISION = computeApiRevision({ catalog, launch: LAUNCH, policySnapshot: POLICY });
const VAL = compileCallValidators(catalog, REVISION);
const NO_REFUSALS = { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 };
const text = (r: { content: unknown }): string => (r.content as { text: string }[])[0]!.text;
const view = (r: { content: unknown }): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>;
const evidence = (ordinal: number, over: Record<string, unknown> = {}) => operationEvidence(VAL, { ordinal, method: 'get_map', args: {}, dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false, ...over } as never);
const rowOf = (ordinal: number, over: Record<string, unknown> = {}) => ({ ordinal, method: 'get_map', dispatched: true, outcome: 'succeeded', incomplete: false, ...over });

function stubBroker(run: () => BrokerRunResult, methods: readonly string[] = ['get_map']): Broker {
  return {
    launch: { launchId: LAUNCH, apiRevision: REVISION, sourceId: 'fixture-policy', authority: 'fixture', policyRevision: 'p1', policySnapshot: POLICY, methods: Object.freeze([...methods]) },
    stashSize: () => 0,
    run: vi.fn(async () => run()),
  } as never;
}
function helperResult(over: Partial<BrokerRunResult> = {}): BrokerRunResult {
  return {
    audit: [], incomplete: false, status: 'finished', cleanup: 'confirmed', runStatus: 'completed', runId: 'run-9-1', reason: null, spawned: true, hostCalls: 0,
    ledger: { entries: [] } as never, evidence: [], drained: null, outcome: { ok: true, value: '{"n":1}', rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS },
    probes: null, listenerHits: null, launch: null, helperProfileSha256: null, timings: { preflightMs: 0, selfTestMs: 0, totalMs: 0 }, peakRssKb: 0,
    killedBy: null, maxPendingBytes: 0, preflight: null, ...over,
  } as BrokerRunResult;
}
const surfaceOf = (broker: Broker, cat: Catalog = catalog) => createCodeModeSurface({ backend: () => ({ catalog: cat, launchId: LAUNCH, broker }) });
const execute = (s: ReturnType<typeof surfaceOf>) => s.call('code_execute', { code: 'return 1', apiRevision: REVISION });
const failing = (guest: { kind: string }) => ({ ok: false as const, error: { kind: guest.kind, message: 'SECRET-GUEST-TEXT' }, rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS });

describe('T6: every error kind a run can end with reaches the view with its text, its run id and every row', () => {
  const ops = [evidence(1), evidence(2, { dispatched: false, outcome: 'refused', responseBytes: null })];
  const cases: [string, keyof typeof ERROR_MESSAGES, Partial<BrokerRunResult>][] = [
    ['cancelled', 'cancelled', { status: 'cancelled', runStatus: 'error' }],
    ['wall-time', 'timeout', { status: 'wall-time', runStatus: 'error' }],
    ['quota', 'quota', { status: 'quota', runStatus: 'error' }],
    ['violation', 'helper-failure', { status: 'violation', runStatus: 'error' }],
    ['crashed', 'helper-failure', { status: 'crashed', runStatus: 'error' }],
    ['policy', 'unavailable', { status: 'policy', runStatus: 'error' }],
    ['unavailable after the lease', 'unavailable', { status: 'unavailable', runStatus: 'error' }],
    ['a syntax error', 'syntax', { runStatus: 'error', outcome: failing({ kind: 'syntax' }) }],
    ['a runtime error', 'runtime', { runStatus: 'error', outcome: failing({ kind: 'runtime' }) }],
    ['a deadlock', 'runtime', { runStatus: 'error', outcome: failing({ kind: 'deadlock' }) }],
    ['the CPU limit', 'timeout', { runStatus: 'error', outcome: failing({ kind: 'interrupted' }) }],
    ['a result error', 'invalid-output', { runStatus: 'error', outcome: failing({ kind: 'result' }) }],
    ['a result-size error', 'invalid-output', { runStatus: 'error', outcome: failing({ kind: 'result-size' }) }],
    ['a memory error', 'quota', { runStatus: 'error', outcome: failing({ kind: 'memory' }) }],
    ['a protocol error', 'helper-failure', { runStatus: 'error', outcome: failing({ kind: 'protocol' }) }],
  ];
  it.each(cases)('%s -> %s', async (_name, kind, over) => {
    const r = await execute(surfaceOf(stubBroker(() => helperResult({ evidence: ops, ...over }))));
    const v = view(r);
    expect(r.isError).toBe(true);
    expect(v).toMatchObject({ status: 'error', incomplete: true, error: { kind, message: ERROR_MESSAGES[kind] }, runId: 'run-9-1', operations: [rowOf(1), rowOf(2, { dispatched: false, outcome: 'refused' })] });
    expect(v['value']).toBeUndefined();
    expect(text(r)).not.toContain('SECRET-GUEST-TEXT');
  });

  it('unsettled: a call with no outcome is partial-or-unknown, an error to the client, with its row', async () => {
    const unknown = evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true });
    const r = await execute(surfaceOf(stubBroker(() => helperResult({ runStatus: 'partial-or-unknown', evidence: [unknown], incomplete: true }))));
    expect(r.isError).toBe(true);
    expect(view(r)).toMatchObject({ status: 'partial-or-unknown', incomplete: true, error: { kind: 'unsettled' }, runId: 'run-9-1', operations: [rowOf(1, { outcome: 'unknown', incomplete: true })] });
  });

  it('the kinds no run produces are named: invalid-request, stale-revision and busy are before any run; tool-error is never produced by the mapping', () => {
    const produced = new Set(cases.map((c) => c[1]).concat(['unsettled']));
    const missing = (Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[]).filter((k) => !produced.has(k)).sort();
    expect(missing).toEqual(['busy', 'invalid-request', 'stale-revision', 'tool-error']);
  });
});

describe('V1 (T17): the view is made against the catalogue the run used', () => {
  const twoReads = (): BrokerRunResult => helperResult({ evidence: [evidence(1), evidence(2, { method: 'read_room' })] });

  it('the same run is listed differently by the catalogue that says read_room is not a read: its row is a receipt, get_map\'s clean row is not', async () => {
    const asRead = await execute(surfaceOf(stubBroker(twoReads)));
    expect(view(asRead)).toEqual({ status: 'completed', incomplete: false, value: { n: 1 } });
    const notRead: Catalog = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'read_room' ? { ...e, effect: 'write' as const } : e)) } as Catalog;
    const asWrite = await execute(surfaceOf(stubBroker(twoReads), notRead));
    expect(view(asWrite)).toEqual({ status: 'completed', incomplete: false, value: { n: 1 }, operations: [rowOf(2, { method: 'read_room' })] });
  });

  it('a run that names a method the run\'s own catalogue does not have is refused, never shown: the fixed failure text, not a view', async () => {
    const without: Catalog = { ...catalog, entries: catalog.entries.filter((e) => e.name !== 'read_room') } as Catalog;
    const r = await execute(surfaceOf(stubBroker(twoReads), without));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('The Code Mode tool failed.');
  });

  it('two surfaces over two catalogues do not share an answer: nothing is resolved at answer time from anything but the run\'s own backend', async () => {
    const notRead: Catalog = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'read_room' ? { ...e, effect: 'write' as const } : e)) } as Catalog;
    const a = surfaceOf(stubBroker(twoReads), notRead);
    const b = surfaceOf(stubBroker(twoReads));
    const [ra, rb] = [await execute(a), await execute(b)];
    expect(view(ra)['operations']).toHaveLength(1);
    expect(view(rb)['operations']).toBeUndefined();
    expect([...INITIAL_COHORT]).toContain('read_room');
  });
});

describe('V2 (T12): when the view cannot be made, the answer is an error that keeps the run id and the rows, and never a success', () => {
  const dispatched = (): BrokerRunResult => helperResult({ evidence: [evidence(1), evidence(2, { incomplete: true })] });

  it('one renderer failure: the invalid-output attempt, with the run id and every row', async () => {
    render.calls = 0; render.failFirst = 1;
    const r = await execute(surfaceOf(stubBroker(dispatched)));
    expect(r.isError).toBe(true);
    expect(view(r)).toEqual({ status: 'error', incomplete: true, error: { kind: 'invalid-output', message: ERROR_MESSAGES['invalid-output'] }, runId: 'run-9-1', operations: [rowOf(1), rowOf(2, { incomplete: true })] });
  });

  it('two renderer failures: the same error without the diagnostics, with the run id and every row', async () => {
    render.calls = 0; render.failFirst = 2;
    const r = await execute(surfaceOf(stubBroker(dispatched)));
    expect(r.isError).toBe(true);
    expect(view(r)).toEqual({ status: 'error', incomplete: true, error: { kind: 'invalid-output', message: ERROR_MESSAGES['invalid-output'] }, runId: 'run-9-1', operations: [rowOf(1), rowOf(2, { incomplete: true })] });
  });

  it('three renderer failures: the helper-failure attempt, with the run id and every row', async () => {
    render.calls = 0; render.failFirst = 3;
    const r = await execute(surfaceOf(stubBroker(dispatched)));
    expect(r.isError).toBe(true);
    expect(view(r)).toEqual({ status: 'error', incomplete: true, error: { kind: 'helper-failure', message: ERROR_MESSAGES['helper-failure'] }, runId: 'run-9-1', operations: [rowOf(1), rowOf(2, { incomplete: true })] });
  });

  it('every attempt fails: FAILED_TEXT, a fixed text with no rows. It is the only answer that has no receipt', async () => {
    render.calls = 0; render.failFirst = 99;
    const r = await execute(surfaceOf(stubBroker(dispatched)));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('The Code Mode tool failed.');
    render.failFirst = 0;
  });
});
