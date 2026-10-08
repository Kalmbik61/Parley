#!/usr/bin/env node
// Управляемая заглушка вместо настоящего `claude`/`codex` для тестов
// PTY-менеджера хоста (план, кусок 1.6). Настоящий бинарь в автотестах не
// запускается никогда — недетерминизм и лимиты подписки («Правила проверки»
// плана этапа 1).
//
// Базовое поведение: печатает `STUB READY`, на каждую введённую строку
// отвечает `echo: <строка>`. Остальное — режимы через переменные окружения:
//
//   STUB_HOOKS=1              — вместе с PARLEY_WORK_DIR/PARLEY_SESSION_ID (или прежними HARNAS_*)
//                                пишет в events/<id>.jsonl SessionStart при
//                                старте и UserPromptSubmit/Stop вокруг ответа
//                                на каждую строку (как это делает хук Claude
//                                Code, дизайн TUI v2, 4.2)
//   STUB_READY_HOOK=1          — при старте пишет в журнал одно нейтральное
//                                событие `StubReady`: состояния оно не меняет,
//                                но хост видит, что хуки процесса доходят
//                                (fix-final-b: без единого хука с запуска
//                                pty.send и будильник в сессию не печатают)
//   STUB_TURN_MS=<n>           — ход длится n мс между UserPromptSubmit и Stop
//   STUB_ARGS_FILE=<путь>      — при старте пишет туда JSON
//                                { argv, cwd, env: { PARLEY_WORK_DIR, PARLEY_SESSION_ID,
//                                HARNAS_WORK_DIR, HARNAS_SESSION_ID, CLAUDE_CODE_SESSION_ID,
//                                PARLEY_HOOK_TOKEN, PARLEY_HOOK_URL } }
//   STUB_FLOOD_MB=<n>          — при старте печатает n МБ строк (тест
//                                пересинхронизации при медленном клиенте)
//   STUB_IGNORE_SIGHUP=1       — не завершается по SIGHUP (хост должен
//                                добить SIGKILL по истечении grace)
//   STUB_EXIT_AFTER_MS=<n>     — выходит с кодом 3 через n мс
//   STUB_PROMPT_FROM_ARGV=1    — последний элемент argv считается введённой
//                                строкой, обрабатывается как строка со stdin
//
// На SIGWINCH печатает `SIZE <cols> <rows>` — так тест видит, что resize
// PTY реально меняет размер терминала гостя, а не только буфера хоста.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Явный импорт вместо глобала: конфиг eslint для .mjs знает только `process`
// и `console` (packages/core/test/stub-summarizer.mjs решает так же).
import { setTimeout } from 'node:timers';

/**
 * Переменная окружения по ключу без префикса: `PARLEY_<ключ>`, а не задана — прежняя `HARNAS_<ключ>`.
 * Заглушки понимают оба имени, как сам продукт (R3).
 */
const fromEnv = (key) => process.env[`PARLEY_${key}`] ?? process.env[`HARNAS_${key}`];

const HOOKS = process.env.STUB_HOOKS === '1';
const TURN_MS = Number(process.env.STUB_TURN_MS ?? '0');

/** Путь к журналу хуков текущей сессии — `null`, если окружение не задано. */
function eventsFile() {
  const dir = fromEnv('WORK_DIR');
  const sessionId = fromEnv('SESSION_ID');
  if (dir === undefined || sessionId === undefined) return null;
  return path.join(dir, 'events', `${sessionId}.jsonl`);
}

function writeHookEvent(name) {
  const file = eventsFile();
  if (file === null) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ hook_event_name: name })}\n`);
}

/** Одна введённая строка — своя или из STUB_PROMPT_FROM_ARGV. */
function handleLine(line) {
  if (HOOKS) writeHookEvent('UserPromptSubmit');

  const respond = () => {
    process.stdout.write(`echo: ${line}\r\n`);
    if (HOOKS) writeHookEvent('Stop');
  };

  if (TURN_MS > 0) setTimeout(respond, TURN_MS);
  else respond();
}

if (HOOKS) writeHookEvent('SessionStart');
if (process.env.STUB_READY_HOOK === '1') writeHookEvent('StubReady');
process.stdout.write('STUB READY\r\n');

if (process.env.STUB_ARGS_FILE !== undefined) {
  writeFileSync(
    process.env.STUB_ARGS_FILE,
    JSON.stringify({
      argv: process.argv,
      cwd: process.cwd(),
      env: {
        PARLEY_WORK_DIR: process.env.PARLEY_WORK_DIR ?? null,
        PARLEY_SESSION_ID: process.env.PARLEY_SESSION_ID ?? null,
        HARNAS_WORK_DIR: process.env.HARNAS_WORK_DIR ?? null,
        HARNAS_SESSION_ID: process.env.HARNAS_SESSION_ID ?? null,
        CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        PARLEY_HOOK_TOKEN: process.env.PARLEY_HOOK_TOKEN ?? null,
        PARLEY_HOOK_URL: process.env.PARLEY_HOOK_URL ?? null,
      },
    }),
  );
}

if (process.env.STUB_FLOOD_MB !== undefined) {
  const totalBytes = Number(process.env.STUB_FLOOD_MB) * 1024 * 1024;
  const line = `${'flood'.padEnd(76, '.')}\r\n`;
  // Пишем крупными пачками, а не по строке: на 20 МБ построчная запись —
  // сотни тысяч syscall и заметно замедляет тест без всякой пользы для него.
  const batch = line.repeat(1000);
  let written = 0;
  while (written < totalBytes) {
    process.stdout.write(batch);
    written += batch.length;
  }
  // Отдельная метка конца потока: тест ждёт именно её, а не первую попавшуюся
  // строку — иначе он снимет снимок посреди ещё льющихся мегабайт.
  process.stdout.write('FLOOD DONE\r\n');
}

if (process.env.STUB_IGNORE_SIGHUP === '1') {
  // Пустой обработчик вместо действия по умолчанию (завершение процесса) —
  // так тест проверяет добивание SIGKILL по истечении grace.
  process.on('SIGHUP', () => {});
}

if (process.env.STUB_EXIT_AFTER_MS !== undefined) {
  setTimeout(() => process.exit(3), Number(process.env.STUB_EXIT_AFTER_MS));
}

process.on('SIGWINCH', () => {
  process.stdout.write(`SIZE ${process.stdout.columns} ${process.stdout.rows}\r\n`);
});

if (process.env.STUB_PROMPT_FROM_ARGV === '1') {
  const line = process.argv[process.argv.length - 1];
  if (line !== undefined) handleLine(line);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at = buffer.search(/[\r\n]/);
  while (at !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handleLine(line);
    at = buffer.search(/[\r\n]/);
  }
});
