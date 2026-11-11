// A process that holds a Code Mode run the way a session-MCP process does: real helper, real ledger, real run record. Tests end it the
// way sleep, Stop or a crash would, then ask a new process what it finds. Fixture host only. Usage: <dist dir> <mode> <work dir> <session id>
import path from 'node:path';
import { setInterval } from 'node:timers';
import { pathToFileURL } from 'node:url';

const [distDir, mode, workDir, sessionId] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(path.join(distDir, rel)).href);
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// An MCP server's stdin closes when its client goes.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

const R = await load('mcp/code-mode/run-record.js');
const store = R.createRunRecordStore({ workDir, sessionId, launchId: `launch-${mode}` });

if (mode === 'probe') {
  const o = store.open('run-probe');
  say(o.ok ? { ok: true } : { ok: false, busy: o.busy });
  if (o.ok) o.handle.release();
  process.exit(0);
}
if (mode === 'open-only') {
  const o = store.open('run-open');
  say({ ready: o.ok });
} else {
  const H = await load('mcp/code-mode/helper.js');
  const S = await load('mcp/code-mode/scheduler.js');
  const C = await load('mcp/code-mode/catalog.js');
  const K = await load('mcp/code-mode/contracts.js');
  const { TOOLS } = await load('mcp/tools.js');
  const catalog = C.buildCatalog(TOOLS);
  const apiRevision = K.computeApiRevision({ catalog, launch: 'fixture-launch-1', policySnapshot: 'unavailable' });
  const validators = K.compileCallValidators(catalog, apiRevision);
  const hosts = {
    hanging: () => new Promise(() => {}),
    draining: () => new Promise(() => {}),
    unknown: async () => ({ kind: 'unknown', observedBytes: 0 }),
    settled: async () => ({ kind: 'ok', text: '{"ok":true}', assessment: 'complete' }),
  };
  const host = (...a) => { say({ called: true }); return hosts[mode](...a); };
  const code = mode === 'draining' ? 'parley.get_map({}); return 1;' : 'try { await parley.get_map({}); } catch {} return 1;';
  const authorize = (c) => (store.intent(c.runId, c.ordinal, c.method, '0'.repeat(64)) ? { ok: true } : { ok: false, reason: 'run-record' });
  const r = await H.runWith(H.PRODUCT_LOCATIONS, { validators, apiRevision, code, methods: ['get_map'], host, authorize, record: store, limits: { wallMs: 20_000 } }, new S.SessionScheduler());
  say({ returned: r.status });
  if (mode === 'settled') { await r.drained; say({ drained: true }); }
}
setInterval(() => {}, 1 << 30);
