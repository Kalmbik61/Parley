#!/usr/bin/env node
const readline = process.getBuiltinModule('node:readline');
const { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { spawn } = process.getBuiltinModule('node:child_process');

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
const booleanConfig = process.env.KIMI_FIXTURE_BOOLEAN_CONFIG === '1';
const modelFile = process.env.KIMI_FIXTURE_MODEL_FILE;
let model = modelFile && existsSync(modelFile) ? readFileSync(modelFile, 'utf8') : 'alpha';
let thinking = false;
let effort = 'low';
const creationConfig = process.env.KIMI_FIXTURE_CREATION_CONFIG === '1';
const trace = (event) => { if (process.env.KIMI_FIXTURE_TRACE) appendFileSync(process.env.KIMI_FIXTURE_TRACE, JSON.stringify(event) + '\n'); };
const config = (currentValue = 'default') => [{
  id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue,
  options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
}, ...(booleanConfig ? [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: thinking }] : []),
...(creationConfig && !booleanConfig ? [{
  id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: effort,
  options: (model === 'beta' ? ['low', 'high', 'max'] : ['low', 'high']).map((value) => ({ value, name: value })),
}] : []), ...(modelFile || creationConfig ? [{
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }],
}] : [])];
const reply = (id, result) => write({ id, result });
const update = (sessionId, fields) => write({ method: 'session/update', params: { sessionId, update: fields } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const askFallback = (sessionId) => write({ id: 702, method: 'session/request_permission', params: {
  sessionId,
  toolCall: {
    toolCallId: 'question-tool', title: 'AskUserQuestion',
    content: [{ type: 'content', content: { type: 'text', text: 'Which release?' } }],
  },
  options: [
    { optionId: 'option:stable', kind: 'allow_once', name: 'Stable' },
    { optionId: 'q0_skip', kind: 'reject_once', name: 'Skip' },
  ],
} });
let prompt;
let mode = 'default';
let parleyServer;
let writeWhenAllowed = false;
let forms = false;
const concurrentAnswers = new Map();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      forms = params.clientCapabilities.elicitation?.form !== undefined;
      if (params.protocolVersion !== 1 || (process.env.KIMI_FIXTURE_EXPECT_FORMS && params.clientCapabilities.elicitation?.form === undefined)) process.exit(3);
      if (booleanConfig && params.clientCapabilities.session?.configOptions?.boolean === undefined) process.exit(3);
      return reply(id, {
        protocolVersion: 1,
        ...(process.env.KIMI_FIXTURE_ADVERTISE_LOGIN ? { authMethods: [{ id: 'login', name: 'Login' }] } : {}),
        agentInfo: { name: 'Kimi Code CLI' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true }, sessionCapabilities: { resume: {}, list: {} } },
      });
    case 'authenticate':
      if (params.methodId !== 'login') process.exit(6);
      return process.env.KIMI_FIXTURE_AUTH_REQUIRED
        ? write({ id, error: { code: -32000, message: 'Authentication required' } })
        : reply(id, {});
    case 'session/list':
      return process.env.KIMI_FIXTURE_LOGGED_OUT
        ? write({ id, error: { code: -32000, message: 'Authentication required' } })
        : reply(id, { sessions: [] });
    case 'session/new':
    case 'session/load':
    case 'session/resume': {
      if (process.env.KIMI_FIXTURE_LOGGED_OUT) return write({ id, error: { code: -32000, message: 'Authentication required' } });
      const server = params.mcpServers[0];
      if (realpathSync(params.cwd) !== process.cwd() || server.name !== 'parley' || !/^s-0[12]$/.test(server.env.find(({ name }) => name === 'PARLEY_SESSION_ID')?.value ?? '')) process.exit(4);
      parleyServer = server;
      if (method === 'session/load') {
        update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Old question' } });
        chunk(params.sessionId, 'Old answer');
      }
      return reply(id, { sessionId: params.sessionId ?? 'acp-session', configOptions: config(mode) });
    }
    case 'session/set_config_option':
      if (params.sessionId !== 'acp-session') process.exit(5);
      if (process.env.KIMI_FIXTURE_REJECT_CONFIG) {
        return write({ id, error: { code: -32602, message: '\x1b[31mPlan mode is unavailable for this session.\x1b[0m\nInternal detail' } });
      }
      trace({ configId: params.configId, value: params.value });
      if (process.env.KIMI_FIXTURE_IGNORE_CONFIG) return reply(id, { configOptions: config(mode) });
      if (params.configId === 'mode') mode = params.value;
      else if (booleanConfig && params.configId === 'thinking' && params.type === 'boolean') thinking = params.value;
      else if ((modelFile || creationConfig) && params.configId === 'model' && ['alpha', 'beta'].includes(params.value)) {
        model = params.value;
        if (modelFile) writeFileSync(modelFile, model);
        effort = 'low';
      } else if (creationConfig && !booleanConfig && params.configId === 'thinking') effort = params.value;
      else process.exit(5);
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: config(mode) });
      return reply(id, { configOptions: config(mode) });
    case 'session/prompt':
      trace({ prompt: params.prompt[0].text, model, effort });
      if (params.sessionId !== 'acp-session') process.exit(6);
      prompt = id;
      if (params.prompt[0].text === 'disconnect') process.exit(7);
      writeWhenAllowed = params.prompt[0].text === 'approve and write';
      if (['approve', 'large approval', 'approve and write'].includes(params.prompt[0].text)) {
        const before = params.prompt[0].text === 'large approval' ? 'x'.repeat(70 * 1024) : 'before';
        return write({ id: 700, method: 'session/request_permission', params: {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'tool', title: 'WriteFile',
            content: [
              { type: 'content', content: { type: 'text', text: 'Write the release notes to notes.md' } },
              { type: 'diff', path: 'notes.md', oldText: before, newText: 'after' },
            ],
          },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
        } });
      }
      if (params.prompt[0].text === 'fallback question') {
        return askFallback(params.sessionId);
      }
      if (params.prompt[0].text === 'question') {
        return write({ id: 701, method: 'elicitation/create', params: {
          sessionId: params.sessionId, mode: 'form', message: 'Name?', requestedSchema: {
            type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
          },
        } });
      }
      if (params.prompt[0].text === 'mixed form') {
        if (!forms) process.exit(10);
        return write({ id: 703, method: 'elicitation/create', params: {
          sessionId: params.sessionId, mode: 'form', message: 'Release details', requestedSchema: {
            type: 'object',
            properties: {
              channels: { title: 'Channels', type: 'array', minItems: 1, items: { anyOf: [
                { title: 'Stable, stable', const: 'stable' }, { title: 'Beta', const: 'beta' },
              ] } },
              note: { title: 'Note', type: 'string' },
            },
            required: ['channels', 'note'],
          },
        } });
      }
      if (params.prompt[0].text === 'parallel questions') {
        if (!forms) process.exit(10);
        for (const [id, message] of [[705, 'First question'], [706, 'Second question']]) {
          write({ id, method: 'elicitation/create', params: {
            sessionId: params.sessionId, mode: 'form', message, requestedSchema: {
              type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'],
            },
          } });
        }
        return;
      }
      if (params.prompt[0].text === 'unsupported form') {
        return write({ id: 704, method: 'elicitation/create', params: {
          sessionId: params.sessionId, mode: 'form', message: 'Unsupported form', requestedSchema: {
            type: 'object', properties: { nested: { type: 'object' } },
          },
        } });
      }
      if (params.prompt[0].text === 'wait') return chunk(params.sessionId, '');
      if (params.prompt[0].text === 'inspect context') {
        chunk(params.sessionId, JSON.stringify(params.prompt.slice(1)));
        return reply(id, { stopReason: 'end_turn' });
      }
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
      if (id === 705 || id === 706) {
        concurrentAnswers.set(id, result.content.answer);
        if (concurrentAnswers.size < 2) return;
        chunk('acp-session', `${concurrentAnswers.get(705)} / ${concurrentAnswers.get(706)}`);
      }
      if (id === 704 && error) return askFallback('acp-session');
      if (id === 700 && writeWhenAllowed && result.outcome.optionId === 'allow') writeFileSync('notes.md', 'after');
      if ((id === 700 || id === 702) && result.outcome.optionId) chunk('acp-session', result.outcome.optionId);
      if (id === 701 && result.action === 'accept') chunk('acp-session', result.content.name);
      if (id === 703 && result.action === 'accept') chunk('acp-session', JSON.stringify(result.content));
      return reply(prompt, { stopReason: 'end_turn' });
  }
});
