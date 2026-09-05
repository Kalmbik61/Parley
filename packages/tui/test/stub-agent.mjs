#!/usr/bin/env node
// Заглушка вместо настоящего `claude` для тестов PTY.
// Реальный бинарь в автотестах не запускается никогда: лимиты подписки и
// недетерминизм (specs/pty.md).
//
// Понимает команды на stdin, по строке на команду:
//   echo <текст>      — печатает текст
//   size              — печатает текущие cols x rows
//   alt               — уходит в alt-screen и печатает там
//   mouse on|off      — включает/выключает отслеживание мыши (как это делает TUI)
//   color             — печатает цветной текст
//   event <json>      — дописывает строку в $HARNAS_WORK_DIR/events/$HARNAS_SESSION_ID.jsonl,
//                       как это делает хук Claude Code (дизайн TUI v2, 4.2)
//   event <сессия> <json> — то же, но в журнал другой сессии той же работы:
//                       stdin достаётся только подключённой сессии, а события
//                       соседней тесту тоже нужны от живого процесса
//   exit <код>        — завершается с указанным кодом
//
// Пришедшие на stdin события мыши в SGR-кодировании stub не копит в буфере
// команд, а печатает строкой `mouse-event <кнопка> <колонка> <строка>` — так
// тест видит, что клик в панели доехал до гостя с пересчитанной колонкой (3.3).
//
// Аргументы командной строки печатаются при старте — так тест проверяет,
// что до бинаря доехали `--resume <id>` и прочее.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

process.stdout.write(`stub готов args=${JSON.stringify(process.argv.slice(2))}\r\n`);
// Одни только флаги: их список короткий и целиком помещается в узкую панель,
// тогда как полные аргументы с путями терминал переносит на несколько строк.
process.stdout.write(
  `flags=${process.argv
    .slice(2)
    .filter((argument) => argument.startsWith('--'))
    .join(',')}\r\n`,
);
process.stdout.write(`cwd=${process.cwd()}\r\n`);
// Окружение сессии работы: по нему тест видит, что до процесса доехали
// HARNAS_WORK_DIR и HARNAS_SESSION_ID. Печатаем коротко — панель узкая.
process.stdout.write(
  `harnas=${process.env.HARNAS_SESSION_ID ?? '-'}@${(process.env.HARNAS_WORK_DIR ?? '-').split('/').pop()}\r\n`,
);

process.on('SIGHUP', () => process.exit(129));
process.stdout.on('resize', () => {
  process.stdout.write(`resize ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});

let buffer = '';

/** `ESC [ < кнопка ; колонка ; строка M|m` — то, что шлёт харнесс при mouseCapture. */
const ESC = String.fromCharCode(27);
const SGR_MOUSE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  buffer = buffer.replace(SGR_MOUSE, (_match, button, x, y, kind) => {
    process.stdout.write(`mouse-event ${button} ${x} ${y} ${kind}\r\n`);
    return '';
  });

  let at = buffer.search(/[\r\n]/);
  while (at !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    handle(line);
    at = buffer.search(/[\r\n]/);
  }
});

function handle(line) {
  if (line === '') return;
  const [command, ...rest] = line.split(' ');
  const argument = rest.join(' ');

  switch (command) {
    case 'echo':
      process.stdout.write(`${argument}\r\n`);
      break;
    case 'size':
      process.stdout.write(`size ${process.stdout.columns}x${process.stdout.rows}\r\n`);
      break;
    case 'alt':
      // Переход в альтернативный экран, как это делает полноэкранный TUI.
      process.stdout.write('\u001B[?1049h\u001B[H\u001B[2Jальтернативный экран\r\n');
      break;
    case 'mouse':
      process.stdout.write(
        argument === 'on'
          ? '\u001B[?1002h\u001B[?1006h\u001B[?2004h'
          : '\u001B[?1002l\u001B[?1006l\u001B[?2004l',
      );
      process.stdout.write(`mouse ${argument}\r\n`);
      break;
    case 'color':
      process.stdout.write('\u001B[31mкрасный\u001B[0m обычный\r\n');
      break;
    case 'event':
      writeEvent(argument);
      break;
    case 'exit':
      process.exit(Number(argument) || 0);
      break;
    default:
      process.stdout.write(`неизвестная команда: ${command}\r\n`);
  }
}

/**
 * Хук Claude Code одной командой дописывает stdin-JSON в журнал сессии
 * (`cat >> "$HARNAS_WORK_DIR/events/$HARNAS_SESSION_ID.jsonl"`). Настоящий
 * бинарь в тестах не запускается, поэтому ту же строку пишет stub.
 */
function writeEvent(argument) {
  const dir = process.env.HARNAS_WORK_DIR;
  // `event <сессия> <json>`: имя журнала перед самим событием.
  const cut = argument.startsWith('{') ? -1 : argument.indexOf(' ');
  const session = cut === -1 ? process.env.HARNAS_SESSION_ID : argument.slice(0, cut);
  const json = cut === -1 ? argument : argument.slice(cut + 1);
  if (dir === undefined || session === undefined) {
    process.stdout.write('event: нет HARNAS_WORK_DIR или HARNAS_SESSION_ID\r\n');
    return;
  }
  const events = path.join(dir, 'events');
  mkdirSync(events, { recursive: true });
  appendFileSync(path.join(events, `${session}.jsonl`), `${json}\n`);
  process.stdout.write('event записан\r\n');
}
