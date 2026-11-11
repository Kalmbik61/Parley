// Estimate: v4 search pages vs a candidate D3 page, same catalogue and ranking (real dist search), candidate rendered by hand.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const W = process.argv[2], TOK = process.argv[3];
const imp = (p) => import(pathToFileURL(W + '/packages/core/dist/mcp/' + p).href);
const { TOOLS } = await imp('tools.js'); const { BROWSER_TOOLS } = await imp('browser-tools.js');
const s = await imp('session-tools.js'); const w = await imp('swarm-tools.js');
const cat = await imp('code-mode/catalog.js'); const t = await imp('code-mode-tools.js');
const { getEncoding } = createRequire(TOK + '/noop.cjs')('js-tiktoken'); const enc = getEncoding('o200k_base');
const tok = (x) => enc.encode(x).length, B = (x) => Buffer.byteLength(x, 'utf8');
const list = [...TOOLS, ...BROWSER_TOOLS, s.CREATE_SESSION_TOOL, s.REQUEST_AGENT_SWITCH_TOOL, w.CREATE_SWARM_TOOL, w.SWARM_ADD_TOOL];
const catalog = cat.buildCatalog(list);
const surface = t.createCodeModeSurface({ backend: () => ({ catalog, launchId: 'replay-launch', broker: null }) });
const desc = new Map(catalog.entries.map((e) => [e.name, e.description]));
const first = (d, max) => { const flat = d.replace(/\s+/g, ' ').trim(); const m = /^(.+?[.!?])(\s|$)/.exec(flat); let x = m ? m[1] : flat; if (x.length > max) x = x.slice(0, max - 1) + '…'; return x; };
const realRev = 'cm1.' + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
console.log('apiRevision alone:', tok(JSON.stringify(realRev)), 'tok');
for (const q of ['parley', 'get_map', 'read_room', 'map', ' ']) {
  const r = await surface.call('code_search', { query: q }); const page = JSON.parse(r.content[0].text);
  const v4 = JSON.stringify({ ...page, apiRevision: realRev });
  const callable = page.items.filter((i) => i.availability !== 'unavailable');
  const una = page.items.filter((i) => i.availability === 'unavailable').map((i) => i.name);
  const mk = (max) => JSON.stringify({ apiRevision: realRev, kind: 'search', items: callable.map((i) => ({ name: i.name, summary: max ? first(desc.get(i.name), max) : i.summary, effect: i.effect, availability: i.availability })), unavailable: una, complete: page.complete, nextCursor: page.nextCursor });
  const a = mk(0), b = mk(120);
  console.log(`"${q}" items ${page.items.length} (callable ${callable.length}) complete ${page.complete} | now ${B(v4)} B ${tok(v4)} tok | D3a names-only ${B(a)} B ${tok(a)} tok | D3a+b 120ch ${B(b)} B ${tok(b)} tok`);
}
const r = await surface.call('code_search', { query: 'parley' }); const page = JSON.parse(r.content[0].text);
for (const i of page.items.filter((x) => x.availability !== 'unavailable')) console.log('summary now:', i.summary, '\n  first<=120:', first(desc.get(i.name), 120));
