// The agent view of an execute result (contract v4): what `code_execute` sends the agent. The parent computes and checks the full result; the view
// drops only what the agent cannot act on. Every status, error, completeness marker, limit and non-clean operation must still reach the agent.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { buildCatalog } from './catalog.js';
import {
  BUSY_REASONS,
  CALLS_NOT_MADE_CAUSES,
  CONTRACT_LIMITS,
  CONTRACT_VERSION,
  ContractError,
  ERROR_MESSAGES,
  LIMIT_NAMES,
  type AgentView,
  type CallValidators,
  type DiagnosticInput,
  type ExecuteResult,
  type ExecuteResultInput,
  type OperationEvidence,
  type OperationEvidenceInput,
  agentViewProblem,
  compileCallValidators,
  computeApiRevision,
  makeExecuteResult,
  operationEvidence,
  parseExecuteResult,
  renderAgentView,
  serializeExecuteResult,
  usableDiagnostics,
} from './contracts.js';

const catalog = buildCatalog(TOOLS);
const REV = computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
const OTHER = computeApiRevision({ catalog, launch: 'fixture-launch-2', policySnapshot: 'unavailable' });
const VAL = compileCallValidators(catalog, REV);
const OTHER_VAL = compileCallValidators(catalog, OTHER);
/** The catalogue's own reads: the run's catalogue, as `code_execute` gives it. */
const READS = new Set(catalog.entries.filter((e) => e.documented && e.effect === 'read').map((e) => e.name));
const isRead = (m: string): boolean => READS.has(m);

const evidence = (ordinal: number, over: Partial<OperationEvidenceInput> = {}, v: CallValidators = VAL): OperationEvidence =>
  operationEvidence(v, { ordinal, method: 'get_map', args: { session: `s-${ordinal}` }, dispatched: true, outcome: 'succeeded', responseBytes: 100, incomplete: false, ...over });
const result = (over: Partial<ExecuteResultInput> = {}, v: CallValidators = VAL): ExecuteResult =>
  makeExecuteResult(v, { runId: 'run-1', status: 'completed', value: { count: 9 }, operations: [evidence(1)], ...over });
const view = (r: ExecuteResult, reads: (m: string) => boolean = isRead): AgentView => JSON.parse(renderAgentView(VAL, r, reads)) as AgentView;
const text = (r: ExecuteResult, reads: (m: string) => boolean = isRead): string => renderAgentView(VAL, r, reads);
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof ContractError) return e.code; throw e; }
  return 'ok';
};
const limitDiag = (limit: string): DiagnosticInput => ({ code: 'limit-reached', params: { limit } });
const failedDiag = (ordinal: number): DiagnosticInput => ({ code: 'call-failed', params: { ordinal, method: 'get_map' } });
/** The view without one key: how a tampered view is built. */
const without = (v: AgentView, key: keyof AgentView): AgentView => { const copy: Record<string, unknown> = { ...v }; delete copy[key]; return copy as unknown as AgentView; };
const row = (op: OperationEvidence) => ({ ordinal: op.ordinal, method: op.method, dispatched: op.dispatched, outcome: op.outcome, incomplete: op.incomplete });

describe('the contract version', () => {
  it('is 4: the MCP text of code_execute changed shape, and the version is part of every apiRevision', () => {
    expect(CONTRACT_VERSION).toBe(4);
    expect(result().contract).toBe(4);
  });
});

