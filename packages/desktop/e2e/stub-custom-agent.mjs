#!/usr/bin/env node
// Изолированный Claude Code для E2E своих провайдеров (спека 2026-10-17, 6) и аккаунтов подписки (спека 2026-10-21, 9):
// только stdin и HTTP-хуки на loopback. В файл признаков пишет булевы признаки и пути, а не ключ, заголовки или argv.
// Транскрипт — в $CLAUDE_CONFIG_DIR/projects (у обычной сессии без переменной — в $HOME/.claude/projects, как у
// настоящего Claude Code). Подкоманды `auth status|login|logout` — вход аккаунта, см. ниже.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

// 2.1.304 — не ниже минимальной версии аккаунтов подписки (ACCOUNT_MIN_VERSION_CLAUDE, спека подписок 9.1).
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.304 (Claude Code)\n');
  process.exit(0);
}

// `claude auth status --json | login --claudeai | logout` (спека подписок 5.5, 9.1). Состояние входа — файл
// stub-auth.json в $CLAUDE_CONFIG_DIR: как у настоящего CLI, вход живёт в самой папке аккаунта. Без CLAUDE_CONFIG_DIR
// заглушка ничего не пишет и не читает: настоящий ~ она не трогает никогда. STUB_AUTH_LOG=<файл> — по строке JSON на вызов.
if (process.argv[2] === 'auth') {
  const sub = process.argv[3];
  const configDir = process.env.CLAUDE_CONFIG_DIR || null;
  const authFile = configDir === null ? null : path.join(configDir, 'stub-auth.json');
  const log = (data) => {
    if (!process.env.STUB_AUTH_LOG) return;
    // Имена унаследованных ключей и токена, не значения: вход аккаунта идёт в чистом окружении (спека подписок 5.3).
    const inherited = (prefix) => Object.keys(process.env).filter((name) => name.toUpperCase().startsWith(prefix));
    appendFileSync(process.env.STUB_AUTH_LOG, `${JSON.stringify({
      command: sub, configDir, anthropicVars: inherited('ANTHROPIC_'), oauthVars: inherited('CLAUDE_CODE_OAUTH'),
      managedVarSet: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== undefined, ...data,
    })}\n`);
  };
  const readAuth = () => {
    try { return authFile === null ? null : readFileSync(authFile, 'utf8').trim(); }
    catch { return null; }
  };
  if (sub === 'status') {
    const state = readAuth();
    log({ loggedIn: state !== null });
    // Не вошедший CLI отвечает JSON с loggedIn: false и ненулевым кодом (спека 5.5): решает поле, а не код.
    process.stdout.write(`${state ?? '{"loggedIn":false,"authMethod":"none"}'}\n`);
    process.exit(state === null ? 1 : 0);
  }
  if (sub === 'login') {
    if (authFile === null) { process.stderr.write('stub: no CLAUDE_CONFIG_DIR\n'); process.exit(1); }
    // Вывод настоящего CLI (спека 9.1); терминал входа — PTY, строки кончаются \r\n.
    process.stdout.write('Opening browser to sign in…\r\n');
    process.stdout.write("If the browser didn't open, visit: https://stub.invalid/login\r\n");
    process.stdout.write('Paste code here if prompted > ');
    // Строка со stdin или тайм-аут (STUB_LOGIN_WAIT_MS, по умолчанию секунда) — что раньше: вход без набранного кода тоже проходит.
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Number(process.env.STUB_LOGIN_WAIT_MS ?? 1000));
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk) => { clearTimeout(timer); resolve(String(chunk).replace(/[\r\n]+$/, '')); });
    });
    writeFileSync(authFile, `${JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: process.env.STUB_AUTH_EMAIL || 'second@example.test',
      orgName: 'Stub org', subscriptionType: 'max', configDirectory: configDir,
    })}\n`);
    log({ code });
    process.stdout.write('\r\nLogin successful.\r\n');
    process.exit(0);
  }
  if (sub === 'logout') {
    if (authFile !== null) rmSync(authFile, { force: true });
    log({});
    process.stdout.write('Successfully logged out from your Anthropic account.\n');
    process.exit(0);
  }
  process.stderr.write(`stub: unknown auth command ${String(sub)}\n`);
  process.exit(2);
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
  // Имена, не значения: аккаунту подписки не должно достаться ничего из ANTHROPIC_* и CLAUDE_CODE_OAUTH_* (спека подписок 5.3).
  managedVarSet: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== undefined,
  anthropicVars: Object.keys(process.env).filter((name) => name.toUpperCase().startsWith('ANTHROPIC_')),
  oauthVars: Object.keys(process.env).filter((name) => name.toUpperCase().startsWith('CLAUDE_CODE_OAUTH')),
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

// `STUB_MCP <инструмент> <json>` в терминале — вызов инструмента настоящего `parley-mcp`, как делает модель (то же, что в
// stub-echo-agent.mjs): сервер запускается по `--mcp-config`, результат каждого вызова — строкой JSON в STUB_MCP_LOG.
// Нужен, чтобы `get_map` из сессии `claude` показал строки аккаунтов с лимитами от хоста (спека подписок 5.8).
let mcpReady = null;
let mcpQueue = Promise.resolve();
function startMcp() {
  const file = valueOf('--mcp-config');
  if (file === undefined) throw new Error('нет --mcp-config: харнесс не передал конфиг MCP');
  const server = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.parley;
  if (server === undefined) throw new Error('в конфиге MCP нет сервера parley');
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  process.on('exit', () => child.kill());
  const waiting = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const wait = waiting.get(message.id);
    if (wait === undefined) return;
    waiting.delete(message.id);
    if (message.error !== undefined) wait.reject(new Error(message.error.message));
    else wait.resolve(message.result);
  });
  child.on('exit', () => {
    for (const wait of waiting.values()) wait.reject(new Error('parley-mcp завершился'));
    waiting.clear();
    mcpReady = null;
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });
  return request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stub-custom-agent', version: '0.0.0' } }).then(() => {
    send({ method: 'notifications/initialized' });
    return request;
  });
}
async function callMcp(line) {
  const space = line.indexOf(' ');
  const tool = space === -1 ? line : line.slice(0, space);
  let entry;
  try {
    mcpReady ??= startMcp();
    const request = await mcpReady;
    const result = await request('tools/call', { name: tool, arguments: space === -1 ? {} : JSON.parse(line.slice(space + 1)) });
    let text = (result.content ?? []).map((part) => part.text ?? '').join('');
    try { text = JSON.stringify(JSON.parse(text)); } catch { /* не JSON (текст ошибки) - как есть */ }
    entry = { tool, isError: result.isError === true, text };
  } catch (error) {
    entry = { tool, isError: true, text: error.message };
  }
  record(process.env.STUB_MCP_LOG, { session: process.env.PARLEY_SESSION_ID, ...entry });
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
      else if (buffer.includes('STUB_MCP ')) {
        const command = buffer.slice(buffer.indexOf('STUB_MCP ') + 'STUB_MCP '.length);
        mcpQueue = mcpQueue.then(() => callMcp(command));
      } else if (buffer) process.stdout.write(`echo: ${buffer}\r\n`);
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
