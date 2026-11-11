import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { type Catalog, INITIAL_COHORT, buildCatalog, canonicalSha256, declarationsFor } from './catalog.js';
import { MIGRATABLE_READS } from './migration-registry.js';
import { compileInputValidator } from './validation.js';
import {
  BUSY_REASONS,
  CONTRACT_LIMITS,
  CONTRACT_VERSION,
  type CallValidators,
  ContractError,
  ERROR_MESSAGES,
  type DocsItem,
  type ExecuteResult,
  type ExecuteResultInput,
  type OperationEvidence,
  type OperationEvidenceInput,
  type SearchItem,
  admitCall,
  admitExecute,
  assertFreshRevision,
  buildPage,
  compileCallValidators,
  computeApiRevision,
  decodeCursor,
  encodeCursor,
  makeExecuteResult,
  operationEvidence,
  parseDocsRequest,
  parseExecuteResult,
  parsePage,
  parseSearchRequest,
  requestKey,
  serializeExecuteResult,
  serializePage,
} from './contracts.js';

const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
const catalog = buildCatalog(TOOLS);
const REV = computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
const OTHER = computeApiRevision({ catalog, launch: 'fixture-launch-2', policySnapshot: 'unavailable' });

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    if (e instanceof ContractError) {
      expect(JSON.stringify({ m: e.message, ...e })).not.toContain('SYNTHETIC');
      return e.code;
    }
    throw e;
  }
  return 'ok';
};

/** A fixture dispatcher: the contract check runs first, and only an admitted request reaches it. */
function fixtureDispatch<T>(admit: () => T): { code: string; dispatched: number } {
  let dispatched = 0;
  const code = codeOf(() => { admit(); dispatched++; });
  return { code, dispatched };
}