describe('a completed run', () => {
  it('T1: a clean read is the status, the completeness and the value; nothing else', () => {
    const v = view(result());
    expect(Object.keys(v)).toEqual(['status', 'incomplete', 'value']);
    expect(v).toEqual({ status: 'completed', incomplete: false, value: { count: 9 } });
  });

  it('T2: only an operation that is not a clean success is listed; the clean ones around it are not', () => {
    const ops = [evidence(1), evidence(2, { incomplete: true }), evidence(3)];
    const v = view(result({ operations: ops }));
    expect(v.incomplete).toBe(true);
    expect(v.operations).toEqual([row(ops[1]!)]);
  });

  it('T3: a caught failed call keeps its row and its diagnostic, and the run is incomplete', () => {
    const ops = [evidence(1, { outcome: 'failed' })];
    const v = view(result({ operations: ops, diagnostics: [failedDiag(1)], incomplete: true }));
    expect(v).toMatchObject({ status: 'completed', incomplete: true, operations: [{ ordinal: 1, outcome: 'failed' }], diagnostics: [{ code: 'call-failed', message: 'call 1 (get_map) returned an error' }] });
  });

  it('T4: a limit the guest refused on its own has no operation and still arrives, and a broker-refused call keeps its row', () => {
    const refused = evidence(2, { dispatched: false, outcome: 'refused', responseBytes: null });
    const v = view(result({ operations: [evidence(1), refused], diagnostics: [limitDiag('operations')], incomplete: true }));
    expect(v.diagnostics).toEqual([{ code: 'limit-reached', params: { limit: 'operations' }, message: 'limit reached: operations' }]);
    expect(v.operations).toEqual([row(refused)]);
  });

  it('T14: an operation that is not a catalogue read is listed even on a clean, complete run (F1 receipts), and a clean read is not', () => {
    const ops = [evidence(1), evidence(2, { method: 'read_room' })];
    const v = view(result({ operations: ops }), (m) => m === 'read_room');
    expect(v.operations).toEqual([row(ops[0]!)]);
    expect(v.incomplete).toBe(false);
    // a method the catalogue does not name is not a read either
    expect(view(result({ operations: ops }), () => false).operations).toEqual(ops.map(row));
  });

  it('T13: a value whose own keys are status, error or incomplete stays inside value: the top-level keys are the rule\'s', () => {
    const hostile = { status: 'error', error: { kind: 'x', message: 'y' }, incomplete: false, operations: [], runId: 'run-evil', diagnostics: [] };
    const v = view(result({ value: hostile }));
    expect(Object.keys(v)).toEqual(['status', 'incomplete', 'value']);
    expect(v.status).toBe('completed');
    expect(v.value).toEqual(hostile);
  });

  it('T15: a clean one-operation answer is the value bytes plus at most 60', () => {
    for (const value of [1, 'abc', { count: 9 }, { a: ['x'.repeat(500)] }]) {
      const valueBytes = Buffer.byteLength(JSON.stringify(value));
      expect(Buffer.byteLength(text(result({ value })))).toBeLessThanOrEqual(valueBytes + 60);
    }
  });
});

