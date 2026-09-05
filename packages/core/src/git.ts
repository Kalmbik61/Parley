/**
 * Ветка проекта из `.git/HEAD` (дизайн TUI v2, 2.1).
 *
 * У работы, чьи сессии ещё не оставили лога провайдера, ветку взять неоткуда:
 * в карте её нет. Здесь читается только сам файл — ни `git`, ни рабочее дерево
 * не запускаются и не обходятся.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Отсоединённая голова: столько знаков хэша показывает и сам git. */
const SHORT_HASH = 7;

/** `ref: refs/heads/<ветка>` — символическая ссылка на ветку. */
const SYMBOLIC = /^ref:\s*(?:refs\/heads\/)?(.+)$/;

/**
 * Имя ветки проекта; `null` — файла нет (не репозиторий) или он пуст.
 * Отсоединённая голова даёт короткий хэш — второй строке работы важно
 * показать хоть что-то узнаваемое.
 */
export async function gitBranch(projectPath: string): Promise<string | null> {
  let head = '';
  try {
    head = (await readFile(path.join(projectPath, '.git', 'HEAD'), 'utf8')).trim();
  } catch {
    return null;
  }
  if (head === '') return null;
  const symbolic = SYMBOLIC.exec(head);
  return symbolic === null ? head.slice(0, SHORT_HASH) : (symbolic[1] ?? null);
}
