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