describe('E-1 and E-1b: an incomplete completed run always says why', () => {
  it('T16 (E-1): incomplete from the broker claim alone, every operation a clean read, no diagnostic: all rows are listed', () => {
    const ops = [evidence(1), evidence(2)];
    const v = view(result({ operations: ops, incomplete: true }));
    expect(v.incomplete).toBe(true);
    expect(v.operations).toEqual(ops.map(row));
  });

  it('E-1: a row that explains it (not a clean success) is enough; the clean ones stay out', () => {
    const ops = [evidence(1), evidence(2, { incomplete: true })];
    expect(view(result({ operations: ops })).operations).toEqual([row(ops[1]!)]);
  });

  it('E-1: only a clean non-read row does not explain it, so the rows are all listed', () => {
    const ops = [evidence(1), evidence(2, { method: 'read_room' })];
    const v = view(result({ operations: ops, incomplete: true }), (m) => m === 'read_room');
    expect(v.operations).toEqual(ops.map(row));
  });

  it('E-1b: a bare incomplete (no operation, no diagnostic) is refused, never shown as a claim without a reason', () => {
    expect(codeOf(() => text(result({ operations: [], incomplete: true })))).toBe('invalid-output');
  });

  it('E-1b: calls-not-made is the reason when there is no operation; both causes render from fixed templates', () => {
    const diagnostics: DiagnosticInput[] = [{ code: 'calls-not-made', params: { cause: 'refused-in-script', count: 2 } }, { code: 'calls-not-made', params: { cause: 'not-started', count: 1 } }];
    const v = view(result({ operations: [], diagnostics, incomplete: true }));
    expect(v.operations).toBeUndefined();
    expect(v.diagnostics!.map((d) => d.message)).toEqual([
      '2 call(s) refused inside the script: unknown method or arguments not JSON',
      '1 call(s) started by the script never left it',
    ]);
    expect([...CALLS_NOT_MADE_CAUSES]).toEqual(['refused-in-script', 'not-started']);
  });

  it('E-1b: the count is closed at the run\'s call ceiling: the ceiling is accepted, one more is refused', () => {
    for (const cause of CALLS_NOT_MADE_CAUSES) {
      const at = (count: number) => result({ operations: [], diagnostics: [{ code: 'calls-not-made', params: { cause, count } }], incomplete: true });
      expect(view(at(CONTRACT_LIMITS.operationsMax)).diagnostics).toHaveLength(1);
      expect(codeOf(() => at(CONTRACT_LIMITS.operationsMax + 1)), cause).toBe('invalid-output');
    }
  });

  it('E-1b: usableDiagnostics keeps every diagnostic that is valid on its own, in order, and an omitted one is told by diagnosticsTruncated', () => {
    const ops = [evidence(1)];
    const over: DiagnosticInput = { code: 'calls-not-made', params: { cause: 'not-started', count: CONTRACT_LIMITS.operationsMax + 1 } };
    const fine: DiagnosticInput[] = [limitDiag('wall-time'), { code: 'call-failed', params: { ordinal: 1, method: 'get_map' } }];
    expect(usableDiagnostics([fine[0]!, over, fine[1]!], ops)).toEqual(fine);
    expect(usableDiagnostics([{ code: 'call-failed', params: { ordinal: 9, method: 'get_map' } }, { code: 'nope', params: {} } as never], ops)).toEqual([]);
    const kept = result({ operations: ops, diagnostics: fine, diagnosticsOmitted: true, incomplete: true });
    expect(kept.diagnosticsTruncated).toBe(true);
    expect(view(kept).diagnosticsTruncated).toBe(true);
    expect(result({ operations: ops, diagnostics: fine, incomplete: true }).diagnosticsTruncated).toBe(false);
  });

  it('E-1b: the diagnostic has a closed cause and a count of at least one, and no free text', () => {
    for (const params of [{ cause: 'other', count: 1 }, { cause: 'not-started', count: 0 }, { cause: 'not-started', count: 1.5 }, { cause: 'not-started', count: 1, note: 'x' }, { count: 1 }, { cause: 'not-started', count: CONTRACT_LIMITS.operationsMax + 1 }, { cause: 'refused-in-script', count: Number.MAX_SAFE_INTEGER }]) {
      expect(codeOf(() => result({ operations: [], diagnostics: [{ code: 'calls-not-made', params: params as never }], incomplete: true })), JSON.stringify(params)).toBe('invalid-output');
    }
  });
});

describe('an error before any run', () => {
  const pre = (kind: 'invalid-request' | 'stale-revision' | 'unavailable' | 'busy', diagnostics: DiagnosticInput[] = []) =>
    result({ runId: null, status: 'error', value: null, error: { kind }, operations: [], diagnostics });

  it('T5: each kind carries its fixed message and nothing about a run; the answer is an error', () => {
    for (const kind of ['invalid-request', 'stale-revision', 'unavailable'] as const) {
      expect(view(pre(kind)), kind).toEqual({ status: 'error', incomplete: true, error: { kind, message: ERROR_MESSAGES[kind] } });
    }
  });

  it('T5: busy carries its one diagnostic and that diagnostic\'s exact text, for every reason', () => {
    for (const reason of BUSY_REASONS) {
      const v = view(pre('busy', [{ code: 'busy', params: { reason } }]));
      expect(v.error).toEqual({ kind: 'busy', message: ERROR_MESSAGES.busy });
      expect(v.diagnostics).toHaveLength(1);
      expect(v.diagnostics![0]).toMatchObject({ code: 'busy', params: { reason } });
      expect(v.diagnostics![0]!.message.length).toBeGreaterThan(10);
      expect(v.runId).toBeUndefined();
    }
  });
});

