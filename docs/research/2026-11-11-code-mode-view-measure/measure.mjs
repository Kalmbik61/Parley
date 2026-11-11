// Estimate only: renders texts with the real dist serializer and counts o200k tokens. Not the T9a harness.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const W = process.argv[2], TOK = process.argv[3];
const dist = W + '/packages/core/dist/mcp/';
const imp = (p) => import(pathToFileURL(dist + p).href);
const { TOOLS } = await imp('tools.js');
const cat = await imp('code-mode/catalog.js');
const c = await imp('code-mode/contracts.js');
const tools = await imp('code-mode-tools.js');
const req = createRequire(TOK + '/noop.cjs');
const { getEncoding } = req('js-tiktoken');
const enc = getEncoding('o200k_base');
const tok = (s) => enc.encode(s).length;
const B = (s) => Buffer.byteLength(s, 'utf8');
const catalog = cat.buildCatalog(TOOLS);
const surface = tools.createCodeModeSurface({ backend: () => ({ catalog, launchId: 'replay-launch', broker: null }) });
const show = (label, s) => console.log(`${label.padEnd(44)} ${String(B(s)).padStart(6)} B ${String(tok(s)).padStart(5)} tok`);
for (const q of ['parley', 'get_map', 'map', 'read_room', 'room']) {
  const r = await surface.call('code_search', { query: q });
  show(`code_search "${q}"`, r.content[0].text);
}
const r1 = await surface.call('code_search', { query: 'get_map', limit: 1 }); show('code_search "get_map" limit 1', r1.content[0].text);
const rev = JSON.parse(r1.content[0].text).apiRevision;
const v = c.compileCallValidators(catalog, rev);
const op = (ordinal, method, outcome, extra = {}) => c.operationEvidence(v, { ordinal, method, args: { session: 's-02' }, dispatched: outcome !== 'refused', outcome, responseBytes: ['succeeded','failed','unread'].includes(outcome) ? 1234 : null, incomplete: ['unread','draining','unknown'].includes(outcome) || extra.incomplete === true });
const value = { detail: { id: 's-02', label: 'Lead', task: 'Plan the work', summary: 'Done.' } };
const runId = '3f2b8c1e-9a7d-4e21-b6f0-2c4d5e6f7a8b';
const cases = {
  'completed clean, 1 op': { runId, status: 'completed', value, operations: [op(1, 'get_map', 'succeeded')] },
  'completed, op incomplete': { runId, status: 'completed', value, operations: [op(1, 'get_map', 'succeeded', { incomplete: true })] },
  'completed, caught failed call': { runId, status: 'completed', value, operations: [op(1, 'read_room', 'failed')], diagnostics: [{ code: 'call-failed', params: { ordinal: 1, method: 'read_room' } }] },
  'error stale-revision (pre-run)': { runId: null, status: 'error', error: { kind: 'stale-revision' }, operations: [] },
  'error runtime after 1 op': { runId, status: 'error', error: { kind: 'runtime' }, operations: [op(1, 'get_map', 'succeeded')] },
  'partial-or-unknown unsettled': { runId, status: 'partial-or-unknown', error: { kind: 'unsettled' }, operations: [op(1, 'get_map', 'unknown')], diagnostics: [{ code: 'call-unsettled', params: { ordinal: 1, method: 'get_map' } }] },
  'error quota + limit response-bytes': { runId, status: 'error', error: { kind: 'quota' }, operations: [op(1, 'get_map', 'unread')], diagnostics: [{ code: 'limit-reached', params: { limit: 'response-bytes' } }] },
};
const valueText = JSON.stringify(value);
show('value alone', valueText);
for (const [k, input] of Object.entries(cases)) {
  const res = c.makeExecuteResult(v, input);
  show(`v3 ${k}`, c.serializeExecuteResult(v, res));
}
// candidate agent views (hand-rendered here; the design fixes the exact renderer)
const views = {
  'v4 completed clean': `{"value":${valueText}}`,
  'v4 completed, op incomplete': `{"value":${valueText},"incomplete":true,"calls":["1 get_map succeeded incomplete"]}`,
  'v4 completed, caught failed call': `{"value":${valueText},"calls":["1 read_room failed"],"notes":["call 1 (read_room) returned an error"]}`,
  'v4 error stale-revision': `{"status":"error","error":"stale-revision","message":"The apiRevision is not the current one; read code_search/code_docs again.","incomplete":true}`,
  'v4 partial-or-unknown': `{"status":"partial-or-unknown","error":"unsettled","message":"A call's outcome is unknown.","incomplete":true,"calls":["1 get_map unknown incomplete"],"notes":["call 1 (get_map) has no settled outcome"]}`,
};
for (const [k, s] of Object.entries(views)) show(k, s);