describe('apiRevision', () => {
  it('is a versioned hash bound to catalogue, launch and policy snapshot identities', () => {
    expect(REV).toMatch(/^cm1\.[0-9a-f]{64}$/);
    expect(computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' })).toBe(REV);
    expect(OTHER).not.toBe(REV);
    expect(computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'fixture-policy-7' })).not.toBe(REV);
    const migrated = buildCatalog(TOOLS, { migrated: ['get_map'] });
    expect(migrated.revision).not.toBe(catalog.revision);
    expect(computeApiRevision({ catalog: migrated, launch: 'fixture-launch-1', policySnapshot: 'unavailable' })).not.toBe(REV);
  });

  it('is bound to each method\'s output contract: a changed schema hash or adapter revision invalidates it', () => {
    const decoded = catalog.entries.find((e) => e.name === 'get_map')!.output;
    expect(decoded).toMatchObject({ guarantee: 'decoded' });
    const withOutput = (output: unknown) => ({ ...catalog, entries: catalog.entries.map((e) => (e.name === 'get_map' ? { ...e, output } : e)) }) as typeof catalog;
    const revisionOf = (output: unknown): string => computeApiRevision({ catalog: withOutput(output), launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
    expect(revisionOf(decoded)).toBe(REV);
    expect(revisionOf({ ...decoded, schemaSha256: '0'.repeat(64) })).not.toBe(REV);
    expect(revisionOf({ ...decoded, adapterRevision: 'read-adapters@other' })).not.toBe(REV);
    expect(revisionOf({ guarantee: 'unknown' })).not.toBe(REV);
    expect(() => assertFreshRevision(REV, revisionOf({ ...decoded, adapterRevision: 'read-adapters@other' }))).toThrow(ContractError);
  });

  it('confers nothing: a fresh revision over a catalogue with unknown policy still has no executable method', () => {
    expect(catalog.entries.filter((e) => e.executable)).toEqual([]);
  });

  it('refuses malformed launch or policy identities', () => {
    for (const bad of ['', 'has space', 'x'.repeat(129), SECRET.replace(/-/g, ' ')]) {
      expect(codeOf(() => computeApiRevision({ catalog, launch: bad, policySnapshot: 'unavailable' }))).toBe('invalid-request');
      expect(codeOf(() => computeApiRevision({ catalog, launch: 'l', policySnapshot: bad }))).toBe('invalid-request');
    }
  });

  it('assertFreshRevision: missing or malformed is invalid, different is stale', () => {
    expect(codeOf(() => assertFreshRevision(REV, REV))).toBe('ok');
    expect(codeOf(() => assertFreshRevision(undefined, REV))).toBe('invalid-request');
    expect(codeOf(() => assertFreshRevision(REV.toUpperCase(), REV))).toBe('invalid-request');
    expect(codeOf(() => assertFreshRevision(`${REV} `, REV))).toBe('invalid-request');
    expect(codeOf(() => assertFreshRevision(OTHER, REV))).toBe('stale-revision');
  });
});

describe('code_execute admission: refused before any dispatch', () => {
  const ok = { code: 'async () => 1', apiRevision: REV };
  const cases: [string, unknown, string][] = [
    ['valid', ok, 'ok'],
    ['stale revision', { ...ok, apiRevision: OTHER }, 'stale-revision'],
    ['missing revision', { code: ok.code }, 'invalid-request'],
    ['malformed revision', { ...ok, apiRevision: 'cm1.abc' }, 'invalid-request'],
    ['unknown protocol field', { ...ok, timeoutMs: 1 }, 'invalid-request'],
    ['empty code', { ...ok, code: '' }, 'invalid-request'],
    ['code not a string', { ...ok, code: { toString: () => SECRET } }, 'invalid-request'],
    ['non-JSON request', { ...ok, extra: () => 1 }, 'invalid-request'],
    ['array', [ok], 'invalid-request'],
    ['null', null, 'invalid-request'],
    ['code at 32 KiB', { ...ok, code: 'x'.repeat(CONTRACT_LIMITS.codeBytes) }, 'ok'],
    ['code at 32 KiB + 1', { ...ok, code: 'x'.repeat(CONTRACT_LIMITS.codeBytes + 1) }, 'over-budget'],
    ['multibyte code at 32 KiB', { ...ok, code: 'é'.repeat(CONTRACT_LIMITS.codeBytes / 2) }, 'ok'],
    ['multibyte code at 32 KiB + 1', { ...ok, code: `${'é'.repeat(CONTRACT_LIMITS.codeBytes / 2)}x` }, 'over-budget'],
    ['stale and oversized', { code: 'x'.repeat(CONTRACT_LIMITS.codeBytes + 1), apiRevision: OTHER }, 'over-budget'],
  ];
  it.each(cases)('%s', (_label, raw, expected) => {
    const r = fixtureDispatch(() => admitExecute(raw, REV));
    expect(r).toEqual({ code: expected, dispatched: expected === 'ok' ? 1 : 0 });
  });

  it('returns a frozen copy', () => {
    const raw = { ...ok };
    const req = admitExecute(raw, REV);
    expect(Object.isFrozen(req)).toBe(true);
    raw.code = 'changed';
    expect(req.code).toBe(ok.code);
  });
});

describe('code_search and code_docs requests', () => {
  it('search: closed shape, bounded query, limit 1..20', () => {
    expect(parseSearchRequest({ query: 'map' })).toEqual({ query: 'map' });
    expect(parseSearchRequest({ query: 'map', limit: 20, cursor: 'abc' })).toEqual({ query: 'map', limit: 20, cursor: 'abc' });
    for (const raw of [{}, { query: '' }, { query: 'x'.repeat(257) }, { query: 'm', limit: 0 }, { query: 'm', limit: 21 }, { query: 'm', limit: 1.5 }, { query: 'm', limit: '5' }, { query: 'm', cursor: '' }, { query: 'm', cursor: 'x'.repeat(513) }, { query: 'm', extra: SECRET }, { query: 'm', limit: NaN }]) {
      expect(codeOf(() => parseSearchRequest(raw)), JSON.stringify(raw)).toBe('invalid-request');
    }
  });

  it('docs: 1..5 unique method names', () => {
    expect(parseDocsRequest({ names: ['get_map', 'read_room'] })).toEqual({ names: ['get_map', 'read_room'] });
    const cases: [unknown, string][] = [
      [{ names: [] }, 'invalid-request'],
      [{ names: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'invalid-request'],
      [{ names: ['get_map', 'get_map'] }, 'invalid-request'],
      [{ names: ['Get-Map'] }, 'invalid-request'],
      [{ names: ['__proto__'] }, 'invalid-request'],
      [{ names: 'get_map' }, 'invalid-request'],
      [{ names: ['get_map'], extra: 1 }, 'invalid-request'],
    ];
    for (const [raw, code] of cases) expect(codeOf(() => parseDocsRequest(raw)), JSON.stringify(raw)).toBe(code);
  });
});

describe('cursors', () => {
  const key = requestKey('search', { query: 'map' });

  it('round-trip and bind revision, kind and request', () => {
    const c = encodeCursor(REV, 'search', key, 7);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c.length).toBeLessThanOrEqual(CONTRACT_LIMITS.cursorChars);
    expect(decodeCursor(c, REV, 'search', key)).toBe(7);
    expect(codeOf(() => decodeCursor(c, OTHER, 'search', key))).toBe('stale-revision');
    expect(codeOf(() => decodeCursor(c, REV, 'docs', key))).toBe('invalid-cursor');
    expect(codeOf(() => decodeCursor(c, REV, 'search', requestKey('search', { query: 'room' })))).toBe('invalid-cursor');
    expect(requestKey('search', { query: 'map', cursor: c })).toBe(key);
    expect(requestKey('search', { query: 'map', limit: 5 })).not.toBe(key);
  });

  it('refuses tampered, non-canonical, extended or oversized cursors', () => {
    const c = encodeCursor(REV, 'search', key, 7);
    const enc = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
    const body = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
    const bad = [
      `${c}A`,
      c.slice(0, -1),
      `${c}=`,
      c.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')),
      enc(JSON.stringify({ ...body, extra: 1 })),
      enc(JSON.stringify({ ...body, o: -1 })),
      enc(JSON.stringify({ ...body, o: 1.5 })),
      enc(JSON.stringify(body).replace('{', '{"o":1,')),
      enc('not json'),
      'x'.repeat(CONTRACT_LIMITS.cursorChars + 1),
      'a b',
      '',
    ];
    for (const b of bad) expect(codeOf(() => decodeCursor(b, REV, 'search', key)), b.slice(0, 40)).toBe('invalid-cursor');
  });
});

const searchItem = (i: number): SearchItem => ({ name: `method_${String(i).padStart(3, '0')}`, summary: 's'.repeat(180), effect: 'read', availability: 'documented' });

describe('pages', () => {
  it('search pagination: every item exactly once, each page within 8 KiB, complete iff no cursor', () => {
    const items = Array.from({ length: 120 }, (_, i) => searchItem(i));
    const key = requestKey('search', { query: 'method' });
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = buildPage('search', REV, key, items, offset);
      const text = serializePage(page);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CONTRACT_LIMITS.searchPageBytes);
      expect(parsePage(text, 'search')).toEqual(page);
      expect(Object.isFrozen(page.items)).toBe(true);
      seen.push(...page.items.map((i) => i.name));
      pages++;
      if (page.complete) { expect(page.nextCursor).toBeNull(); break; }
      expect(page.items.length).toBeGreaterThan(0);
      offset = decodeCursor(page.nextCursor!, REV, 'search', key);
    }
    expect(seen).toEqual(items.map((i) => i.name));
    expect(pages).toBeGreaterThan(2);
  });

  it('search pagination honours the limit and an empty result is complete', () => {
    const items = Array.from({ length: 5 }, (_, i) => searchItem(i));
    const key = requestKey('search', { query: 'm', limit: 2 });
    const first = buildPage('search', REV, key, items, 0, 2);
    expect(first.items).toHaveLength(2);
    expect(first.complete).toBe(false);
    expect(buildPage('search', REV, key, [], 0)).toMatchObject({ items: [], complete: true, nextCursor: null });
    expect(codeOf(() => buildPage('search', REV, key, items, 6))).toBe('invalid-cursor');
  });

  it('docs: a declaration that cannot fit 16 KiB is refused, not dropped; missing names stay listed', () => {
    const item = (declaration: string): DocsItem => ({ name: 'get_map', declaration, effect: 'read', availability: 'documented', inputSchemaSha256: 'a'.repeat(64), output: 'unknown' });
    const key = requestKey('docs', { names: ['get_map', 'nope'] });
    const page = buildPage('docs', REV, key, [item('type GetMapInput = {}')], 0, undefined, ['nope']);
    expect(page).toMatchObject({ complete: true, nextCursor: null, missing: ['nope'] });
    expect(codeOf(() => buildPage('docs', REV, key, [item('x'.repeat(CONTRACT_LIMITS.docsPageBytes))], 0))).toBe('over-budget');
  });

  it('refuses a page whose completeness contradicts its cursor, or with missing or extra fields', () => {
    const base = { apiRevision: REV, kind: 'search' as const, items: [searchItem(1)], complete: true, nextCursor: null };
    expect(codeOf(() => serializePage(base))).toBe('ok');
    expect(codeOf(() => serializePage({ ...base, complete: false }))).toBe('invalid-output');
    expect(codeOf(() => serializePage({ ...base, nextCursor: 'abc' }))).toBe('invalid-output');
    const noComplete: Record<string, unknown> = { ...base };
    delete noComplete.complete;
    expect(codeOf(() => serializePage(noComplete as never))).toBe('invalid-output');
    expect(codeOf(() => serializePage({ ...base, truncated: false } as never))).toBe('invalid-output');
    expect(codeOf(() => serializePage({ ...base, kind: 'other' } as never))).toBe('invalid-output');
    const text = serializePage(base);
    expect(codeOf(() => parsePage(text.replace('"complete":true', '"complete":false'), 'search'))).toBe('invalid-output');
    expect(codeOf(() => parsePage(text.replace(',"complete":true', ''), 'search'))).toBe('invalid-output');
    expect(codeOf(() => parsePage(text.replace('"complete":true', '"complete":true,"complete":true'), 'search'))).toBe('invalid-output');
    expect(codeOf(() => parsePage(text, 'docs'))).toBe('invalid-output');
    const big = { ...base, items: Array.from({ length: 60 }, (_, i) => searchItem(i)) };
    expect(codeOf(() => serializePage(big))).toBe('over-budget');
  });
});