describe('an error after a run started', () => {
  const RUN_KINDS = (Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[]).filter((k) => !['invalid-request', 'stale-revision', 'busy', 'unsettled'].includes(k));

  it('T6: every kind a started run can end with: its kind and text, the run id, every row (clean reads too), and an error', () => {
    expect(RUN_KINDS.length).toBe(9);
    for (const kind of RUN_KINDS) {
      const ops = [evidence(1), evidence(2, { dispatched: false, outcome: 'refused', responseBytes: null })];
      const v = view(result({ status: 'error', value: null, error: { kind }, operations: ops }));
      expect(v, kind).toEqual({ status: 'error', incomplete: true, error: { kind, message: ERROR_MESSAGES[kind] }, runId: 'run-1', operations: ops.map(row) });
      expect(v.value).toBeUndefined();
    }
  });

  it('T7: partial-or-unknown keeps the status, the unsettled kind, the unknown row marked incomplete and its diagnostic', () => {
    const ops = [evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true })];
    const v = view(result({ status: 'partial-or-unknown', value: null, error: { kind: 'unsettled' }, operations: ops, diagnostics: [{ code: 'call-unsettled', params: { ordinal: 1, method: 'get_map' } }] }));
    expect(v).toMatchObject({ status: 'partial-or-unknown', incomplete: true, error: { kind: 'unsettled' }, runId: 'run-1', operations: [{ outcome: 'unknown', incomplete: true }], diagnostics: [{ code: 'call-unsettled' }] });
  });

  it('T8: every limit name reaches the agent, on any status', () => {
    for (const limit of LIMIT_NAMES) {
      const done = view(result({ diagnostics: [limitDiag(limit)], incomplete: true }));
      expect(done.diagnostics, limit).toEqual([{ code: 'limit-reached', params: { limit }, message: `limit reached: ${limit}` }]);
      const failed = view(result({ status: 'error', value: null, error: { kind: 'quota' }, diagnostics: [limitDiag(limit)] }));
      expect(failed.diagnostics![0]).toMatchObject({ code: 'limit-reached', params: { limit } });
    }
  });

  it('T9: diagnosticsTruncated is present when true and absent when false', () => {
    const many = Array.from({ length: 17 }, () => limitDiag('memory'));
    const cut = result({ diagnostics: many, incomplete: true });
    expect(cut.diagnosticsTruncated).toBe(true);
    expect(view(cut).diagnosticsTruncated).toBe(true);
    const whole = view(result({ diagnostics: [limitDiag('memory')], incomplete: true }));
    expect('diagnosticsTruncated' in whole).toBe(false);
  });
});

describe('what stays in the parent', () => {
  it('the view drops the contract number, the revision, the hashes and the response sizes, and never the other way', () => {
    const t = text(result({ operations: [evidence(1, { incomplete: true })] }));
    for (const gone of ['"contract"', '"apiRevision"', '"argsSha256"', '"responseBytes"', REV]) expect(t).not.toContain(gone);
    const full = serializeExecuteResult(VAL, result({ operations: [evidence(1, { incomplete: true })] }));
    for (const kept of ['"contract":4', '"argsSha256"', '"responseBytes"', REV]) expect(full).toContain(kept);
  });

  it('T10: over every kind of result, the view\'s status, completeness, error kind and limits equal the result\'s', () => {
    const cases: ExecuteResult[] = [
      result(),
      result({ operations: [evidence(1, { incomplete: true }), evidence(2)] }),
      result({ diagnostics: [limitDiag('result-bytes')], incomplete: true }),
      result({ status: 'error', value: null, error: { kind: 'tool-error' }, operations: [evidence(1, { outcome: 'failed' })], diagnostics: [failedDiag(1)] }),
      result({ status: 'partial-or-unknown', value: null, error: { kind: 'unsettled' }, operations: [evidence(1, { outcome: 'draining', responseBytes: null, incomplete: true })] }),
      result({ runId: null, status: 'error', value: null, error: { kind: 'stale-revision' }, operations: [] }),
      result({ status: 'error', value: null, error: { kind: 'timeout' }, diagnostics: [limitDiag('wall-time'), limitDiag('active-time')] }),
    ];
    for (const full of cases) {
      const v = view(full);
      expect(v.status).toBe(full.status);
      expect(v.incomplete).toBe(full.incomplete);
      expect(v.error?.kind).toBe(full.error?.kind);
      const limits = (ds: readonly { code: string; params: Record<string, unknown> }[] | undefined) => (ds ?? []).filter((d) => d.code === 'limit-reached').map((d) => d.params.limit).sort();
      expect(limits(v.diagnostics as never)).toEqual(limits(full.diagnostics as never));
      expect(parseExecuteResult(VAL, serializeExecuteResult(VAL, full))).toEqual(full);
    }
  });
});

