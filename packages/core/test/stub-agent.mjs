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
//   deaf              — перестаёт слушать SIGHUP: так проверяется добивание SIGKILL
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
// что до бинаря доехали `--resume <id>` и прочее. Длинные значения при этом
// урезаются: системная вставка гида (`--append-system-prompt`) — это десяток
// строк, и напечатанная целиком она вытеснила бы с узкой панели весь экран
// гостя. Uuid сессии в 36 знаков помещается целиком.
//
// `--version` stub отвечает и выходит: перед запуском с флагом канала харнесс
// пробует версию (разговор агентов, 4.4). `HARNAS_STUB_VERSION` подменяет
// ответ — так проверяется отказ от push на старой сборке.
//
// `HARNAS_STUB_ENV` — имена переменных через запятую: stub печатает их после
// баннера строками `env <имя>=<значение>`, `-` — переменной нет. Так тест видит,
// какое окружение доехало до агента. Без переменной баннер прежний: лишняя
// строка вытеснила бы его начало с узкой панели.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.HARNAS_STUB_VERSION ?? '2.1.276 (Claude Code)'}\n`);
  process.exit(0);
}

const short = (value) => {
  const line = value.replace(/\s+/g, ' ');
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

process.stdout.write(`stub готов args=${JSON.stringify(process.argv.slice(2).map(short))}\r\n`);
// Одни только флаги: их список короткий и целиком помещается в узкую панель,
// тогда как полные аргументы с путями терминал переносит на несколько строк.
process.stdout.write(
  `flags=${process.argv
    .slice(2)
    .filter((argument) => argument.startsWith('--'))
    .join(',')}\r\n`,
);
// Значение флага канала отдельной короткой строкой: сам флаг длиннее панели и
// в кадре переносится, а тесту нужно видеть, дошёл ли звонок (4.4).
const channelAt = process.argv.indexOf('--dangerously-load-development-channels');
process.stdout.write(`channel=${channelAt === -1 ? '-' : process.argv[channelAt + 1]}\r\n`);
// Роль тем же способом: в `args=` имя тонет среди урезанных путей, а тесту
// нужно видеть, под каким агентом стартовала сессия (5.1).
const agentAt = process.argv.indexOf('--agent');
process.stdout.write(`agent=${agentAt === -1 ? '-' : process.argv[agentAt + 1]}\r\n`);
process.stdout.write(`cwd=${process.cwd()}\r\n`);
// Окружение сессии работы: по нему тест видит, что до процесса доехали
// HARNAS_WORK_DIR и HARNAS_SESSION_ID. Печатаем коротко — панель узкая.
process.stdout.write(
  `parley=${process.env.HARNAS_SESSION_ID ?? '-'}@${(process.env.HARNAS_WORK_DIR ?? '-').split('/').pop()}\r\n`,
);
for (const name of (process.env.HARNAS_STUB_ENV ?? '').split(',').filter(Boolean)) {
  process.stdout.write(`env ${name}=${process.env[name] ?? '-'}\r\n`);
}

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
    case 'deaf':
      // Мягкое завершение больше не действует: харнесс должен добить SIGKILL.
      process.removeAllListeners('SIGHUP');
      process.on('SIGHUP', () => {});
      process.stdout.write('deaf\r\n');
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
