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

process.stdout.write('stub-echo готов\r\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      process.stdout.write(`echo: ${buffer}\r\n`);
      buffer = '';
    } else {
      buffer += char;
    }
  }
});

process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(0));
