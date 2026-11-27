#!/usr/bin/env node
// Live capture of the native AskUserQuestion dialog of the installed qwen, rendered through the
// same headless xterm screen the host uses, then fed to the host recogniser.
// Usage: node ask-probe.mjs [cols] [rows]   (default 190x30; binds 127.0.0.1 only)
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, '../../packages/host');
const require = createRequire(path.join(hostRoot, 'package.json'));
const pty = require('node-pty');
const { createScreen } = await import(path.join(hostRoot, 'dist/pty/screen.js'));
const { recogniseQwenPrompt } = await import(path.join(hostRoot, 'dist/feed/qwen-prompt.js'));
const { createQwenTerminalParser } = await import(path.join(hostRoot, 'dist/pty/qwen-terminal.js'));

const cols = Number(process.argv[2] || 190);
const rows = Number(process.argv[3] || 30);
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ask-'));
fs.mkdirSync(path.join(W, 'home'), { recursive: true });
fs.mkdirSync(path.join(W, 'proj'), { recursive: true });

const mock = spawnChild(process.execPath, [path.join(here, 'mock.mjs'), path.join(W, 'mock.log')], { stdio: 'ignore' });
let port = null;
for (let i = 0; i < 100 && port === null; i++) {
  await new Promise(r => setTimeout(r, 100));
  try { port = fs.readFileSync(path.join(W, 'mock.log.port'), 'utf8').trim(); } catch { /* port not written yet */ }
}
if (port === null) { console.error('mock did not start'); process.exit(1); }

const env = {
  ...process.env,
  HOME: path.join(W, 'home'),
  QWEN_HOME: path.join(W, 'home', '.qwen'),
  OPENAI_API_KEY: 'mock',
  OPENAI_MODEL: 'mock-model',
  OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  TERM: 'xterm-256color',
};
delete env.QWEN_CODE_SYSTEM_SETTINGS_PATH;

const screen = createScreen(cols, rows);
const parser = createQwenTerminalParser();
const reports = [];
const child = pty.spawn(path.join(os.homedir(), '.local/lib/qwen-code/bin/qwen'),
  ['--approval-mode', 'yolo', '-i', 'askflow'], { cols, rows, cwd: path.join(W, 'proj'), env });
child.onData(d => { screen.write(d); for (const r of parser.feed(d)) reports.push(r); });

let trusted = false;
let captured = null;
const started = Date.now();
while (Date.now() - started < 45000 && captured === null) {
  await new Promise(r => setTimeout(r, 250));
  const lines = screen.text();
  const text = lines.join('\n');
  if (!trusted && /Trust this folder\?/.test(text)) { trusted = true; child.write('1\r'); continue; }
  if (/↑\/↓:.*Enter:/.test(text) && /(Waiting for user confirmation|Ожидание подтверждения от пользователя)/.test(text)) {
    await new Promise(r => setTimeout(r, 600));
    captured = screen.text();
  }
}
const result = captured === null ? null : recogniseQwenPrompt(captured, 'question', 'card', new Date().toISOString());
const out = JSON.stringify({ cols, rows, captured: captured !== null, recognised: result !== null,
  rowsParsed: result?.rows.length ?? 0, reports, lines: captured ?? screen.text() }, null, 2);
fs.writeFileSync(path.join(os.tmpdir(), 'qwen-ask-last-capture.json'), out);
console.log(out);
child.kill();
mock.kill();
try { fs.rmSync(W, { recursive: true, force: true, maxRetries: 3 }); } catch { /* qwen may still hold files */ }
process.exit(0);
