#!/usr/bin/env node
// scrub-export.mjs — вычищает приватное из вывода claude-export.mjs перед коммитом
// в docs/schema/. Схема (какие поля, каких типов, как часто) сохраняется полностью,
// содержимое — нет.
//
//   node tools/scrub-export.mjs claude-export docs/schema

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const [SRC = 'claude-export', DST = 'docs/schema'] = process.argv.slice(2);
const HOME = homedir();
const USER = path.basename(HOME);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const scrubPath = (s) => s.split(HOME).join(`/Users/<user>`).split(`-Users-${USER}-`).join('-Users-<user>-');

// Поля, чьи значения — свободный текст пользователя или чужие идентификаторы.
const SECRET_FIELDS = new Set([
  'ownerAccountUuid', 'ownerOrganizationUuid', 'lastPrompt', 'result',
  'customTitle', 'aiTitle', 'content', 'summary', 'text', 'firstPrompt',
  'classifierMetaLines', 'description', 'apiRefusalExplanation',
]);

// Сэмпл оставляем, только если он похож на структурный токен: короткий и без пробелов.
function scrubSample(field, value) {
  if (typeof value !== 'string') return value;
  const leaf = field.split('.').pop();
  if (SECRET_FIELDS.has(leaf)) return '<redacted>';
  const s = scrubPath(value).replace(UUID, '<uuid>');
  if (s.length > 40 || /\s/.test(s)) return `<redacted:string len=${value.length}>`;
  return s;
}

// Мапы с динамическими ключами (пути файлов, id) раздувают отчёт и тащат приватное
// в ИМЕНА полей — схлопываем такой сегмент ключа в <key>.
const scrubFieldName = (name) =>
  name.split('.').map((seg) => (seg.includes('/') ? '<key>' : seg)).join('.');

const report = JSON.parse(await readFile(path.join(SRC, 'schema-report.json'), 'utf8'));
for (const type of Object.values(report)) {
  const fields = {};
  for (const [name, f] of Object.entries(type.fields)) {
    const key = scrubFieldName(name);
    f.sample = scrubSample(name, f.sample);
    if (fields[key]) fields[key].seen += f.seen;
    else fields[key] = f;
  }
  type.fields = fields;
}

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