const VAL = compileCallValidators(catalog, REV);
/** A catalogue snapshot with one documented 64-character method: the longest name the method pattern admits. */
const LONG_NAME = 'm'.repeat(64);
const LONG = compileCallValidators({ revision: 'fixture', namespace: 'parley', absent: [], entries: [{ name: LONG_NAME, documented: true, inputSchema: { type: 'object' }, schemaSha256: canonicalSha256({ type: 'object' }) }] } as unknown as Catalog, REV);
const evidence = (ordinal: number, over: Partial<OperationEvidenceInput> = {}, v: CallValidators = VAL): OperationEvidence =>
  operationEvidence(v, { ordinal, method: 'get_map', args: { session: `s-${ordinal}` }, dispatched: true, outcome: 'succeeded', responseBytes: 100, incomplete: false, ...over });
const result = (over: Partial<ExecuteResultInput> = {}, v: CallValidators = VAL): ExecuteResult =>
  makeExecuteResult(v, { runId: 'run-1', status: 'completed', value: { count: 9 }, operations: [evidence(1)], ...over });
const roundTrip = (r: ExecuteResult, v: CallValidators = VAL): ExecuteResult => parseExecuteResult(v, serializeExecuteResult(v, r));

describe('execute result', () => {
  it('round-trips through text with every field, frozen', () => {
    const cases = [
      result(),
      result({ operations: [evidence(1, { incomplete: true }), evidence(2)] }),
      result({ status: 'error', value: null, error: { kind: 'tool-error' }, operations: [evidence(1, { outcome: 'failed' })] }),
      result({ status: 'partial-or-unknown', value: null, error: { kind: 'timeout' }, operations: [evidence(1), evidence(2, { outcome: 'draining', responseBytes: null, incomplete: true }), evidence(3, { dispatched: false, outcome: 'refused', responseBytes: null })] }),
      result({ runId: null, status: 'error', value: null, error: { kind: 'stale-revision' }, operations: [] }),
    ];
    for (const r of cases) {
      const back = roundTrip(r);
      expect(back).toEqual(r);
      expect(Object.isFrozen(back) && Object.isFrozen(back.operations) && back.operations.every((op) => Object.isFrozen(op))).toBe(true);
      expect(() => { (back as { incomplete: boolean }).incomplete = false; }).toThrow(TypeError);
    }
  });

  it('never lowers incomplete below the evidence or the status', () => {
    expect(result({ operations: [evidence(1, { incomplete: true })], incomplete: false }).incomplete).toBe(true);
    expect(result({ status: 'error', value: null, error: { kind: 'runtime' }, incomplete: false }).incomplete).toBe(true);
    expect(result({ incomplete: true }).incomplete).toBe(true);
    expect(result().incomplete).toBe(false);
  });

  it('a script that drops the pagination markers still yields incomplete:true (236 sessions, nine rows)', () => {
    const r = result({ value: { sessions: 9 }, operations: [evidence(1, { incomplete: true })] });
    expect(r).toMatchObject({ status: 'completed', value: { sessions: 9 }, incomplete: true });
  });

  it('refuses contradictory results at creation', () => {
    const cases: [string, Partial<ExecuteResultInput>, string][] = [
      ['completed with an error', { error: { kind: 'runtime' } }, 'invalid-output'],
      ['completed with draining work', { operations: [evidence(1, { outcome: 'draining', responseBytes: null, incomplete: true })] }, 'invalid-output'],
      ['completed with unknown work', { operations: [evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true })] }, 'invalid-output'],
      ['error without error', { status: 'error', value: null }, 'invalid-output'],
      ['error with unknown work', { status: 'error', value: null, error: { kind: 'timeout' }, operations: [evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true })] }, 'invalid-output'],
      ['partial without error', { status: 'partial-or-unknown', value: null }, 'invalid-output'],
      ['error with a value', { status: 'error', error: { kind: 'runtime' } }, 'invalid-output'],
      ['unsettled op marked complete', { status: 'partial-or-unknown', value: null, error: { kind: 'timeout' }, operations: [evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: false })] }, 'invalid-output'],
      ['ordinal gap', { operations: [evidence(1), evidence(3)] }, 'invalid-output'],
      ['refused but dispatched', { operations: [evidence(1, { outcome: 'refused', responseBytes: null })] }, 'invalid-output'],
      ['dispatched=false but settled', { operations: [evidence(1, { dispatched: false })] }, 'invalid-output'],
      ['bytes without a settled response', { operations: [evidence(1, { outcome: 'cancelled' })] }, 'invalid-output'],
      ['33 operations', { operations: [...Array.from({ length: 32 }, (_, i) => evidence(i + 1)), { ...evidence(32), ordinal: 33 }] }, 'invalid-output'],
      ['bad run id', { runId: `run ${SECRET}` }, 'invalid-output'],
      ['function value', { value: { f: () => SECRET } }, 'invalid-output'],
      ['cyclic value', { value: (() => { const o: Record<string, unknown> = {}; o.o = o; return o; })() }, 'invalid-output'],
      ['NaN value', { value: NaN }, 'invalid-output'],
      ['value over 16 KiB', { value: 'x'.repeat(CONTRACT_LIMITS.resultBytes) }, 'over-budget'],
    ];
    for (const [label, over, code] of cases) expect(codeOf(() => result(over)), label).toBe(code);
    expect(codeOf(() => result({ value: 'x'.repeat(CONTRACT_LIMITS.resultBytes - 2) }))).toBe('ok');
  });

  it('an unread operation: bytes required, incomplete required, and it does not stop a run from being completed', () => {
    const op = (over: Partial<OperationEvidenceInput>) => evidence(1, { outcome: 'unread', responseBytes: 10, incomplete: true, ...over });
    expect(result({ operations: [op({})] })).toMatchObject({ status: 'completed', incomplete: true });
    expect(codeOf(() => result({ operations: [op({ responseBytes: null })] }))).toBe('invalid-output');
    expect(codeOf(() => { const text = JSON.stringify({ ...JSON.parse(serializeExecuteResult(VAL, result({ operations: [op({})] }))) as object }); return parseExecuteResult(VAL, text.replaceAll('"incomplete":true', '"incomplete":false')); })).toBe('invalid-output');
  });

  it('refuses received text that drops, adds or contradicts a status, error or completeness field', () => {
    const r = result({ operations: [evidence(1, { incomplete: true })] });
    const text = serializeExecuteResult(VAL, r);
    const obj = JSON.parse(text) as Record<string, unknown>;
    const without = (k: string) => { const rest = { ...obj }; delete rest[k]; return JSON.stringify(rest); };
    const tampered = [
      JSON.stringify({ ...obj, incomplete: false }),
      without('incomplete'),
      without('error'),
      without('status'),
      without('diagnosticsTruncated'),
      without('operations'),
      JSON.stringify({ ...obj, extra: true }),
      JSON.stringify({ ...obj, status: 'done' }),
      JSON.stringify({ ...obj, status: 'error' }),
      JSON.stringify({ ...obj, contract: 1 }),
      JSON.stringify({ ...obj, contract: 2 }),
      JSON.stringify({ ...obj, operations: [{ ...(obj.operations as object[])[0], outcome: 'unknown', responseBytes: null }] }),
      JSON.stringify({ ...obj, operations: [{ ...(obj.operations as object[])[0], extra: 1 }] }),
      text.replace('"incomplete":true', '"incomplete":true,"incomplete":false'),
      text.replace('"value":{"count":9}', '"value":{"count":9007199254740993}'),
    ];
    for (const t of tampered) expect(codeOf(() => parseExecuteResult(VAL, t)), t.slice(0, 80)).toBe('invalid-output');
  });

  it('error text is the host template for its kind, never caller text', () => {
    for (const kind of Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[]) {
      // a refusal before the run started has no run id; busy also carries its one diagnostic
      const pre = ['invalid-request', 'stale-revision', 'busy'].includes(kind);
      // unsettled needs a call that has no outcome, and with it the run is partial-or-unknown
      const unsettled = kind === 'unsettled' ? { status: 'partial-or-unknown' as const, operations: [evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true })] } : { status: 'error' as const, operations: [] };
      const r = result({ runId: pre ? null : 'run-1', value: null, error: { kind }, ...unsettled, ...(kind === 'busy' ? { diagnostics: [{ code: 'busy' as const, params: { reason: 'other' } }] } : {}) });
      expect(r.error).toEqual({ kind, message: ERROR_MESSAGES[kind] });
    }
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(['busy', 'cancelled', 'helper-failure', 'invalid-output', 'invalid-request', 'quota', 'runtime', 'stale-revision', 'syntax', 'timeout', 'tool-error', 'unavailable', 'unsettled']);
  });

  it('refuses any caller-supplied text in errors and diagnostics (synthetic canaries)', () => {
    const canaries = [SECRET, `Bearer ${SECRET}`, `api_key=${SECRET}`, 'sk_ant_api03_lowercase_canary'];
    for (const c of canaries) {
      const cases: [string, Partial<ExecuteResultInput>][] = [
        ['error message', { status: 'error', value: null, error: { kind: 'runtime', message: c } as never }],
        ['error extra field', { status: 'error', value: null, error: { kind: 'runtime', detail: c } as never }],
        ['diagnostic message', { diagnostics: [{ code: 'limit-reached', params: { limit: 'wall-time' }, message: c } as never] }],
        ['diagnostic free code', { diagnostics: [{ code: c, params: {} } as never] }],
        ['diagnostic extra field', { diagnostics: [{ code: 'limit-reached', params: { limit: 'wall-time' }, note: c } as never] }],
        ['diagnostic extra param', { diagnostics: [{ code: 'limit-reached', params: { limit: 'wall-time', note: c } }] }],
        ['diagnostic method', { diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: c } }] }],
        ['diagnostic schemaPath', { diagnostics: [{ code: 'invalid-arguments', params: { ordinal: 1, method: 'get_map', keyword: 'type', schemaPath: `#/${c}` } }] }],
        ['diagnostic keyword', { diagnostics: [{ code: 'invalid-arguments', params: { ordinal: 1, method: 'get_map', keyword: c } }] }],
        ['diagnostic limit', { diagnostics: [{ code: 'limit-reached', params: { limit: c } }] }],
      ];
      for (const [label, over] of cases) expect(codeOf(() => result(over)), `${label}: ${c.slice(0, 12)}`).toBe('invalid-output');
    }
  });

  it('a lowercase name that fits the method pattern is still refused unless the evidence backs it', () => {
    expect(codeOf(() => result({ diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: 'sk_ant_api03_lowercase_canary' } }] }))).toBe('invalid-output');
    expect(codeOf(() => result({ diagnostics: [{ code: 'call-failed', params: { ordinal: 2, method: 'get_map' } }] }))).toBe('invalid-output');
    const unknownOp = evidence(1, { method: null, dispatched: false, outcome: 'refused', responseBytes: null });
    expect(result({ operations: [unknownOp], diagnostics: [{ code: 'unknown-method', params: { ordinal: 1 } }] }).diagnostics[0]!.message).toBe('call 1: no such method in this API revision');
    expect(codeOf(() => result({ diagnostics: [{ code: 'unknown-method', params: { ordinal: 1 } }] }))).toBe('invalid-output');
    expect(codeOf(() => result({ operations: [evidence(1, { method: null })] }))).toBe('invalid-output');
  });

  it('renders every diagnostic from the host template', () => {
    const ops = [evidence(1, { dispatched: false, outcome: 'refused', responseBytes: null }), evidence(2, { method: 'read_room', outcome: 'failed' })];
    const r = result({
      status: 'error', value: null, error: { kind: 'tool-error' }, operations: ops,
      diagnostics: [
        { code: 'invalid-arguments', params: { ordinal: 1, method: 'get_map', keyword: 'minimum' } },
        { code: 'non-json-arguments', params: { ordinal: 1, method: 'get_map', jsonCode: 'cycle' } },
        { code: 'call-failed', params: { ordinal: 2, method: 'read_room' } },
        { code: 'limit-reached', params: { limit: 'operations' } },
      ],
    });
    expect(r.diagnostics.map((d) => d.message)).toEqual([
      'call 1 (get_map): arguments fail "minimum"',
      'call 1 (get_map): arguments are not strict JSON (cycle)',
      'call 2 (read_room) returned an error',
      'limit reached: operations',
    ]);
    expect(roundTrip(r)).toEqual(r);
  });

  it('never shortens a diagnostic; dropping for the entry or byte budget sets diagnosticsTruncated', () => {
    // Every message is a template over enum/pattern-bounded metadata: there is no path that shortens one.
    const longest = { code: 'invalid-arguments' as const, params: { ordinal: 32, method: LONG_NAME, keyword: 'additionalProperties' } };
    const ops = Array.from({ length: 32 }, (_, i) => evidence(i + 1, { method: LONG_NAME, args: {} }, LONG));
    const one = result({ operations: ops, diagnostics: [longest] }, LONG);
    expect(one.diagnosticsTruncated).toBe(false);
    expect(one.diagnostics[0]!.message).toBe(`call 32 (${'m'.repeat(64)}): arguments fail "additionalProperties"`);
    const byBytes = result({ operations: ops, diagnostics: Array.from({ length: 16 }, () => longest) }, LONG);
    expect(byBytes.diagnosticsTruncated).toBe(true);
    expect(byBytes.diagnostics.length).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(byBytes.diagnostics), 'utf8')).toBeLessThanOrEqual(CONTRACT_LIMITS.diagnosticsBytes);
    for (const d of byBytes.diagnostics) expect(d).toEqual(one.diagnostics[0]);
    const limit = { code: 'limit-reached' as const, params: { limit: 'wall-time' } };
    const byCount = result({ diagnostics: Array.from({ length: 17 }, () => limit) });
    expect(byCount).toMatchObject({ diagnosticsTruncated: true });
    expect(byCount.diagnostics).toHaveLength(16);
    const full = result({ diagnostics: Array.from({ length: 16 }, () => limit) });
    expect(full.diagnosticsTruncated).toBe(false);
    for (const r of [one, byBytes]) expect(roundTrip(r, LONG)).toEqual(r);
    for (const r of [byCount, full]) expect(roundTrip(r)).toEqual(r);
  });

  it('refuses received diagnostics whose message, params or backing evidence was altered', () => {
    const r = result({ diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: 'get_map' } }], operations: [evidence(1, { outcome: 'failed' })], status: 'error', value: null, error: { kind: 'tool-error' } });
    const text = serializeExecuteResult(VAL, r);
    for (const t of [
      text.replace('call 1 (get_map) returned an error', `call 1 (get_map) returned an error: ${SECRET}`),
      text.replace('"params":{"ordinal":1,"method":"get_map"}', '"params":{"ordinal":1,"method":"get_map","x":1}'),
      text.replace('"params":{"ordinal":1,"method":"get_map"}', '"params":{"ordinal":1,"method":"read_room"}'),
      text.replace(ERROR_MESSAGES['tool-error'], 'A called method returned an error: 401 Bearer xyz'),
      text.replace('"code":"call-failed"', '"code":"call-exploded"'),
    ]) {
      expect(t).not.toBe(text);
      expect(codeOf(() => parseExecuteResult(VAL, t)), t.slice(-120)).toBe('invalid-output');
    }
  });

  it('operation evidence: argument hash over canonical JSON, independent of key order', () => {
    const a = operationEvidence(VAL, { ordinal: 1, method: 'read_room', args: { room: 'r-1', limit: 5 }, dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false });
    const b = operationEvidence(VAL, { ordinal: 1, method: 'read_room', args: { limit: 5, room: 'r-1' }, dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false });
    expect(a.argsSha256).toBe(canonicalSha256({ room: 'r-1', limit: 5 }));
    expect(b).toEqual(a);
    expect(a).not.toHaveProperty('args');
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('evidence provenance: methods come from the run handle, not from matching strings (s-290 m-4005)', () => {
  const CANARY = 'sk_ant_api03_lowercase_canary';
  const getMap = TOOLS.find((t) => t.name === 'get_map')!;
  const onlyGetMap = buildCatalog([getMap]);
  const rev = computeApiRevision({ catalog: onlyGetMap, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
  const v = compileCallValidators(onlyGetMap, rev);
  const forgedOp = { ordinal: 1, method: CANARY, argsSha256: null, dispatched: true, outcome: 'failed', responseBytes: 1, incomplete: false } as OperationEvidence;
  const pairedDiag = { code: 'call-failed' as const, params: { ordinal: 1, method: CANARY } };

  it('the reviewer repro: a minted unknown name is recorded as null, so the paired diagnostic is refused', () => {
    expect(v.methods).toEqual(['get_map']);
    const op = operationEvidence(v, { ordinal: 1, method: CANARY, args: {}, dispatched: false, outcome: 'refused', responseBytes: null, incomplete: false });
    expect(op.method).toBeNull();
    expect(JSON.stringify(op)).not.toContain('canary');
    expect(codeOf(() => makeExecuteResult(v, { runId: 'r', status: 'error', error: { kind: 'tool-error' }, operations: [op], diagnostics: [pairedDiag] }))).toBe('invalid-output');
    const dispatchedUnknown = operationEvidence(v, { ordinal: 1, method: CANARY, args: {}, dispatched: true, outcome: 'failed', responseBytes: 1, incomplete: false });
    expect(dispatchedUnknown.method).toBeNull();
    expect(codeOf(() => makeExecuteResult(v, { runId: 'r', status: 'error', error: { kind: 'tool-error' }, operations: [dispatchedUnknown] }))).toBe('invalid-output');
  });

  it('a hand-built evidence object with a paired forged method is refused at make', () => {
    expect(codeOf(() => makeExecuteResult(v, { runId: 'r', status: 'error', error: { kind: 'tool-error' }, operations: [forgedOp], diagnostics: [pairedDiag] }))).toBe('invalid-output');
    expect(codeOf(() => makeExecuteResult(v, { runId: 'r', status: 'error', error: { kind: 'tool-error' }, operations: [forgedOp] }))).toBe('invalid-output');
    // A real method of ANOTHER catalogue is just as unproved here.
    expect(codeOf(() => makeExecuteResult(v, { runId: 'r', status: 'completed', operations: [{ ...forgedOp, method: 'read_room', outcome: 'succeeded' }] }))).toBe('invalid-output');
  });

  it('parse refuses a paired substitution in evidence, params and message', () => {
    const ok = makeExecuteResult(v, { runId: 'r', status: 'error', error: { kind: 'tool-error' }, operations: [operationEvidence(v, { ordinal: 1, method: 'get_map', args: {}, dispatched: true, outcome: 'failed', responseBytes: 1, incomplete: false })], diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: 'get_map' } }] });
    const text = serializeExecuteResult(v, ok);
    expect(parseExecuteResult(v, text)).toEqual(ok);
    const swapped = text.split('get_map').join(CANARY);
    expect(swapped.split(CANARY).length - 1).toBe(3);
    expect(codeOf(() => parseExecuteResult(v, swapped))).toBe('invalid-output');
    const swappedReal = text.split('get_map').join('read_room');
    expect(codeOf(() => parseExecuteResult(v, swappedReal))).toBe('invalid-output');
  });

  it('results are bound to the exact handle revision on make, serialize and parse', () => {
    const r = result();
    const otherHandle = compileCallValidators(catalog, OTHER);
    expect(r.apiRevision).toBe(REV);
    expect(codeOf(() => serializeExecuteResult(otherHandle, r))).toBe('invalid-output');
    expect(codeOf(() => parseExecuteResult(otherHandle, serializeExecuteResult(VAL, r)))).toBe('invalid-output');
    expect(codeOf(() => parseExecuteResult(VAL, serializeExecuteResult(VAL, r).replace(REV, OTHER)))).toBe('invalid-output');
    expect(codeOf(() => serializeExecuteResult(v, r))).toBe('invalid-output');
    const forgedHandle = { ...VAL } as CallValidators;
    expect(codeOf(() => makeExecuteResult(forgedHandle, { runId: 'r', status: 'completed', operations: [] }))).toBe('invalid-output');
    expect(codeOf(() => serializeExecuteResult(forgedHandle, r))).toBe('invalid-output');
    expect(codeOf(() => parseExecuteResult(forgedHandle, serializeExecuteResult(VAL, r)))).toBe('invalid-output');
    expect(codeOf(() => operationEvidence(forgedHandle, { ordinal: 1, method: 'get_map', args: {}, dispatched: false, outcome: 'refused', responseBytes: null, incomplete: false }))).toBe('invalid-output');
  });

  it('keeps every real admitted method of the handle, without a hardcoded list', () => {
    for (const [i, m] of VAL.methods.entries()) {
      const op = evidence(1, { method: m });
      expect(op.method).toBe(m);
      const r = result({ status: 'error', value: null, error: { kind: 'tool-error' }, operations: [{ ...op, outcome: 'failed' }], diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: m } }] });
      expect(roundTrip(r).diagnostics[0]!.message, String(i)).toBe(`call 1 (${m}) returned an error`);
    }
    expect(evidence(1, { method: LONG_NAME }, LONG).method).toBe(LONG_NAME);
    expect(evidence(1, { method: LONG_NAME }).method).toBeNull();
  });

  it('non-JSON arguments are hashed as null, never recorded', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.c = cyclic;
    for (const args of [cyclic, { f: () => SECRET }, { s: SECRET }]) {
      const op = operationEvidence(VAL, { ordinal: 1, method: 'get_map', args, dispatched: false, outcome: 'refused', responseBytes: null, incomplete: false });
      expect(JSON.stringify(op)).not.toContain('SYNTHETIC');
    }
    expect(operationEvidence(VAL, { ordinal: 1, method: 'get_map', args: cyclic, dispatched: false, outcome: 'refused', responseBytes: null, incomplete: false }).argsSha256).toBeNull();
  });
});

