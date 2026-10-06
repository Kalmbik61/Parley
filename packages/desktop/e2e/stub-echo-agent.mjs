#!/usr/bin/env node
// Заглушка вместо настоящего `claude` для E2E терминала (кусок 1.11 плана
// окна): настоящий агент в автотестах не запускается никогда (лимиты
// подписки, недетерминизм — «Правила проверки» плана этапа 1). Собственный
// stub, а не `packages/tui/test/stub-agent.mjs`: тот понимает команды вида
// `echo <текст>` построчно из заранее известного протокола TUI, а здесь
// нужен ровно тот минимум, что описан в приёмке этого куска — ввод `hello` и
// Enter дают на экране `echo: hello`.
//
// Копит символы до `\r`/`\n` и печатает `echo: <строка>\r\n` — построчный
// эхо-отклик, которого ждёт `e2e/terminal.spec.ts`.

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Переменная окружения по ключу без префикса: `PARLEY_<ключ>`, а не задана — прежняя `HARNAS_<ключ>`.
 * Заглушки понимают оба имени, как сам продукт (R3).
 */
const fromEnv = (key) => process.env[`PARLEY_${key}`] ?? process.env[`HARNAS_${key}`];

// Проба версий хоста (`<команда> --version`, host/src/providers/versions.ts) — ответ как у настоящего
// Claude Code, не ниже порога ленты (FEED_MIN_VERSION): спек вида «Chat» включает пробу, чтобы вид
// был доступен. Выход сразу — ни хука, ни экрана.
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.286 (Claude Code)\n');
  process.exit(0);
}

// Хук при старте (fix-final-b): настоящий Claude Code в доверенной папке шлёт SessionStart, и
// хост узнаёт, что хуки процесса доходят; без единого хука с запуска pty.send отвечает blocked
// (вопрос доверия к папке хуков не шлёт). Нейтральное `StubReady` состояния не меняет — точка
// сессии остаётся прежней. STUB_NO_HOOKS=1 — сессия «на вопросе доверия»: хуков нет вовсе.
// Адрес журнала — из окружения процесса, как у команды хука (core/work/settings-file.ts).
if (process.env.STUB_NO_HOOKS !== '1' && fromEnv('WORK_DIR') !== undefined && fromEnv('SESSION_ID') !== undefined) {
  const events = path.join(fromEnv('WORK_DIR'), 'events');
  mkdirSync(events, { recursive: true });
  appendFileSync(path.join(events, `${fromEnv('SESSION_ID')}.jsonl`), `${JSON.stringify({ hook_event_name: 'StubReady' })}\n`);
}

process.stdout.write('stub-echo готов\r\n');

// События файлового журнала `<WORK_DIR>/events/<SESSION_ID>.jsonl`: настоящий Claude Code пишет их командным хуком
// (core/work/settings-file.ts, HOOK_EVENTS), и по ним хост считает активность (blocked, working, lastEventAt).
// Стаб, посылая событие строкой STUB_HOOK, дописывает в журнал и его — иначе хост событий не увидит.
const JOURNAL_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]);

/** Значение флага argv (`--settings <путь>`, `--session-id <id>`); нет флага — `undefined`. */
function argvValue(flag) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * HTTP-хук из файла `--settings` (вид «Chat», решение 1 плана 2026-10-01): адрес и заголовки, в которых
 * `$ИМЯ` из `allowedEnvVars` заменено значением из окружения процесса — так делает настоящий Claude Code.
 * Нет флага, файла или HTTP-хука — `null`: стаб ведёт себя как прежде, команда STUB_HOOK не распознаётся.
 */
function readHttpHook() {
  const file = argvValue('--settings');
  if (file === undefined) return null;
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'http' || typeof hook.url !== 'string') continue;
        const allowed = hook.allowedEnvVars ?? [];
        const substitute = (value) =>
          String(value).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => (allowed.includes(name) ? (process.env[name] ?? '') : whole));
        const headers = Object.fromEntries(Object.entries(hook.headers ?? {}).map(([name, value]) => [name, substitute(value)]));
        return { url: hook.url, headers };
      }
    }
  }
  return null;
}

