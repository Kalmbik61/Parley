#!/usr/bin/env node
// Stub standing in for the real `qwen` (Qwen Code 0.27.2) in host tests. The real qwen never runs in
// automated tests. Offline: the only network use is the http hooks named in the settings file.
//
// Behaves like qwen as far as Parley relies on it (spec 2026-11-11, appendix A):
// - reads QWEN_CODE_SYSTEM_SETTINGS_PATH and fires its `hooks` (command: stdin JSON; http: POST JSON with
//   the configured headers), in the order SessionStart -> UserPromptSubmit -> (empty UserPromptSubmit) ->
//   Stop -> Notification idle_prompt, then SessionEnd on exit;
// - writes the transcript to $QWEN_HOME/projects/<cwd, non-alphanumerics -> "-">/chats/<id>.jsonl
//   ($QWEN_HOME defaults to $HOME/.qwen); --resume <id> appends to the same file;
// - flags: --version (prints 0.27.2), --session-id <id>, --resume <id>, -i/--prompt-interactive <text>,
//   -m/--model <name>, --approval-mode <mode>; everything else is ignored;
// - every stdin line is a new turn; the line STUB_EXIT exits.
//
// Environment:
//   STUB_QWEN_ANSWER=<text>      assistant reply (default "Hello from stub")
//   STUB_QWEN_EMPTY_PROMPT=1     fire an extra UserPromptSubmit with prompt "" after each prompt (qwen does
//                                this after tool results)
//   STUB_QWEN_ARGS_FILE=<path>   at start, write JSON { argv, cwd, env } there

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.27.2';
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}
const flag = (...names) => {
  const i = argv.findIndex((a) => names.includes(a));
  return i >= 0 ? argv[i + 1] : undefined;
};
const resumeId = flag('--resume', '-r');
const sessionId = resumeId ?? flag('--session-id') ?? randomUUID();
const model = flag('-m', '--model') ?? process.env.OPENAI_MODEL ?? 'mock-model';
const approvalMode = flag('--approval-mode') ?? 'default';
const firstPrompt = flag('-i', '--prompt-interactive');
const cwd = process.cwd();
const home = process.env.QWEN_HOME ?? join(process.env.HOME ?? homedir(), '.qwen');
const transcript = join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'chats', `${sessionId}.jsonl`);
const answer = process.env.STUB_QWEN_ANSWER ?? 'Hello from stub';

if (process.env.STUB_QWEN_ARGS_FILE) writeFileSync(process.env.STUB_QWEN_ARGS_FILE, JSON.stringify({ argv, cwd, env: process.env }));

mkdirSync(dirname(transcript), { recursive: true });
let lastUuid = null;
let turn = 0;
if (existsSync(transcript)) {
  const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const r = JSON.parse(l);
    lastUuid = r.uuid ?? lastUuid;
    if (r.type === 'user') turn += 1;
  }
}

const record = (type, extra) => {
  const uuid = randomUUID();
  const r = { uuid, parentUuid: lastUuid, sessionId, timestamp: new Date().toISOString(), type, cwd, version: VERSION, ...extra };
  lastUuid = uuid;
  appendFileSync(transcript, `${JSON.stringify(r)}\n`);
};

const settings = (() => {
  try {
    return JSON.parse(readFileSync(process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '', 'utf8'));
  } catch {
    return {};
  }
})();

const runCommand = (command, input) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('error', resolve);
    child.on('close', resolve);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

async function fire(event, extra = {}) {
  const payload = {
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    hook_event_name: event,
    timestamp: new Date().toISOString(),
    permission_mode: approvalMode,
    ...extra,
  };
  const body = JSON.stringify(payload);
  for (const group of settings.hooks?.[event] ?? []) {
    for (const hook of group.hooks ?? []) {
      if (hook.type === 'command' && hook.command) await runCommand(hook.command, body);
      else if (hook.type === 'http' && hook.url) {
        await globalThis.fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', ...hook.headers }, body }).catch((e) => console.error(`http hook failed: ${e.message}`));
      }
    }
  }
}

async function runTurn(prompt) {
  const promptId = `${sessionId}########${turn}`;
  turn += 1;
  await fire('UserPromptSubmit', { prompt_id: promptId, prompt, submitted_prompt: prompt });
  record('user', {
    provenance: 'real_user',
    executionContext: { modelId: model, authType: 'openai', approvalMode },
    message: { role: 'user', parts: [{ text: prompt }] },
    promptId,
  });
  record('system', { provenance: 'system', subtype: 'attribution_snapshot', systemPayload: { snapshot: { type: 'attribution-snapshot', version: 1, surface: 'cli', fileStates: {}, promptCount: turn, promptCountAtLastCommit: 0 } } });
  record('assistant', {
    provenance: 'assistant_output',
    model,
    message: { role: 'model', parts: [{ text: answer }] },
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 0, totalTokenCount: 23, cachedContentTokenCount: 0 },
  });
  console.log(answer);
  if (process.env.STUB_QWEN_EMPTY_PROMPT === '1') await fire('UserPromptSubmit', { prompt_id: promptId, prompt: '', submitted_prompt: '' });
  await fire('Stop', { prompt_id: promptId, stop_hook_active: false, last_assistant_message: answer, background_tasks: [], crons: [], context_usage: 0.0001, context_limit: 200000, input_tokens: 20 });
  await fire('Notification', { message: 'Qwen Code is waiting for your input', notification_type: 'idle_prompt', title: 'Waiting for input' });
}

async function exit(code = 0) {
  await fire('SessionEnd', { reason: 'other' });
  process.exit(code);
}

await fire('SessionStart', { source: resumeId ? 'resume' : 'startup', model });
if (firstPrompt) await runTurn(firstPrompt);

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.replace(/\r$/, '');
  if (!text.trim()) return;
  queue = queue.then(() => (text.trim() === 'STUB_EXIT' ? exit(0) : runTurn(text)));
});
rl.on('close', () => {
  queue = queue.then(() => exit(0));
});
