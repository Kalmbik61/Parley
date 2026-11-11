#!/usr/bin/env node
// Stub agent for the dry run of tools/mail-turns-bench.ts: stands in for `claude`, no model, no paid call.
// It does what the scenario prompts ask through the REAL parley MCP server (config from `--mcp-config`, as Claude Code
// starts it): scenario W (send "ready", wait_for inbox, answer number + 1, report on STOP) and scenario P (report, end
// the turn, answer the pointer with check_inbox + number + 1). It writes hook rows to the work's events journal and a
// Claude-shaped transcript to $STUB_TRANSCRIPT_DIR/<session id>.jsonl, so the harness sees what it sees with a real agent.
// What it cannot show: the real transcript format of Claude Code, "moved to the background", real hook delivery.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const fromEnv = (key) => process.env[`PARLEY_${key}`] ?? process.env[`HARNAS_${key}`];

if (process.argv[2] === '--version') {
  process.stdout.write('2.1.322 (Claude Code)\n');
  process.exit(0);
}

const argvValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sessionUuid = argvValue('--session-id') ?? 'stub-session';
const eventsDir = path.join(fromEnv('WORK_DIR') ?? '.', 'events');
const transcriptDir = process.env.STUB_TRANSCRIPT_DIR;

const journal = (event) => {
  mkdirSync(eventsDir, { recursive: true });
  appendFileSync(path.join(eventsDir, `${fromEnv('SESSION_ID')}.jsonl`), `${JSON.stringify({ hook_event_name: event, session_id: sessionUuid })}\n`);
};
const transcript = (row) => {
  if (transcriptDir === undefined) return;
  mkdirSync(transcriptDir, { recursive: true });
  appendFileSync(path.join(transcriptDir, `${sessionUuid}.jsonl`), `${JSON.stringify({ sessionId: sessionUuid, timestamp: new Date().toISOString(), ...row })}\n`);
};

journal('StubReady');
journal('SessionStart');
process.stdout.write('stub mail-turns ready\r\n');

// ---- the real MCP server over stdio ----
let request;
function startMcp() {
  const server = JSON.parse(readFileSync(argvValue('--mcp-config'), 'utf8')).mcpServers.parley;
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  process.on('exit', () => child.kill());
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const wait = pending.get(message.id);
    if (wait === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) wait.reject(new Error(message.error.message));
    else wait.resolve(message.result);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  return call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mail-turns-stub', version: '0.0.0' } }).then(() => {
    send({ method: 'notifications/initialized' });
    return call;
  });
}

// ---- one model "response" per tool call, as in a transcript ----
let counter = 0;
async function tool(name, args) {
  counter += 1;
  const messageId = `msg_stub_${counter}`;
  const toolUseId = `toolu_stub_${counter}`;
  transcript({
    type: 'assistant',
    message: {
      id: messageId, role: 'assistant', model: 'stub',
      content: [{ type: 'tool_use', id: toolUseId, name: `mcp__parley__${name}`, input: args }],
      usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 20 },
    },
  });
  request ??= await startMcp();
  let text;
  try {
    const result = await request('tools/call', { name, arguments: args });
    text = (result.content ?? []).map((part) => part.text ?? '').join('');
  } catch (error) {
    text = `error: ${error.message}`;
  }
  transcript({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } });
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const finalText = () => {
  counter += 1;
  transcript({
    type: 'assistant',
    message: { id: `msg_stub_${counter}`, role: 'assistant', model: 'stub', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 3 } },
  });
};

const numberIn = (text) => /\d+/.exec(text)?.[0];

/** Answer every numbered letter of a page; true when a STOP letter was seen. */
async function answer(page) {
  let stop = false;
  for (const message of page.messages ?? []) {
    if (/STOP/.test(message.text)) stop = true;
    const n = numberIn(message.text);
    if (n !== undefined && !stop) await tool('send_message', { to: 'human', text: String(Number(n) + 1) });
  }
  return stop;
}

async function turn(prompt) {
  journal('UserPromptSubmit');
  transcript({ type: 'user', message: { role: 'user', content: prompt } });
  if (/wait for mail/.test(prompt)) {
    await tool('send_message', { to: 'human', text: 'ready' });
    for (;;) {
      const page = await tool('wait_for', { target: 'inbox', timeoutSec: 1500 });
      if (await answer(page)) break;
    }
    await tool('report', { status: 'done', summary: 'stopped' });
  } else if (/Call report/.test(prompt)) {
    await tool('report', { status: 'done', summary: 'ready for letters' });
  } else if (/^New messages/.test(prompt.trim())) {
    await answer(await tool('check_inbox', {}));
  }
  finalText();
  journal('Stop');
}

let buffer = '';
let busy = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() !== '') busy = busy.then(() => turn(line));
  }
});