describe('per-call admission against the actual catalogue', () => {
  const validators = compileCallValidators(catalog, REV);

  it('has validators exactly for the documented initial methods, hashed like the catalogue', () => {
    expect(validators.methods).toEqual([...MIGRATABLE_READS].sort());
    for (const e of catalog.entries.filter((x) => x.documented)) expect(validators.schemaSha256Of(e.name)).toBe(e.schemaSha256);
    for (const n of ['report', 'constructor', '__proto__', 'toString']) expect(validators.schemaSha256Of(n)).toBeUndefined();
  });

  it('membership and validator identity cannot be changed under the same revision', () => {
    const v = compileCallValidators(catalog, REV);
    expect(Object.isFrozen(v) && Object.isFrozen(v.methods)).toBe(true);
    expect(v).not.toHaveProperty('byName');
    expect(() => { (v.methods as string[]).push('invented_method'); }).toThrow(TypeError);
    expect(() => { (v as { apiRevision: string }).apiRevision = OTHER; }).toThrow(TypeError);
    expect(() => { (v as { schemaSha256Of: unknown }).schemaSha256Of = () => 'x'; }).toThrow(TypeError);
    const open = compileInputValidator({ type: 'object' });
    const forged = [
      { ...v },
      { apiRevision: REV, methods: [...v.methods, 'invented_method'], schemaSha256Of: () => open.schemaSha256 },
      Object.freeze({ apiRevision: REV, methods: v.methods, schemaSha256Of: v.schemaSha256Of, byName: new Map([['get_map', open]]) }),
    ] as unknown as CallValidators[];
    for (const f of forged) {
      expect(fixtureDispatch(() => admitCall(f, REV, 'get_map', { maxBytes: 1 }))).toEqual({ code: 'invalid-request', dispatched: 0 });
      expect(fixtureDispatch(() => admitCall(f, REV, 'invented_method', {}))).toEqual({ code: 'invalid-request', dispatched: 0 });
    }
    expect(fixtureDispatch(() => admitCall(v, REV, 'get_map', { maxBytes: 1 }))).toEqual({ code: 'invalid-arguments', dispatched: 0 });
    expect(fixtureDispatch(() => admitCall(v, REV, 'invented_method', {}))).toEqual({ code: 'unknown-method', dispatched: 0 });
    expect(v.schemaSha256Of('get_map')).toBe(catalog.entries.find((e) => e.name === 'get_map')!.schemaSha256);
  });

  const cases: [string, unknown, unknown, string][] = [
    ['valid read_room', 'read_room', { room: 'r-1' }, 'ok'],
    ['valid open extra', 'read_room', { room: 'r-1', extra: 1 }, 'ok'],
    ['residual method', 'report', { status: 'done' }, 'unknown-method'],
    ['browser method', 'browser_action', {}, 'unknown-method'],
    ['constructor', 'constructor', {}, 'unknown-method'],
    ['__proto__', '__proto__', {}, 'unknown-method'],
    ['toString', 'toString', {}, 'unknown-method'],
    ['non-string method', ['get_map'], {}, 'unknown-method'],
    ['missing required', 'read_room', {}, 'invalid-arguments'],
    ['closed extra with a secret', 'get_map', { token: SECRET }, 'invalid-arguments'],
    ['range', 'get_map', { maxBytes: 1 }, 'invalid-arguments'],
    ['coercion', 'get_map', { maxBytes: '4096' }, 'invalid-arguments'],
    ['cycle', 'list_roles', (() => { const o: Record<string, unknown> = {}; o.o = o; return o; })(), 'invalid-arguments'],
    ['over 64 KiB', 'list_roles', { a: 'x'.repeat(65536) }, 'invalid-arguments'],
    ['prototype pollution', 'list_roles', JSON.parse('{"__proto__":{"admin":true}}'), 'invalid-arguments'],
  ];
  it.each(cases)('%s', (_label, method, args, expected) => {
    expect(fixtureDispatch(() => admitCall(validators, REV, method, args))).toEqual({ code: expected, dispatched: expected === 'ok' ? 1 : 0 });
  });

  it('a stale revision is refused before the method or arguments are looked at', () => {
    expect(fixtureDispatch(() => admitCall(validators, OTHER, 'read_room', { room: 'r-1' }))).toEqual({ code: 'stale-revision', dispatched: 0 });
    expect(fixtureDispatch(() => admitCall(validators, OTHER, 'nope', null))).toEqual({ code: 'stale-revision', dispatched: 0 });
  });

  it('returns the exact validated text and a frozen copy parsed from it; later caller changes do not reach dispatch', () => {
    const args = { room: 'r-1', extra: { n: 1 } };
    const admitted = admitCall(validators, REV, 'read_room', args);
    args.room = 'x'.repeat(100_000);
    args.extra.n = 2;
    expect(admitted).toEqual({ method: 'read_room', argsText: '{"room":"r-1","extra":{"n":1}}', args: { room: 'r-1', extra: { n: 1 } } });
    expect(admitted.args).not.toBe(args);
    expect(Object.isFrozen(admitted) && Object.isFrozen(admitted.args) && Object.isFrozen((admitted.args as { extra: object }).extra)).toBe(true);
    expect(() => { (admitted.args as { room: string }).room = 'x'; }).toThrow(TypeError);
  });

  it('an inherited toJSON cannot change the admitted text', () => {
    const proto = Object.prototype as unknown as { toJSON?: unknown };
    proto.toJSON = function () { return { room: 'evil-overlong-room-name' }; };
    try {
      const admitted = admitCall(validators, REV, 'read_room', { room: 'r-25' });
      expect(admitted.argsText).toBe('{"room":"r-25"}');
      expect(admitted.args).toEqual({ room: 'r-25' });
    } finally {
      delete proto.toJSON;
    }
  });
});

