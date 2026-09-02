#!/usr/bin/env node
// Заглушка вместо стокового `claude -p` для тестов дозаказа резюме.
// Настоящий агент в автотестах не запускается никогда (спецификация
// координации, раздел 9): лимиты подписки и недетерминизм.
//
// Управляется переменными окружения:
//   HARNAS_STUB_PROMPT   — файл, куда записать полученные аргументы (JSON)
//   HARNAS_STUB_SUMMARY  — что напечатать в stdout вместо резюме
//   HARNAS_STUB_FAIL     — завершиться с ошибкой и текстом в stderr
//   HARNAS_STUB_HANG     — не отвечать вовсе (проверка таймаута)

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const file = process.env.HARNAS_STUB_PROMPT;
if (file) writeFileSync(file, JSON.stringify(args), 'utf8');

if (process.env.HARNAS_STUB_FAIL) {
  process.stderr.write('суммаризатор недоступен\n');
  process.exit(2);
}

if (process.env.HARNAS_STUB_HANG) {
  // Молчим, пока вызывающий не оборвёт нас по таймауту.
  await sleep(60_000);
} else {
  process.stdout.write(`${process.env.HARNAS_STUB_SUMMARY ?? 'Сессия завершена.'}\n`);
}
