// Drives a running `opencode serve` (started by run.sh with permissions ask for everything but parley_*)
// and writes raw API recordings. Usage: node record.mjs <work-dir> <port> <out-dir>. Sanitising is done by record.sh.
import fs from 'node:fs';

const [, , W, port, OUT] = process.argv;
const B = `http://127.0.0.1:${port}`;
const auth = 'Basic ' + Buffer.from('opencode:' + (process.env.PW || 'lab-secret')).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body) => {
  const res = await fetch(B + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const save = (name, text) => fs.writeFileSync(`${OUT}/${name}`, text);
const mkSession = (id) => call('POST', '/api/session', { id });
const prompt = (id, text) => call('POST', `/api/session/${id}/prompt`, { text });

const raw = await fetch(B + '/health');
save('health.head.txt', `HTTP ${raw.status} ${raw.headers.get('content-type')}\n` + (await raw.text()).slice(0, 200));
const doc = await fetch(B + '/doc');
save('doc.head.txt', `HTTP ${doc.status} ${doc.headers.get('content-type')}\n` + (await doc.text()).slice(0, 200));
save('info.json', (await call('GET', '/api/info')).text);

const spec = JSON.parse((await call('GET', '/openapi.json')).text);
const paths = Object.keys(spec.paths || {});
save('openapi-paths.txt', paths.join('\n') + '\n');
const modelPath = paths.find((p) => /^\/api\/model$/.test(p)) || paths.find((p) => /model/.test(p) && !p.includes('{'));
if (modelPath) save('models-api.json', (await call('GET', modelPath)).text.slice(0, 4000));

const events = fs.createWriteStream(`${OUT}/events.sse.txt`);
const ctl = new AbortController();
fetch(B + '/api/event', { headers: { authorization: auth }, signal: ctl.signal }).then(async (r) => {
  for await (const chunk of r.body) events.write(chunk);
}).catch(() => {});
await sleep(500);

// 1. full turn: reasoning, text, shell (asks), execute -> check_inbox (parley_* allowed)
await mkSession('ses_labfull0001');
await prompt('ses_labfull0001', 'FULLTURN please');
let asked;
for (let i = 0; i < 20 && !asked; i++) { await sleep(300); asked = JSON.parse((await call('GET', '/api/permission/request')).text).data?.[0]; }
save('permission-list.json', JSON.stringify(asked ?? null, null, 1));
if (asked) await call('POST', `/api/session/${asked.sessionID}/permission/${asked.id}/reply`, { decision: 'once' });
await sleep(2500);
save('messages-turn.json', (await call('GET', '/api/session/ses_labfull0001/message')).text);
save('session.json', (await call('GET', '/api/session/ses_labfull0001')).text);

// 2. a queued prompt in the inbox while the first one is busy
await mkSession('ses_labqueue001');
await prompt('ses_labqueue001', 'SLOW first');
await sleep(800);
save('prompt-queued.json', (await prompt('ses_labqueue001', 'second queued prompt')).text);
save('inbox.json', (await call('GET', '/api/session/ses_labqueue001/inbox')).text);

// 3. failed execute code, and a model error that is not retried
await mkSession('ses_labfail0001');
await prompt('ses_labfail0001', 'MCPFAIL now');
await mkSession('ses_labfail0002');
await prompt('ses_labfail0002', 'LLM400 now');
await sleep(4500);
save('messages-execute-error.json', (await call('GET', '/api/session/ses_labfail0001/message')).text);
save('messages-model-error.json', (await call('GET', '/api/session/ses_labfail0002/message')).text);
await sleep(500);
ctl.abort();
events.end();