describe('generated declarations versus the runtime validator', () => {
  const pascal = (name: string): string => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());
  /** [method, literal, TypeScript accepts, runtime accepts]. Rows where they differ are the documented divergences. */
  const ROWS: [string, string, boolean, boolean][] = [
    ['get_map', '{}', true, true],
    ['get_map', '{ session: "s-01", field: "goal" }', true, true],
    ['get_map', '{ field: "nope" }', false, false],
    ['get_map', '{ session: 1 }', false, false],
    ['get_map', '{ extra: 1 }', false, false],
    ['get_map', '{ maxBytes: "4096" }', false, false],
    ['get_map', '{ maxBytes: 1 }', true, false], // range: runtime only
    ['get_map', '{ maxBytes: 2048.5 }', true, false], // integer: runtime only
    ['read_room', '{ room: "r-1" }', true, true],
    ['read_room', '{}', false, false],
    ['read_room', '{ room: 1 }', false, false],
    ['read_room', '{ room: "r-1", extra: 1 }', false, true], // open schema: the declaration is stricter than the authoritative schema
    ['read_guide', '{ topic: "plans" }', true, true],
    ['read_guide', '{ topic: "x" }', false, false],
    ['read_guide', '{ extra: 1 }', false, false],
    ['list_roles', '{}', true, true],
    ['list_roles', '{ anything: 1 }', true, true],
    ['backlog_list', '{ filter: "all" }', true, true],
    ['backlog_list', '{ filter: "ALL" }', false, false],
    ['backlog_list', `{ text: "${'x'.repeat(4097)}" }`, true, false], // maxLength: runtime only
  ];

  it('the runtime validator is at least as strict as the declaration, except the listed open-object divergence', () => {
    const decls = declarationsFor(catalog, [...INITIAL_COHORT]);
    const lines = ROWS.map(([m, lit], i) => `const v${i}: ${pascal(m)}Input = ${lit};`);
    const text = `${decls}\n${lines.join('\n')}\n`;
    const file = 'check.ts';
    const options: ts.CompilerOptions = { strict: true, noEmit: true, types: [], lib: ['lib.es2022.d.ts'] };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang) => (name === file ? ts.createSourceFile(file, text, lang, true) : original(name, lang));
    const program = ts.createProgram([file], options, host);
    const sf = program.getSourceFile(file)!;
    const declLines = decls.split('\n').length;
    const failing = new Set<number>();
    for (const d of ts.getPreEmitDiagnostics(program)) {
      expect(d.file?.fileName, ts.flattenDiagnosticMessageText(d.messageText, ' ')).toBe(file);
      const line = sf.getLineAndCharacterOfPosition(d.start!).line - declLines;
      expect(line, ts.flattenDiagnosticMessageText(d.messageText, ' ')).toBeGreaterThanOrEqual(0);
      failing.add(line);
    }
    ROWS.forEach(([method, lit, tsOk, runtimeOk], i) => {
      const args = new Function(`return (${lit});`)() as unknown;
      const actualRuntime = (() => { try { admitCall(validators(), REV, method, args); return true; } catch { return false; } })();
      expect({ method, lit: lit.slice(0, 40), ts: !failing.has(i), runtime: actualRuntime }).toEqual({ method, lit: lit.slice(0, 40), ts: tsOk, runtime: runtimeOk });
      if (!tsOk && !(method === 'read_room' && runtimeOk)) expect(actualRuntime).toBe(false);
    });
  });
  const validators = (() => { let v: ReturnType<typeof compileCallValidators> | undefined; return () => (v ??= compileCallValidators(catalog, REV)); })();
});


