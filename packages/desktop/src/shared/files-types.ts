/**
 * Типы файлового API main (спека 10.7, кусок 5.2): их видят и main, и рендерер
 * через мост. В 5.2 из API есть только `stat` и `locate` — на них стоят ссылки
 * терминала (спека 8.3); остальное приходит в этапе 7.
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
