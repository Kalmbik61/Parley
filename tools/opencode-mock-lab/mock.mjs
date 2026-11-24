// OpenAI-compatible mock model for the OpenCode lab. Usage: node mock.mjs <log-file>  (MOCK_PORT=0 picks a free port;
// the port is written to <log-file>.port). Trigger words in the last user message pick the script:
//   FULLTURN  reasoning + text, `shell` call, then `execute` calling tools.parley.check_inbox, then a final text
//   MCPCALL   `execute` calling tools.parley.check_inbox   MCPWAIT  `execute` calling tools.parley.wait_for
//   MCPFAIL   `execute` whose code throws                  BASHCALL  `shell` call
//   SLOW      default reply after 4 s (keeps the session busy so a prompt can queue)
//   LLM500    HTTP 500 from the model (OpenCode retries it with a back-off)
//   LLM400    HTTP 400 from the model (not retried)       default   reasoning + text
import http from 'node:http';
import fs from 'node:fs';
import { setTimeout } from 'node:timers';

const LOG = process.argv[2] || process.env.MOCK_LOG || 'mock.log';
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');

function script(msgs, tools) {
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user') || {};
  const text = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
  const after = msgs.slice(msgs.lastIndexOf(lastUser) + 1).filter((m) => m.role === 'tool').length;
  const has = (n) => tools.includes(n);
  const exec = (code) => (has('execute') ? ['execute', { code }] : null);
  const calls = {
    FULLTURN: [() => (has('shell') ? ['shell', { command: 'echo hello-from-shell', description: 'echo' }] : null),
      () => exec('return await tools.parley.check_inbox({})')],
    MCPCALL: [() => exec('return await tools.parley.check_inbox({})')],
    MCPWAIT: [() => exec('return await tools.parley.wait_for({target:"inbox",timeoutSec:5})')],
    MCPFAIL: [() => exec('throw new Error("boom from execute")')],
    BASHCALL: [() => (has('shell') ? ['shell', { command: 'echo hello-from-shell', description: 'echo' }] : null)],
  };
  const key = Object.keys(calls).find((k) => text.includes(k));
  if (text.includes('LLM500')) return { fail: 500 };
  if (text.includes('LLM400')) return { fail: 400 };
  if (key && after < calls[key].length) return { call: calls[key][after]() };
  return { text: after > 0 ? 'TOOLRESULT: ' + (msgs.at(-1).content || '').toString().slice(0, 200) : 'mock reply to: ' + text.slice(0, 80) };
}

http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }));
    }
    let j = {};
    try { j = JSON.parse(b); } catch { /* not json */ }
    const msgs = j.messages || [];
    const tools = (j.tools || []).map((t) => t.function?.name);
    log({ url: req.url, auth: req.headers.authorization, model: j.model, tools, nmsgs: msgs.length, last: msgs.at(-1), keys: Object.keys(j) });
    const plan = script(msgs, tools);
    const wait = JSON.stringify(msgs.at(-1) || '').includes('SLOW') ? 4000 : 0;
    setTimeout(() => respond(plan, res), wait);
  });
}).listen(Number(process.env.MOCK_PORT ?? 0), '127.0.0.1', function () {
  fs.writeFileSync(LOG + '.port', String(this.address().port));
  console.log('mock on', this.address().port);
});

function respond(plan, res) {
    if (plan.fail) { res.writeHead(plan.fail, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"mock model failure"}}'); }
    const id = 'chatcmpl-' + Date.now();
    const chunk = (delta, fin) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: fin || null }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', reasoning_content: plan.call ? 'thinking about calling a tool' : 'mock reasoning' }));
    if (plan.call) {
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: plan.call[0], arguments: JSON.stringify(plan.call[1]) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ content: plan.text }));
      res.write(chunk({}, 'stop'));
    }
    res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
 }
