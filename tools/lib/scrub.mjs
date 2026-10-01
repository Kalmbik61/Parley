// Очистка отчётов по схеме перед коммитом в docs/schema/.
// Сам сбор отчёта живёт в @parley/core (schema-report.ts) — здесь только вычистка.
// Структура (какие поля, каких типов, как часто) сохраняется полностью,
// содержимое — нет. Используется и scrub-export.mjs, и observe-schema.mjs.

import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();
const USER = path.basename(HOME);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const scrubPath = (value) =>
  value.split(HOME).join('/Users/<user>').split(`-Users-${USER}-`).join('-Users-<user>-');

// Поля, чьи значения — свободный текст пользователя или чужие идентификаторы.
const SECRET_FIELDS = new Set([
  'ownerAccountUuid',
  'ownerOrganizationUuid',
  'lastPrompt',
  'result',
  'customTitle',
  'aiTitle',
  'content',
  'summary',
  'text',
  'firstPrompt',
  'classifierMetaLines',
  'description',
  'apiRefusalExplanation',
  'instructions',
  'cwd',
  'command',
  'output',
  'arguments',
  'message',
  'repository_url',
  'user_instructions',
  'encrypted_content',
  'input',
]);

/** Сэмпл оставляем, только если он похож на структурный токен: короткий и без пробелов. */
export function scrubSample(field, value) {
  if (typeof value !== 'string') return value;
  const leaf = field.split('.').pop();
  if (SECRET_FIELDS.has(leaf)) return '<redacted>';
  const cleaned = scrubPath(value).replace(UUID, '<uuid>');
  if (cleaned.length > 40 || /\s/.test(cleaned)) return `<redacted:string len=${value.length}>`;
  return cleaned;
}

/**
 * Мапы с динамическими ключами (пути файлов, id) раздувают отчёт и тащат приватное
 * в ИМЕНА полей — схлопываем такой сегмент ключа.
 */
export const scrubFieldName = (name) =>
  name
    .split('.')
    .map((segment) => (segment.includes('/') ? '<key>' : segment))
    .join('.');

/** Чистит отчёт по схеме на месте и возвращает его же. */
export function scrubReport(report) {
  for (const type of Object.values(report)) {
    const fields = {};
    for (const [name, field] of Object.entries(type.fields)) {
      const key = scrubFieldName(name);
      field.sample = scrubSample(name, field.sample);
      if (fields[key]) fields[key].seen += field.seen;
      else fields[key] = field;
    }
    type.fields = fields;
  }
  return report;
}
