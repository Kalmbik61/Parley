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

/** `ref: refs/heads/<ветка>` — символическая ссылка на ветку; тег ветку не даёт. */
const SYMBOLIC = /^ref:\s*refs\/heads\/(.+)$/;

/** Отсоединённая голова — это хэш, а не что попало в файле. */
const HASH = /^[0-9a-f]{7,}$/i;

/** В worktree и в субмодуле `.git` — не каталог, а файл со ссылкой на него. */
const GITDIR = /^gitdir:\s*(.+)$/;

/**
 * Содержимое `HEAD` работы: обычный репозиторий держит его в каталоге `.git`,
 * а worktree и субмодуль — по ссылке `gitdir:` из одноимённого файла.
 */
async function readHead(projectPath: string): Promise<string | null> {
  const dotGit = path.join(projectPath, '.git');
  const head = async (dir: string): Promise<string> =>
    (await readFile(path.join(dir, 'HEAD'), 'utf8')).trim();
  try {
    return await head(dotGit);
  } catch {
    // Каталога `.git/` нет — может быть, это файл со ссылкой.
  }
  try {
    const link = GITDIR.exec((await readFile(dotGit, 'utf8')).trim());
    const target = link?.[1];
    // Ссылка бывает и относительной — считаем её от самого проекта.
    return target === undefined ? null : await head(path.resolve(projectPath, target));
  } catch {
    return null;
  }
}

/**
 * Имя ветки проекта; `null` — файла нет (не репозиторий), он пуст или голова
 * стоит не на ветке. Отсоединённая голова даёт короткий хэш — второй строке
 * работы важно показать хоть что-то узнаваемое.
 */
export async function gitBranch(projectPath: string): Promise<string | null> {
  const head = await readHead(projectPath);
  if (head === null || head === '') return null;
  const symbolic = SYMBOLIC.exec(head);
  if (symbolic !== null) return symbolic[1] ?? null;
  return HASH.test(head) ? head.slice(0, SHORT_HASH) : null;
}