describe('contract version 4 (the version-3 shapes of T7a stay): docs output, a null run id before the run, and the busy refusal', () => {
  const PRE_KINDS = ['invalid-request', 'stale-revision', 'unavailable', 'busy'] as const;
  const preRun = (kind: (typeof PRE_KINDS)[number], over: Partial<ExecuteResultInput> = {}): ExecuteResult =>
    makeExecuteResult(VAL, { runId: null, status: 'error', value: null, error: { kind }, operations: [], ...(kind === 'busy' ? { diagnostics: [{ code: 'busy', params: { reason: 'previous-run-draining' } }] } : {}), ...over });

  it('is version 4, so a stored version 1, 2 or 3 result and a revision from version 3 are refused', () => {
    expect(CONTRACT_VERSION).toBe(4);
    expect(result().contract).toBe(4);
    const text = serializeExecuteResult(VAL, result());
    for (const old of [1, 2, 3, 5]) expect(codeOf(() => parseExecuteResult(VAL, text.replace('"contract":4', `"contract":${old}`))), `contract ${old}`).toBe('invalid-output');
    expect(REV).toMatch(/^cm1\.[0-9a-f]{64}$/);
  });

  it('no other Code Mode source or test pins the old version (the version lives in one constant)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('.', import.meta.url);
    const pinned = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'contracts.test.ts').filter((f) => /\bcontract['"]?\s*[:=]\s*2\b/.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(pinned).toEqual([]);
  });

  it('docs items say whether the output is decoded; nothing else is a value', () => {
    const item = (output: unknown): DocsItem => ({ name: 'get_map', declaration: 'declare const x: 1;', effect: 'read', availability: 'documented', inputSchemaSha256: 'a'.repeat(64), output } as DocsItem);
    for (const output of ['unknown', 'decoded'] as const) {
      const page = buildPage('docs', REV, 'k', [item(output)], 0);
      expect(page.items[0]!.output).toBe(output);
      expect(parsePage(serializePage(page), 'docs')).toEqual(page);
    }
    for (const bad of ['unverified', 'Decoded', '', null, 1, true]) expect(codeOf(() => buildPage('docs', REV, 'k', [item(bad)], 0)), String(bad)).toBe('invalid-output');
  });

  it('a run id is null only for a refusal before the run: error status, a before-run kind, no operations', () => {
    for (const kind of PRE_KINDS) {
      const r = preRun(kind);
      expect(r).toMatchObject({ runId: null, status: 'error', incomplete: true, operations: [], contract: 4 });
      expect(roundTrip(r)).toEqual(r);
    }
    const bad: [string, Partial<ExecuteResultInput>][] = [
      ['completed', { status: 'completed', error: null, value: 1 }],
      ['partial-or-unknown', { status: 'partial-or-unknown' }],
      ['a runtime error', { error: { kind: 'runtime' } }],
      ['a tool error', { error: { kind: 'tool-error' } }],
      ['with an operation', { operations: [evidence(1)] }],
    ];
    for (const [label, over] of bad) expect(codeOf(() => preRun('unavailable', over)), label).toBe('invalid-output');
    expect(codeOf(() => preRun('unavailable', { runId: undefined as never }))).toBe('invalid-output');
  });

  it('a refusal that always happens before the run cannot carry a run id, and a started run cannot be null', () => {
    for (const kind of ['invalid-request', 'stale-revision'] as const) expect(codeOf(() => preRun(kind, { runId: 'not-started' })), kind).toBe('invalid-output');
    expect(codeOf(() => preRun('busy', { runId: 'run-1' }))).toBe('invalid-output');
    // unavailable may come from a started run (the helper refuses after the lease): it keeps its id
    expect(result({ status: 'error', value: null, error: { kind: 'unavailable' }, operations: [] }).runId).toBe('run-1');
    expect(codeOf(() => result({ runId: null }))).toBe('invalid-output');
    expect(codeOf(() => result({ runId: null, status: 'error', value: null, error: { kind: 'runtime' }, operations: [] }))).toBe('invalid-output');
    expect(codeOf(() => parseExecuteResult(VAL, serializeExecuteResult(VAL, preRun('unavailable')).replace('"runId":null,', '')))).toBe('invalid-output');
  });

  it('unsettled: a call whose outcome is unknown, only with such a call, and never "cancelled"', () => {
    const open = evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true });
    const draining = evidence(1, { outcome: 'draining', responseBytes: null, incomplete: true });
    for (const op of [open, draining]) {
      const r = result({ status: 'partial-or-unknown', value: null, error: { kind: 'unsettled' }, operations: [op] });
      expect(r.error).toEqual({ kind: 'unsettled', message: "A call's outcome is unknown." });
      expect(roundTrip(r)).toEqual(r);
    }
    expect(codeOf(() => result({ status: 'partial-or-unknown', value: null, error: { kind: 'unsettled' }, operations: [evidence(1)] }))).toBe('invalid-output');
    expect(codeOf(() => result({ status: 'partial-or-unknown', value: null, error: { kind: 'unsettled' }, operations: [] }))).toBe('invalid-output');
    expect(codeOf(() => result({ status: 'error', value: null, error: { kind: 'unsettled' }, operations: [open] }))).toBe('invalid-output');
  });

  it('busy: the error kind and exactly one busy diagnostic go together, from a closed list of reasons', () => {
    expect(BUSY_REASONS).toEqual([
      'a-run-is-active', 'previous-run-cleanup-unknown', 'previous-run-has-calls-with-unknown-outcome', 'previous-run-preflight-pending',
      'previous-run-cleanup-pending', 'previous-run-draining', 'previous-process-unaccounted', 'held-by-other-process', 'run-record-unavailable', 'other',
    ]);
    const messages = new Set<string>();
    for (const reason of BUSY_REASONS) {
      const r = preRun('busy', { diagnostics: [{ code: 'busy', params: { reason } }] });
      expect(r.error).toEqual({ kind: 'busy', message: ERROR_MESSAGES.busy });
      expect(r.diagnostics).toHaveLength(1);
      messages.add(r.diagnostics[0]!.message);
      expect(roundTrip(r)).toEqual(r);
    }
    expect(messages.size).toBe(BUSY_REASONS.length);
    // the three reasons of a record that no later run clears say what remains; the lease's own reasons do not
    for (const reason of BUSY_REASONS) {
      const text = preRun('busy', { diagnostics: [{ code: 'busy', params: { reason } }] }).diagnostics[0]!.message;
      expect(text.includes('code_execute stays unavailable here. Use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts.'), reason).toBe(['previous-process-unaccounted', 'held-by-other-process', 'run-record-unavailable'].includes(reason));
      // the published text cannot depend on the launch mode, so it must not call the remaining tools "classic" (T8a)
      expect(text, reason).not.toMatch(/classic/i);
      // nor "your tool list": under tool search the client lists none of the Parley tools up front (T8b)
      expect(text, reason).not.toMatch(/tool list/i);
      // nor the bare word "listed" (T8e): with every Parley tool deferred nothing is listed, and "no longer listed" would read as every method gone
      expect(text.split('listed or loadable on demand').join(''), reason).not.toMatch(/\blisted\b/i);
    }
    const bad: [string, Partial<ExecuteResultInput>][] = [
      ['no diagnostic', { diagnostics: [] }],
      ['two diagnostics', { diagnostics: [{ code: 'busy', params: { reason: 'other' } }, { code: 'busy', params: { reason: 'other' } }] }],
      ['another reason', { diagnostics: [{ code: 'busy', params: { reason: 'run-1' } }] }],
      ['a run id in the params', { diagnostics: [{ code: 'busy', params: { reason: 'other', runId: 'run-1' } }] }],
      ['a process id in the params', { diagnostics: [{ code: 'busy', params: { reason: 'other', pid: 1 } }] }],
      ['an ordinal', { diagnostics: [{ code: 'busy', params: { reason: 'other', ordinal: 1 } }] }],
      ['free text', { diagnostics: [{ code: 'busy', params: { reason: SECRET } }] }],
    ];
    for (const [label, over] of bad) expect(codeOf(() => preRun('busy', over)), label).toBe('invalid-output');
    // a busy diagnostic belongs to the busy refusal only
    expect(codeOf(() => result({ status: 'error', value: null, error: { kind: 'runtime' }, diagnostics: [{ code: 'busy', params: { reason: 'other' } }] }))).toBe('invalid-output');
    expect(codeOf(() => preRun('unavailable', { diagnostics: [{ code: 'busy', params: { reason: 'other' } }] }))).toBe('invalid-output');
  });
});
