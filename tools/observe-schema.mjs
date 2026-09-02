#!/usr/bin/env node
// observe-schema.mjs — отчёт по схеме произвольного дерева .jsonl.
// Нужен для discovery форматов других провайдеров: читает только, ничего не пишет
// в исходный каталог, результат сразу вычищен от приватного.
//
// Сбор отчёта берётся из @harnas/core, поэтому сначала `pnpm build`.
//
//   node tools/observe-schema.mjs --root ~/.codex/sessions --out docs/schema/codex-schema-report.json

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSchemaReport } from '../packages/core/dist/schema-report.js';
import { scrubReport } from './lib/scrub.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const ROOT = path.resolve(String(flag('--root', '')));
const OUT = path.resolve(String(flag('--out', './schema-report.json')));

if (flag('--root') === null) {
  console.error('Укажи каталог: node tools/observe-schema.mjs --root <путь> --out <файл>');
  process.exit(1);
}

async function findJsonl(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Не читается ${dir}: ${error.message}`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findJsonl(full)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

const files = await findJsonl(ROOT);
if (files.length === 0) {
  console.error(`Файлов .jsonl в ${ROOT} не найдено.`);
  process.exit(1);
}

const { report, records, malformed } = await buildSchemaReport(files);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(scrubReport(report), null, 2));

const byCount = Object.entries(report).sort((a, b) => b[1].count - a[1].count);
console.log(`Файлов: ${files.length}, записей: ${records}, битых строк: ${malformed}`);
console.log('Типы записей:');
for (const [type, info] of byCount) console.log(`  ${String(info.count).padStart(7)} ${type}`);
console.log(`\n  ${OUT}`);