describe('the full result is still checked first', () => {
  it('T11: a result of another revision, or with a method that is not the handle\'s, is refused and nothing is rendered', () => {
    const foreign = result({ operations: [evidence(1)] }, OTHER_VAL);
    expect(codeOf(() => renderAgentView(VAL, foreign, isRead))).toBe('invalid-output');
    const forged = { ...result(), operations: [{ ...evidence(1), method: 'not_in_handle' }] } as unknown as ExecuteResult;
    expect(codeOf(() => renderAgentView(VAL, forged, isRead))).toBe('invalid-output');
    const broken = { ...result(), status: 'error' } as unknown as ExecuteResult;
    expect(codeOf(() => renderAgentView(VAL, broken, isRead))).toBe('invalid-output');
  });

  it('M11: a result that breaks an invariant of the full contract is refused by the view even though the view would be well formed', () => {
    const lying = { ...result({ operations: [evidence(1, { incomplete: true })] }), incomplete: false } as unknown as ExecuteResult;
    expect(codeOf(() => renderAgentView(VAL, lying, isRead))).toBe('invalid-output');
  });
});

describe('agentViewProblem: the view may say less than the result, never something else', () => {
  const full = result({ operations: [evidence(1), evidence(2, { incomplete: true })], diagnostics: [limitDiag('operations')], incomplete: true });
  // rendered inside each test, so a renderer that breaks fails the tests that need it by name instead of the whole file at collection
  const goodView = (): AgentView => view(full);

  it('accepts the view the renderer makes, for every case above', () => {
    expect(agentViewProblem(goodView(), full, isRead)).toBeNull();
  });

  it('M12: refuses each tampered view', () => {
    const good = goodView();
    const tampered: [string, AgentView][] = [
      ['status', { ...good, status: 'error' }],
      ['completeness lowered', { ...good, incomplete: false }],
      ['value changed', { ...good, value: { count: 10 } }],
      ['value missing', without(good, 'value')],
      ['an error on a completed view', { ...good, error: { kind: 'runtime', message: ERROR_MESSAGES.runtime } }],
      ['a run id on a completed view', { ...good, runId: 'run-1' }],
      ['rows dropped', without(good, 'operations')],
      ['a row changed', { ...good, operations: [{ ...good.operations![0]!, outcome: 'succeeded', incomplete: false }] }],
      ['the limit dropped', without(good, 'diagnostics')],
      ['another limit', { ...good, diagnostics: [{ ...good.diagnostics![0]!, params: { limit: 'memory' }, message: 'limit reached: memory' }] }],
      ['truncated claimed', { ...good, diagnosticsTruncated: true }],
    ];
    for (const [name, v] of tampered) expect(agentViewProblem(v, full, isRead), name).not.toBeNull();
  });

  it('refuses a non-completed view that lost its error, its run id or a row, and a completed-looking error', () => {
    const failed = result({ status: 'error', value: null, error: { kind: 'runtime' }, operations: [evidence(1)] });
    const okView = view(failed);
    expect(agentViewProblem(okView, failed, isRead)).toBeNull();
    expect(agentViewProblem(without(okView, 'error'), failed, isRead)).not.toBeNull();
    expect(agentViewProblem(without(okView, 'runId'), failed, isRead)).toBe('runId');
    expect(agentViewProblem({ ...okView, runId: 'run-2' }, failed, isRead)).toBe('runId');
    expect(agentViewProblem({ ...okView, operations: undefined } as AgentView, failed, isRead)).toBe('operations');
    expect(agentViewProblem({ ...okView, value: { count: 9 } }, failed, isRead)).not.toBeNull();
    expect(agentViewProblem({ ...okView, status: 'completed' }, failed, isRead)).not.toBeNull();
  });

  it('E-1: a view of an unexplained incomplete that lists no rows is refused', () => {
    const claim = result({ operations: [evidence(1)], incomplete: true });
    expect(agentViewProblem({ status: 'completed', incomplete: true, value: { count: 9 } }, claim, isRead)).toBe('operations');
    expect(agentViewProblem(view(claim), claim, isRead)).toBeNull();
  });
});
