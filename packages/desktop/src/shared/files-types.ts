/**
 * Типы файлового API main (спека 10.7, кусок 5.2): их видят и main, и рендерер
 * через мост. В 5.2 из API есть только `stat` и `locate` — на них стоят ссылки
 * терминала (спека 8.3); `list`, `readText`, `readBytes` и `write` — с 7.1a,
 * остальное приходит в 7.1b и 8.3.
 */
import type { FileRootSpec } from './layout-types.js';

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
