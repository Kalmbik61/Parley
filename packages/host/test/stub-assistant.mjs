#!/usr/bin/env node
// Заглушка CLI помощника для тестов хода: печатает строки из STUB_LINES (JSON-массив) с паузой STUB_DELAY_MS,
// STUB_STDERR — в stderr, STUB_EXIT — код выхода, STUB_HANG=1 — не выходит, пока не убьют.

// Явный импорт вместо глобала: конфиг eslint для .mjs знает только `process` (как в stub-agent.mjs).
import { setInterval, setTimeout } from 'node:timers';
const lines = JSON.parse(process.env.STUB_LINES ?? '[]');
const delay = Number(process.env.STUB_DELAY_MS ?? '5');
for (const line of lines) {
  process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);
if (process.env.STUB_HANG === '1') setInterval(() => {}, 1000);
else process.exit(Number(process.env.STUB_EXIT ?? '0'));
