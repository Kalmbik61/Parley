#!/usr/bin/env node
// scrub-export.mjs — вычищает приватное из вывода claude-export.mjs перед коммитом
// в docs/schema/. Схема (какие поля, каких типов, как часто) сохраняется полностью,
// содержимое — нет.
//
//   node tools/scrub-export.mjs claude-export docs/schema

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { scrubPath, scrubReport } from './lib/scrub.mjs';

const [SRC = 'claude-export', DST = 'docs/schema'] = process.argv.slice(2);

const report = JSON.parse(await readFile(path.join(SRC, 'schema-report.json'), 'utf8'));
scrubReport(report);

const index = JSON.parse(await readFile(path.join(SRC, 'index.json'), 'utf8'));
for (const s of index) {
  if (s.file) s.file = scrubPath(s.file);
  if (s.cwd) s.cwd = scrubPath(s.cwd);
  if (s.project) s.project = scrubPath(s.project);
  if (s.summary) s.summary = '<redacted>';
}

await mkdir(DST, { recursive: true });
await writeFile(path.join(DST, 'schema-report.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(DST, 'index.json'), JSON.stringify(index, null, 2));
console.log(`Записано: ${path.join(DST, 'schema-report.json')}, ${path.join(DST, 'index.json')}`);
