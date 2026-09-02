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
//   exit <код>        — завершается с указанным кодом
//
// Аргументы командной строки печатаются при старте — так тест проверяет,
// что до бинаря доехали `--resume <id>` и прочее.

process.stdout.write(`stub готов args=${JSON.stringify(process.argv.slice(2))}\r\n`);
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

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');

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
    case 'exit':
      process.exit(Number(argument) || 0);
      break;
    default:
      process.stdout.write(`неизвестная команда: ${command}\r\n`);
  }
}
