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

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Переменная окружения по ключу без префикса: `PARLEY_<ключ>`, а не задана — прежняя `HARNAS_<ключ>`.
 * Заглушки понимают оба имени, как сам продукт (R3).
 */
const fromEnv = (key) => process.env[`PARLEY_${key}`] ?? process.env[`HARNAS_${key}`];

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

// Настоящий MCP-сервер харнесса (кусок 8 «Organic»): строка `STUB_MCP <инструмент> <json-аргументы>` в терминале —
// вызов инструмента `parley-mcp` так, как его делает модель. Сервер запускается ровно как Claude Code запускает его
// по конфигу работы: `--mcp-config <файл>` из argv, команда, аргументы и окружение сервера `harnas` из файла поверх
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
  const server = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.harnas;
  if (server === undefined) throw new Error('в конфиге MCP нет сервера harnas');
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

function typed(text) {
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      // Команда выхода (раунд fix-host-resync): E2E завершает свой stub сам, без сигнала чужим
      // процессам и без поиска pid по всей машине.
      if (buffer === 'STUB_EXIT') process.exit(0);
      // Вызов инструмента настоящего parley-mcp (см. выше); эхо строки при этом не печатается. Ищется не с начала
      // строки: перед ней в буфере мог оказаться чужой набор (указатель будильника хоста).
      const mcpCall = buffer.indexOf('STUB_MCP ');
      if (mcpCall !== -1) {
        const command = buffer.slice(mcpCall + 'STUB_MCP '.length);
        mcpQueue = mcpQueue.then(() => callMcp(command));
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