const httpHook = readHttpHook();
/** `--session-id` — id сессии у Claude Code: приёмник хоста сверяет с ним `session_id` тела (иначе 404). */
const providerSessionId = argvValue('--session-id');

// Журнал запусков (STUB_LAUNCH_LOG; нормалайзер модели и effort 2026-10-06): флаги модели и effort каждого старта процесса
// сессии — E2E сверяет по нему перезапуск из меню чата (`sessions.setModel`: stop и resume с флагами из карты).
const launchLog = process.env.STUB_LAUNCH_LOG;
if (launchLog !== undefined && launchLog !== '') {
  appendFileSync(
    launchLog,
    `${JSON.stringify({ sessionId: fromEnv('SESSION_ID') ?? null, model: argvValue('--model') ?? null, effort: argvValue('--effort') ?? null, resume: argvValue('--resume') !== undefined })}\n`,
  );
}

/** Ответ хоста — в терминал (`HOOK<<json>>`) и, если задан `STUB_HOOK_LOG`, строкой в файл: в виде Chat терминала не видно. */
function reportHook(event, status, response) {
  process.stdout.write(`HOOK<<${JSON.stringify(response)}>>\r\n`);
  const log = process.env.STUB_HOOK_LOG;
  if (log !== undefined && log !== '') appendFileSync(log, `${JSON.stringify({ event, status, response })}\n`);
}

/**
 * Строка `STUB_HOOK <json>`: POST события на хост от имени сессии. Запрос не держит чтение stdin — удержанный
 * хук (PermissionRequest, вопрос агента) ждёт клика человека в окне, а стаб тем временем принимает дальнейшие строки.
 * Пустое тело ответа — `{}`. Ошибка сети, не-2xx и непонятный ответ — `{"error": …}`.
 */
function postHook(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    reportHook('unknown', 0, { error: `bad json: ${error.message}` });
    return;
  }
  const event = typeof body.hook_event_name === 'string' ? body.hook_event_name : 'unknown';
  if (body.session_id === undefined && providerSessionId !== undefined) body.session_id = providerSessionId;
  const payload = JSON.stringify(body);
  if (JOURNAL_EVENTS.has(event) && fromEnv('WORK_DIR') !== undefined && fromEnv('SESSION_ID') !== undefined) {
    const events = path.join(fromEnv('WORK_DIR'), 'events');
    mkdirSync(events, { recursive: true });
    appendFileSync(path.join(events, `${fromEnv('SESSION_ID')}.jsonl`), `${payload}\n`);
  }
  const request = http.request(
    httpHook.url,
    { method: 'POST', headers: { ...httpHook.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) return reportHook(event, status, { error: `HTTP ${status}` });
        try {
          reportHook(event, status, raw.trim() === '' ? {} : JSON.parse(raw));
        } catch (error) {
          reportHook(event, status, { error: `bad response: ${error.message}` });
        }
      });
    },
  );
  request.on('error', (error) => reportHook(event, 0, { error: error.message }));
  request.end(payload);
}

// Настоящий MCP-сервер харнесса (кусок 8 «Organic»): строка `STUB_MCP <инструмент> <json-аргументы>` в терминале —
// вызов инструмента `parley-mcp` так, как его делает модель. Сервер запускается ровно как Claude Code запускает его
// по конфигу работы: `--mcp-config <файл>` из argv, команда, аргументы и окружение сервера `parley` из файла поверх
// окружения процесса. Дальше JSON-RPC по stdio: `initialize`, `notifications/initialized`, `tools/call`. Так E2E
// проверяет решение ведущего целиком — от инструмента, у которого своя проверка «только ведущий», до карточки в окне.
// Результат печатается в терминал: `mcp: propose_decision -> {"proposalId":"p-01","rev":0}`, отказ инструмента —
// `mcp: propose_decision error: <текст>`. Строки выполняются по очереди.
let mcpReady = null;
let mcpQueue = Promise.resolve();

