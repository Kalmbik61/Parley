#!/usr/bin/env node
// Изолированный Claude Code для E2E своих провайдеров (спека 2026-10-17, 6): только stdin и HTTP-хуки на loopback.
// В файл признаков пишет булевы признаки и пути, а не ключ, заголовки или argv. Транскрипт — в $CLAUDE_CONFIG_DIR/projects
// (у обычной сессии без переменной — в $HOME/.claude/projects, как у настоящего Claude Code).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

if (process.argv[2] === '--version') {
  process.stdout.write('2.1.303 (Claude Code)\n');
  process.exit(0);
}

const valueOf = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const settingsFile = valueOf('--settings');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
const providerSessionId = valueOf('--session-id') ?? valueOf('--resume');
// Resume проверяет наличие разговора. Это только синтетическая история во временном доме.
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const transcriptDir = path.join(configDir, 'projects', 'stub-project');
mkdirSync(transcriptDir, { recursive: true });
if (valueOf('--session-id') !== undefined) {
  appendFileSync(path.join(transcriptDir, `${providerSessionId}.jsonl`), `${JSON.stringify({ sessionId: providerSessionId, type: 'user', cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Isolated fake conversation for resume' } })}\n`);
}
const fakeKey = 'e2e-fake-custom-key-never-valid-0001';
const httpHooks = Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks ?? [])).filter((hook) => hook.type === 'http');
const hook = httpHooks[0];
if (hook === undefined) throw new Error('Host did not supply HTTP hooks');
const url = new URL(hook.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Only loopback HTTP hooks are permitted');
const record = (file, data) => {
  if (file) appendFileSync(file, `${JSON.stringify(data)}\n`);
};
const appended = valueOf('--append-system-prompt') ?? '';
const keyVar = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].find((name) => process.env[name] === fakeKey) ?? null;
record(process.env.STUB_LAUNCH_LOG, {
  sessionId: process.env.PARLEY_SESSION_ID,
  settings: path.basename(settingsFile),
  model: valueOf('--model') ?? null,
  resume: valueOf('--resume') !== undefined,
  systemPrompt: appended !== '',
  // Правило о ссылках (спека 5.8): есть ли оно и называет ли папку провайдера.
  linkRule: appended.includes('symlinked entries'),
  linkRuleDir: configDir !== '' && appended.includes(`${configDir}/CLAUDE.md`),
  // Пути — не секрет; ключ только булевым признаком.
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  secureStorageDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  keyOk: keyVar !== null,
  keyVar,
  anyKeyVar: Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
  fakeKeyAnywhere: Object.values(process.env).some((value) => value === fakeKey),
  fakeKeyInArgv: process.argv.some((arg) => arg.includes(fakeKey)),
  fakeKeyInSettings: JSON.stringify(settings).includes(fakeKey),
  managedByHost: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1',
  opusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
  sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
  haikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
});

// До первого тестового хука активность остаётся неизвестной: окно показывает Terminal onboarding.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004hstub-custom ready\r\n');

const reportHook = (event, status, response) => record(process.env.STUB_HOOK_LOG, { sessionId: process.env.PARLEY_SESSION_ID, event, status, response });
function postHook(text) {
  const body = { ...JSON.parse(text), session_id: providerSessionId };
  const event = body.hook_event_name;
  const payload = JSON.stringify(body);
  const events = path.join(process.env.PARLEY_WORK_DIR, 'events');
  mkdirSync(events, { recursive: true });
  appendFileSync(path.join(events, `${process.env.PARLEY_SESSION_ID}.jsonl`), `${payload}\n`);
  const allowed = hook.allowedEnvVars ?? [];
  const substitute = (value) => String(value).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => allowed.includes(name) ? (process.env[name] ?? '') : whole);
  const headers = Object.fromEntries(Object.entries(hook.headers ?? {}).map(([name, value]) => [name, substitute(value)]));
  const request = http.request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { reportHook(event, response.statusCode ?? 0, raw.trim() === '' ? {} : JSON.parse(raw)); }
      catch { reportHook(event, response.statusCode ?? 0, { error: 'Invalid hook response' }); }
    });
  });
  request.on('error', () => reportHook(event, 0, { error: 'Loopback hook failed' }));
  request.end(payload);
}

let buffer = '';
let pending = '';
let pasting = false;
const START = '\x1b[200~';
const END = '\x1b[201~';
function typed(text) {
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      if (buffer.startsWith('STUB_HOOK ')) postHook(buffer.slice('STUB_HOOK '.length));
      else if (buffer) process.stdout.write(`echo: ${buffer}\r\n`);
      buffer = '';
    } else if (char === '\x03') buffer = '';
    else buffer += char;
  }
}
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const marker = pasting ? END : START;
    const at = pending.indexOf(marker);
    if (at === -1) {
      const esc = pending.lastIndexOf('\x1b');
      const keep = esc !== -1 && marker.startsWith(pending.slice(esc)) ? pending.slice(esc) : '';
      const ready = pending.slice(0, pending.length - keep.length);
      if (pasting) buffer += ready;
      else typed(ready);
      pending = keep;
      return;
    }
    const before = pending.slice(0, at);
    pending = pending.slice(at + marker.length);
    if (pasting) buffer += before;
    else typed(before);
    pasting = !pasting;
  }
});
process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(0));
