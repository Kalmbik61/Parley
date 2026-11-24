// The model's tool list per permissions list (O10 read-only check, fixture
// packages/core/src/work/__fixtures__/opencode-read-only-tools.json).
// Usage: OPENCODE=<opencode 2.2.7> node record-tools.mjs <empty work dir> '<permissions JSON list>'
// Throwaway HOME/XDG under the work dir, the lab mock model and MCP server; every process is killed at the end.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
const [W, perms] = process.argv.slice(2);
const LAB = path.dirname(fileURLToPath(import.meta.url));
const OC = process.env.OPENCODE;
if (!W || !perms || !OC) {
  console.error('usage: OPENCODE=<binary> node record-tools.mjs <work dir> <permissions JSON>');
  process.exit(2);
}
for (const d of ['home/cfg', 'home/data', 'home/state', 'home/cache', 'proj']) mkdirSync(path.join(W, d), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: `${W}/home`, XDG_CONFIG_HOME: `${W}/home/cfg`, XDG_DATA_HOME: `${W}/home/data`,
  XDG_STATE_HOME: `${W}/home/state`, XDG_CACHE_HOME: `${W}/home/cache`, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: 'lab-secret' };
const mock = spawn(process.execPath, [`${LAB}/mock.mjs`, `${W}/mock.log`], { env, stdio: 'ignore' });
for (let i = 0; i < 40 && !existsSync(`${W}/mock.log.port`); i++) await sleep(100);
const port = readFileSync(`${W}/mock.log.port`, 'utf8').trim();
const config = { provider: { mock: { name: 'Mock', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { 'mock-1': { name: 'Mock 1' } } } },
  model: 'mock/mock-1', mcp: { parley: { type: 'local', command: [process.execPath, `${LAB}/mcp.mjs`], environment: { MCP_LOG: `${W}/mcp.log` } } },
  permissions: JSON.parse(perms), autoupdate: false };
const serve = spawn(OC, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: `${W}/proj`, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let err = '';
serve.stdout.on('data', (c) => { out += c; }); serve.stderr.on('data', (c) => { err += c; });
for (let i = 0; i < 80 && !/listening on/.test(out); i++) await sleep(250);
const url = /http:\/\/127\.0\.0\.1:\d+/.exec(out)?.[0];
const auth = { authorization: 'Basic ' + Buffer.from('opencode:lab-secret').toString('base64'), 'content-type': 'application/json' };
try {
  await sleep(1500);
  await globalThis.fetch(`${url}/api/session`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'ses_ro00000001' }) });
  await globalThis.fetch(`${url}/api/session/ses_ro00000001/prompt`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'MCPCALL please' }) });
  for (let i = 0; i < 40; i++) {
    const n = existsSync(`${W}/mock.log`) ? readFileSync(`${W}/mock.log`, 'utf8').split('\n').filter((l) => l.includes('"tools"')).length : 0;
    if (n >= 2) break; await sleep(500);
  }
  await sleep(1000);
  const lists = new Set((existsSync(`${W}/mock.log`) ? readFileSync(`${W}/mock.log`, 'utf8').split('\n') : []).filter(Boolean)
    .map((l) => JSON.parse(l)).filter((j) => Array.isArray(j.tools) && j.tools.length > 0).map((j) => JSON.stringify([...j.tools].sort())));
  console.log('tool lists:', [...lists].join(' | ') || 'none');
  console.log('mcp tools/call:', existsSync(`${W}/mcp.log`) ? readFileSync(`${W}/mcp.log`, 'utf8').split('\n').filter((l) => l.includes('tools/call')).length : 0);
  console.log('server errors:', /error/i.test(err + out) ? (err + out).split('\n').filter((l) => /error/i.test(l)).slice(0, 3).join(' / ') : 'none');
} finally {
  serve.kill('SIGKILL'); mock.kill('SIGKILL');
}
