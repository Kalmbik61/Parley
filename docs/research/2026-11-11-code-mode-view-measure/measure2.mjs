// Estimate only: v3 texts from the real dist serializer; v4 texts from a reference projection of the SAME ExecuteResult (the rule in the design note).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const W = process.argv[2], TOK = process.argv[3];
const imp = (p) => import(pathToFileURL(W + '/packages/core/dist/mcp/' + p).href);
const { TOOLS } = await imp('tools.js');
const cat = await imp('code-mode/catalog.js');
const c = await imp('code-mode/contracts.js');
const { getEncoding } = createRequire(TOK + '/noop.cjs')('js-tiktoken');
const enc = getEncoding('o200k_base');
const tok = (s) => enc.encode(s).length, B = (s) => Buffer.byteLength(s, 'utf8');
const catalog = cat.buildCatalog(TOOLS);
const rev = 'cm1.' + 'a'.repeat(64);
const v = c.compileCallValidators(catalog, rev);
const op = (ordinal, method, outcome, inc = false) => c.operationEvidence(v, { ordinal, method, args: { room: 'r-01' }, dispatched: outcome !== 'refused', outcome, responseBytes: ['succeeded', 'failed', 'unread'].includes(outcome) ? 1234 : null, incomplete: ['unread', 'draining', 'unknown'].includes(outcome) || inc });
// reference projection (design §3)
const view = (r) => {
  const o = { status: r.status, incomplete: r.incomplete };
  if (r.status === 'completed') o.value = r.value; else { o.error = r.error; if (r.runId !== null) o.runId = r.runId; }
  const rows = r.status === 'completed' ? r.operations.filter((x) => x.outcome !== 'succeeded' || x.incomplete) : r.operations;
  if (rows.length > 0) o.operations = rows.map(({ ordinal, method, dispatched, outcome, incomplete }) => ({ ordinal, method, dispatched, outcome, incomplete }));
  if (r.diagnostics.length > 0) o.diagnostics = r.diagnostics;
  if (r.diagnosticsTruncated) o.diagnosticsTruncated = true;
  return JSON.stringify(o);
};
const runId = '3f2b8c1e-9a7d-4e21-b6f0-2c4d5e6f7a8b';
const small = { detail: { id: 's-02', label: 'Lead', task: 'Plan the work', summary: 'Done.' } };
const errRes = { errorResult: { content: [{ type: 'text', text: 'You are not a member of room r-01.' }], isError: true } };
const cases = {
  'value-only baseline (small)': null,
  'completed clean, 1 op': { runId, status: 'completed', value: small, operations: [op(1, 'get_map', 'succeeded')] },
  'completed clean, 2 ops': { runId, status: 'completed', value: small, operations: [op(1, 'get_map', 'succeeded'), op(2, 'get_map', 'succeeded')] },
  'completed, op incomplete (cut/page.next)': { runId, status: 'completed', value: small, operations: [op(1, 'get_map', 'succeeded', true)] },
  'completed, caught failed call (denied)': { runId, status: 'completed', value: errRes, incomplete: true, operations: [op(1, 'read_room', 'failed')], diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: 'read_room' } }] },
  'error stale-revision (pre-run)': { runId: null, status: 'error', error: { kind: 'stale-revision' }, operations: [] },
  'error unavailable host 404, 1 op': { runId, status: 'error', error: { kind: 'unavailable' }, operations: [op(1, 'get_map', 'refused')] },
  'error busy (pre-run)': { runId: null, status: 'error', error: { kind: 'busy' }, operations: [], diagnostics: [{ code: 'busy', params: { reason: 'a-run-is-active' } }] },
  'error runtime after 1 ok op': { runId, status: 'error', error: { kind: 'runtime' }, operations: [op(1, 'get_map', 'succeeded')] },
  'partial-or-unknown unsettled': { runId, status: 'partial-or-unknown', error: { kind: 'unsettled' }, operations: [op(1, 'get_map', 'unknown')], diagnostics: [{ code: 'call-unsettled', params: { ordinal: 1, method: 'get_map' } }] },
  'error quota + limit response-bytes': { runId, status: 'error', error: { kind: 'quota' }, operations: [op(1, 'get_map', 'unread')], diagnostics: [{ code: 'limit-reached', params: { limit: 'response-bytes' } }] },
  'completed + limit (guest refused op)': { runId, status: 'completed', value: small, incomplete: true, operations: [op(1, 'get_map', 'succeeded'), op(2, 'get_map', 'refused')], diagnostics: [{ code: 'limit-reached', params: { limit: 'operations' } }] },
};
console.log('case'.padEnd(44), '   v3 B  v3 tok |  v4 B  v4 tok | saved tok');
for (const [k, input] of Object.entries(cases)) {
  if (input === null) { const s = JSON.stringify(small); console.log(k.padEnd(44), String(B(s)).padStart(7), String(tok(s)).padStart(7)); continue; }
  const r = c.makeExecuteResult(v, input);
  const t3 = c.serializeExecuteResult(v, r), t4 = view(r);
  console.log(k.padEnd(44), String(B(t3)).padStart(7), String(tok(t3)).padStart(7), '|', String(B(t4)).padStart(5), String(tok(t4)).padStart(6), '|', String(tok(t3) - tok(t4)).padStart(6));
}
console.log('\nsample v4 texts:');
for (const k of ['completed clean, 1 op', 'completed, caught failed call (denied)', 'error unavailable host 404, 1 op']) console.log(k, '=>', view(c.makeExecuteResult(v, cases[k])));