function startMcp() {
  const at = process.argv.indexOf('--mcp-config');
  const file = at === -1 ? undefined : process.argv[at + 1];
  if (file === undefined) throw new Error('нет --mcp-config: харнесс не передал конфиг MCP');
  const server = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.parley;
  if (server === undefined) throw new Error('в конфиге MCP нет сервера parley');
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // Процесс сервера не переживает заглушку: агент завершается — вместе с ним и его MCP-сервер.
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
    // Уведомления сервера (звонок канала) заглушке не нужны: у них нет id.
    const wait = pending.get(message.id);
    if (wait === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) wait.reject(new Error(message.error.message));
    else wait.resolve(message.result);
  });
  child.on('exit', () => {
    for (const wait of pending.values()) wait.reject(new Error('parley-mcp завершился'));
    pending.clear();
    mcpReady = null;
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  return request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stub-echo-agent', version: '0.0.0' } }).then(() => {
    send({ method: 'notifications/initialized' });
    return request;
  });
}

async function callMcp(line) {
  const space = line.indexOf(' ');
  const tool = space === -1 ? line : line.slice(0, space);
  try {
    const args = space === -1 ? {} : JSON.parse(line.slice(space + 1));
    mcpReady ??= startMcp();
    const request = await mcpReady;
    const result = await request('tools/call', { name: tool, arguments: args });
    let text = (result.content ?? []).map((part) => part.text ?? '').join('');
    // Ответ инструмента — отформатированный JSON: в одну строку, чтобы экран терминала читался и склеивался в тесте.
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch {
      // Не JSON (текст ошибки) — как есть.
    }
    process.stdout.write(`mcp: ${tool} ${result.isError === true ? 'error:' : '->'} ${text.replace(/\r?\n/g, '\r\n')}\r\n`);
  } catch (error) {
    process.stdout.write(`mcp: ${tool} failed: ${error.message}\r\n`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');

// Режим STUB_BRACKETED=1 (кусок 5.4): агент включает bracketed paste, как Claude и Codex, —
// тогда хост оборачивает `pty.send` в ESC[200~ … ESC[201~. Вставка печатается как
// `PASTE<<текст>>` и копится в строке; Enter — `echo: <строка>`, как без режима.
// Терминал — в сыром режиме: иначе строка дошла бы только после перевода строки, а маркеры
// вставки эхо tty показало бы как ^[[200~. Набранное эхо печатает сам stub.
const bracketed = process.env.STUB_BRACKETED === '1';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Ползунок `/effort` Claude Code (STUB_EFFORT_SLIDER=1; нормалайзер модели и effort 2026-10-06, спека 5.7). `/effort` и
// Enter открывают его нижней строкой экрана с «s for this session only»; ←/→ (CSI или SS3) двигают уровень с упором в
// low и max, `s` применяет его «только для сессии» и пишет подвал `<знак> <уровень> · /effort` той же нижней строкой,
// Esc закрывает без смены. Так E2E проверяет смену effort из меню чата (`sessions.setEffort`) по экрану, как у
// настоящего CLI. Нужен сырой режим tty — вместе с STUB_BRACKETED=1.
const effortSlider = process.env.STUB_EFFORT_SLIDER === '1';
const SLIDER_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SLIDER_MARKS = ['○', '◐', '●', '◉', '◈'];
/** Индекс уровня, пока ползунок открыт; `null` — закрыт. */
let slider = null;

/** Строка внизу экрана: подвал Claude Code живёт у нижнего края, а не под последним выводом. */
function bottomLine(text) {
  process.stdout.write(`\x1b[999;1H\x1b[2K${text}`);
}

function openSlider() {
  slider = 1;
  bottomLine('Effort: ←/→ to adjust · Enter to save as default · s for this session only · Esc to cancel');
}

/** Клавиша открытого ползунка в начале `head`; ответ — сколько знаков она заняла. */
function sliderKey(head) {
  if (head.startsWith('\x1b[D') || head.startsWith('\x1bOD')) {
    slider = Math.max(0, slider - 1);
    return 3;
  }
  if (head.startsWith('\x1b[C') || head.startsWith('\x1bOC')) {
    slider = Math.min(SLIDER_LEVELS.length - 1, slider + 1);
    return 3;
  }
  if (head.startsWith('s')) {
    bottomLine(`${SLIDER_MARKS[slider]} ${SLIDER_LEVELS[slider]} · /effort`);
    slider = null;
    return 1;
  }
  if (head.startsWith('\x1b')) {
    bottomLine('Effort unchanged');
    slider = null;
    return 1;
  }
  return 1;
}

function typed(text) {
  // По индексу, а не `for…of`: открытый ползунок `/effort` забирает клавишу целиком, а стрелка — три знака.
  const chars = Array.from(text);
  for (let at = 0; at < chars.length; at += 1) {
    if (slider !== null) {
      at += sliderKey(chars.slice(at, at + 3).join('')) - 1;
      continue;
    }
    const char = chars[at];
    if (char === '\r' || char === '\n') {
      // Команда выхода (раунд fix-host-resync): E2E завершает свой stub сам, без сигнала чужим
      // процессам и без поиска pid по всей машине.
      if (buffer === 'STUB_EXIT') process.exit(0);
      // Ползунок `/effort` (STUB_EFFORT_SLIDER=1): строка не эхом, а открытым ползунком, как у настоящего CLI.
      if (effortSlider && buffer.trim() === '/effort') {
        openSlider();
        buffer = '';
        continue;
      }
      // Вызов инструмента настоящего parley-mcp (см. выше); эхо строки при этом не печатается. Ищется не с начала
      // строки: перед ней в буфере мог оказаться чужой набор (указатель будильника хоста).
      const mcpCall = buffer.indexOf('STUB_MCP ');
      if (mcpCall !== -1) {
        const command = buffer.slice(mcpCall + 'STUB_MCP '.length);
        mcpQueue = mcpQueue.then(() => callMcp(command));
        buffer = '';
        continue;
      }
      // Событие хука на хост (см. postHook); эхо строки не печатается. Ищется так же, как STUB_MCP. Длинные тела
      // (сотни знаков) — в режиме STUB_BRACKETED=1: в обычном режиме строку держит канонический режим tty с пределом
      // в 1024 байта.
      const hookCall = buffer.indexOf('STUB_HOOK ');
      if (httpHook !== null && hookCall !== -1) {
        postHook(buffer.slice(hookCall + 'STUB_HOOK '.length));
        buffer = '';
        continue;
      }
      // В сыром режиме tty сам \n в \r\n не переводит: строка вставки может быть многострочной.
      process.stdout.write(bracketed ? `\r\necho: ${buffer.replace(/\r?\n/g, '\r\n')}\r\n` : `echo: ${buffer}\r\n`);
      buffer = '';
    } else {
      if (bracketed) process.stdout.write(char);
      buffer += char;
    }
  }
}

if (!bracketed) {
  process.stdin.on('data', typed);
} else {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?2004h');
  let pending = '';
  let pasting = false;
  let pasted = '';
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const marker = pasting ? PASTE_END : PASTE_START;
      const at = pending.indexOf(marker);
      if (at === -1) {
        // Хвост может быть началом маркера, разрезанного между кусками чтения, — ждём.
        const esc = pending.lastIndexOf('\x1b');
        const keep = esc !== -1 && marker.startsWith(pending.slice(esc)) ? pending.slice(esc) : '';
        const ready = pending.slice(0, pending.length - keep.length);
        if (pasting) pasted += ready;
        else typed(ready);
        pending = keep;
        return;
      }
      const before = pending.slice(0, at);
      pending = pending.slice(at + marker.length);
      if (pasting) {
        pasted += before;
        process.stdout.write(`PASTE<<${pasted.replace(/\r?\n/g, '\r\n')}>>`);
        buffer += pasted;
        pasted = '';
        pasting = false;
      } else {
        typed(before);
        pasting = true;
      }
    }
  });
}

process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(0));
