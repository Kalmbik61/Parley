/**
 * Точка входа скрипта строки статуса Claude Code: `node <этот файл>`, вход — JSON на stdin.
 * Логика — в `statusline.ts`; здесь только stdin, stdout и код выхода. Отдельным файлом, а не
 * проверкой «запущен ли модуль как главный»: путь до скрипта может идти через ссылку, и такая
 * проверка молча промолчала бы — строка статуса осталась бы пустой.
 *
 * Код выхода всегда 0 и строка всегда есть: Claude Code гасит строку статуса при ненулевом
 * коде и при пустом выводе.
 */

import { runStatusline } from './statusline.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Claude Code отменяет идущий вызов, когда его вытесняет новый (docs/en/statusline), — скрипт
// получает SIGTERM; Ctrl-C в терминале — SIGINT. Команда человека живёт в своей группе процессов и
// сигнала сама не получит: убиваем её здесь и выходим с кодом 0.
const cancel = new AbortController();
const onCancel = (): void => {
  cancel.abort();
  process.exit(0);
};
process.once('SIGTERM', onCancel);
process.once('SIGINT', onCancel);

let output: Buffer = Buffer.from('Claude\n', 'utf8');
try {
  output = await runStatusline(await readStdin(), { signal: cancel.signal });
} catch {
  // Остаётся запасная строка.
}

// Закрытый читатель (`EPIPE`) — не повод падать. Выход — после сброса stdout: `exit` сразу за
// `write` обрезал бы вывод на конвейере.
process.stdout.on('error', () => undefined);
process.stdout.write(output, () => process.exit(0));
