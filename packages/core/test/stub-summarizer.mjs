#!/usr/bin/env node
// Заглушка вместо стокового `claude -p` для тестов дозаказа резюме.
// Настоящий агент в автотестах не запускается никогда (спецификация
// координации, раздел 9): лимиты подписки и недетерминизм.
//
// Управляется переменными окружения (прежние `HARNAS_STUB_*` понимает тоже):
//   PARLEY_STUB_PROMPT   — файл, куда записать полученные аргументы (JSON)
//   PARLEY_STUB_SUMMARY  — что напечатать в stdout вместо резюме
//   PARLEY_STUB_FAIL     — завершиться с ошибкой и текстом в stderr
//   PARLEY_STUB_HANG     — не отвечать вовсе (проверка таймаута)
//   PARLEY_STUB_ENV      — имена переменных через запятую: вместо резюме
//                          напечатать их строками `env <имя>=<значение>`
//                          (`-` — переменной нет)

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Переменная окружения по ключу без префикса: `PARLEY_<ключ>`, а не задана — прежняя `HARNAS_<ключ>`.
 * Заглушки понимают оба имени, как сам продукт (R3). Пустая строка остаётся значением, как у
 * прежнего прямого чтения `process.env`.
 */
const fromEnv = (key) => process.env[`PARLEY_${key}`] ?? process.env[`HARNAS_${key}`];

const args = process.argv.slice(2);
const file = fromEnv('STUB_PROMPT');
if (file) writeFileSync(file, JSON.stringify(args), 'utf8');

if (fromEnv('STUB_FAIL')) {
  process.stderr.write('суммаризатор недоступен\n');
  process.exit(2);
}

if (fromEnv('STUB_HANG')) {
  // Молчим, пока вызывающий не оборвёт нас по таймауту.
  await sleep(60_000);
} else if (fromEnv('STUB_ENV')) {
  const names = fromEnv('STUB_ENV').split(',');
  process.stdout.write(
    `${names.map((name) => `env ${name}=${process.env[name] ?? '-'}`).join('\n')}\n`,
  );
} else {
  process.stdout.write(`${fromEnv('STUB_SUMMARY') ?? 'Сессия завершена.'}\n`);
}
