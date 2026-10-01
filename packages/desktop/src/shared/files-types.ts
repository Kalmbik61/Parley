/**
 * Типы файлового API main (спека 10.7, кусок 5.2): их видят и main, и рендерер
 * через мост. В 5.2 из API есть только `stat` и `locate` — на них стоят ссылки
 * терминала (спека 8.3); `list`, `readText`, `readBytes` и `write` — с 7.1a,
 * остальное приходит в 7.1b и 8.3.
 */
import type { DiffFile } from '@parley/core';
import type { FileRootSpec } from './layout-types.js';

/**
 * Файл диффа (8.1) — только тип: рантайм core в окно не собирается (кусок 8.3). Main и
 * рендерер видят один тип: `tsconfig.node.json` ссылается на core с 8.3.
 */
export type { DiffFile };

export interface FileRoot {
  workKey: string;
  spec: FileRootSpec;
}

export interface FileStat {
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

/** Абсолютный путь, найденный в корне работы, которую назвал вызов. */
export interface Located {
  root: FileRoot;
  relPath: string;
  stat: FileStat;
}

/** Запись папки для дерева «Файлов» (спека 10.7). */
export interface DirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  /** С 7.1b — по `git check-ignore`; в 7.1a всегда false. */
  ignored: boolean;
  /** У симлинка — вид цели внутри корня; null — цель вне корня или ссылка висячая; у прочих — null. */
  target: 'file' | 'dir' | null;
}

/** Текст файла для редактора (спека 10.7). `readOnlyReason` — код: слова к нему берёт рендерер. */
export interface TextFile {
  text: string;
  mtimeMs: number;
  size: number;
  binary: boolean;
  utf8: boolean;
  readOnlyReason: 'too-large' | 'not-utf8' | null;
}

/** Ответ `files.write`: `conflict` — `mtimeMs` на диске не тот, что ждал буфер; запись не сделана. */
export type WriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: { mtimeMs: number } };

/** Буква git-статуса в дереве (спека 10.1): U — неотслеживаемый; конфликт приходит как M. */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'U' | 'R';

/** Запрос поиска в файлах (спека 10.3): флаги «Aa», «Слово», «.*». */
export interface GrepQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** Совпадение поиска: номер строки с 1, текст строки и `[начало, конец)` совпадений в кодовых единицах. */
export interface GrepHit {
  line: number;
  /**
   * Колонка первого совпадения в полной строке, с 1, в кодовых единицах UTF-16 — как у курсора
   * Monaco (раунд fix-7.4, п. 2): `text` — лишь окно строки, по нему колонку не восстановить.
   */
  column: number;
  text: string;
  ranges: [number, number][];
}

/**
 * Ответ `lsFiles` (⌘P): `truncated` — список неполон: обход не-git корня упёрся в предел 50 000,
 * в бюджет времени или отменён. Окно тогда говорит, что показано не всё (7.4).
 */
export interface FileList {
  paths: string[];
  truncated: boolean;
}

/** Ответ поиска: `truncated` — упёрся в предел, отменён или остановлен по времени. */
export interface GrepResult {
  files: Array<{ path: string; hits: GrepHit[] }>;
  truncated: boolean;
  /**
   * Регулярка искалась как POSIX ERE (`git grep -E`): у git этой машины нет PCRE, и `\d`, `\w`,
   * `\s` не работают. Панель показывает подсказку (раунд fix-7.4, п. 3). Иначе поля нет.
   */
  posixRegex?: true;
}

/** Событие слежения за файлом: id подписки из `watch`, путь как его назвал `watch`. */
export interface FileChangedEvent {
  id: string;
  path: string;
  mtimeMs: number | null;
  deleted: boolean;
}

/** Пачка изменений дерева корня: `rootKey` — `shared/work-keys.ts`, папки относительные, '' — корень. */
export interface TreeChangedEvent {
  rootKey: string;
  dirs: string[];
}
