import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Заготовленные запросы по дескриптору базы: дескриптор меняется вместе с домом, а `prepare` на горячем пути не нужен. */
const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Запрос по тексту: один раз `prepare` на дескриптор, дальше из кэша (спека хранилища 6.9). */
export function sql(db: DatabaseSync, text: string): StatementSync {
  let byText = prepared.get(db);
  if (byText === undefined) {
    byText = new Map();
    prepared.set(db, byText);
  }
  let statement = byText.get(text);
  if (statement === undefined) {
    statement = db.prepare(text);
    byText.set(text, statement);
  }
  return statement;
}
