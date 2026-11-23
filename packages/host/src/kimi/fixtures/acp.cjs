#!/usr/bin/env node
const readline = require('node:readline');
const { realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');

async function parleyMap(server) {
  const env = { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) };
  const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  async function request(id, method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (;;) {
      const next = await replies.next();
      if (next.done) throw new Error('Parley MCP exited');
      const message = JSON.parse(next.value);
      if (message.id === id) {
        if (message.error) throw new Error(message.error.message);
        return message.result;
      }
    }
  }
  try {
    await request(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '0.0.0' }, capabilities: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await request(2, 'tools/call', { name: 'get_map', arguments: {} });
    if (result.isError) throw new Error('Parley get_map error');
    return JSON.parse(result.content[0].text).sessionId;
  } finally {
    lines.close();
    child.kill();
  }
}

const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const config = (currentValue = 'default') => [{
  id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue,
  options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
}];
const reply = (id, result) => write({ id, result });
const update = (sessionId, fields) => write({ method: 'session/update', params: { sessionId, update: fields } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
let prompt;
let mode = 'default';
let parleyServer;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      if (params.protocolVersion !== 1 || (process.env.KIMI_FIXTURE_EXPECT_FORMS && params.clientCapabilities.elicitation?.form === undefined)) process.exit(3);
      return reply(id, { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } } });
    case 'session/list':
      return process.env.KIMI_FIXTURE_LOGGED_OUT
        ? write({ id, error: { code: -32000, message: 'Authentication required' } })
        : reply(id, { sessions: [] });
    case 'session/new':
    case 'session/load':
    case 'session/resume': {
      if (process.env.KIMI_FIXTURE_LOGGED_OUT) return write({ id, error: { code: -32000, message: 'Authentication required' } });
      const server = params.mcpServers[0];
      if (realpathSync(params.cwd) !== process.cwd() || server.name !== 'parley' || server.env.find(({ name }) => name === 'PARLEY_SESSION_ID')?.value !== 's-01') process.exit(4);
      parleyServer = server;
      if (method === 'session/load') {
        update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Old question' } });
        chunk(params.sessionId, 'Old answer');
      }
      return reply(id, { sessionId: params.sessionId ?? 'acp-session', configOptions: config(mode) });
    }
    case 'session/set_config_option':
      if (params.sessionId !== 'acp-session' || params.configId !== 'mode') process.exit(5);
      mode = params.value;
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: config(mode) });
      return reply(id, { configOptions: config(mode) });
    case 'session/prompt':
      if (params.sessionId !== 'acp-session') process.exit(6);
      prompt = id;
      if (params.prompt[0].text === 'disconnect') process.exit(7);
      if (params.prompt[0].text === 'approve') {
        return write({ id: 700, method: 'session/request_permission', params: {
          sessionId: params.sessionId, toolCall: { toolCallId: 'tool', title: 'Write file' },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
        } });
      }
      if (params.prompt[0].text === 'question') {
        return write({ id: 701, method: 'elicitation/create', params: {
          sessionId: params.sessionId, mode: 'form', message: 'Name?', requestedSchema: {
            type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
          },
        } });
      }
      if (params.prompt[0].text === 'wait') return chunk(params.sessionId, '');
      if (params.prompt[0].text === 'call Parley') {
        return parleyMap(parleyServer).then((id) => {
          chunk(params.sessionId, `Parley session: ${id}`);
          reply(prompt, { stopReason: 'end_turn' });
        }).catch(() => process.exit(9));
      }
      chunk('another-session', 'incorrect');
      chunk(params.sessionId, 'Hello');
      chunk(params.sessionId, ' Parley');
      return reply(id, { stopReason: 'end_turn' });
    case 'session/cancel':
      if (params.sessionId !== 'acp-session' || id !== undefined) process.exit(8);
      return reply(prompt, { stopReason: 'cancelled' });
    case 'session/close':
      return reply(id, {});
    case undefined:
      if (id === 700 && result.outcome.optionId) chunk('acp-session', result.outcome.optionId);
      if (id === 701 && result.action === 'accept') chunk('acp-session', result.content.name);
      return reply(prompt, { stopReason: 'end_turn' });
  }
});
