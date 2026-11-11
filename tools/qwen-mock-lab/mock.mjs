#!/usr/bin/env node
// OpenAI-compatible mock model for running the real `qwen` offline.
// Usage: node mock.mjs <log-file> [port]   (binds 127.0.0.1 only; the port is written to <log-file>.port)
//
// The mode is chosen per request by a trigger word anywhere in the conversation, or by MOCK_MODE:
//   mcpflow    - tool_search select:mcp__parley__echo, then tool_call {name: mcp__parley__echo}, then text
//   shellflow  - run_shell_command `echo hi`, then text
//   thinkflow  - reasoning_content + content
//   autherr    - HTTP 401 (invalid api key)
//   quotaerr   - HTTP 429 (quota exceeded)
//   (default)  - reasoning_content "thinking about it" + content "Hello from mock"
// Endpoints: POST /v1/chat/completions (stream and non-stream), GET /v1/models.
import http from 'node:http';
import fs from 'node:fs';

const log = process.argv[2];
if (!log) {
  console.error('usage: node mock.mjs <log-file> [port]');
  process.exit(2);
}
let seq = 0;

const modeOf = (text) => {
  for (const m of ['autherr', 'quotaerr', 'mcpflow', 'shellflow', 'thinkflow']) if (text.includes(m)) return m;
  return process.env.MOCK_MODE || 'text';
};

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      fs.appendFileSync(log, `${JSON.stringify({ m: req.method, u: req.url, auth: !!req.headers.authorization, body: body.slice(0, 200000) })}\n`);
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.includes('/models')) return json(200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        /* keep {} */
      }
      const msgs = j.messages || [];
      const all = JSON.stringify(msgs);
      const mode = modeOf(all);
      if (mode === 'autherr') return json(401, { error: { message: 'Incorrect API key provided: mock.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (mode === 'quotaerr')
        return json(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });

      const nTool = msgs.filter((m) => m.role === 'tool').length;
      let call = null;
      if (mode === 'mcpflow' && nTool === 0) call = ['tool_search', { query: 'select:mcp__parley__echo' }];
      else if (mode === 'mcpflow' && nTool === 1) call = ['tool_call', { name: 'mcp__parley__echo', arguments: { text: 'hi' } }];
      else if (mode === 'shellflow' && nTool === 0) call = ['run_shell_command', { command: 'echo hi', is_background: false, description: 'x' }];
      const toolCalls = call ? [{ index: 0, id: `call_${nTool}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] : undefined;
      const text = call ? 'step' : 'Hello from mock';
      const reasoning = call ? undefined : 'thinking about it';
      const usage = call ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } : { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 };
      const finish = call ? 'tool_calls' : 'stop';
      const base = { id: `c${++seq}`, created: 1, model: 'mock-model' };

      if (j.stream === false) {
        const message = { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: t.type, function: t.function })) } : {}) };
        return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant', ...(reasoning ? { reasoning_content: reasoning } : {}), content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  })
  .listen(Number(process.argv[3] || 0), '127.0.0.1', function () {
    fs.writeFileSync(`${log}.port`, String(this.address().port));
  });
