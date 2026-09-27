/**
 * Файловый API main (спека 10.7). В 5.2 — только `stat` и `locate`: на них стоят
 * ссылки терминала (спека 8.3); остальное приходит в этапе 7. Каждый путь проходит
 * реестр корней (`main/roots.ts`), отказ по одному пути пачку не валит.
 */
import { stat as fsStat } from 'node:fs/promises';
import type { FileRoot, FileStat, Located } from '../../shared/files-types.js';
import type { RootsRegistry } from '../roots.js';

/** Предел путей в одном вызове `files.stat` и `files.locate` (таблица чисел плана). */
export const MAX_PATHS_PER_CALL = 200;

export interface FsApi {
  stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>>;
  locate(workKey: string, absPaths: string[]): Promise<Array<Located | null>>;
}

/** `stat` по realpath: FIFO, сокеты и прочие не-файлы окну не нужны — `null`, как отсутствующий путь. */
async function statReal(real: string): Promise<FileStat | null> {
  const info = await fsStat(real);
  if (info.isDirectory()) return { kind: 'dir', size: info.size, mtimeMs: info.mtimeMs };
  if (info.isFile()) return { kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
  return null;
}

export function createFsApi(roots: RootsRegistry): FsApi {
  const statOne = async (root: FileRoot, relPath: string): Promise<FileStat | null> => {
    try {
      return await statReal(await roots.resolve(root, relPath, 'read'));
    } catch {
      // Нет файла и путь вне корня для окна одинаковы: ссылкой он не станет.
      return null;
    }
  };

  return {
    stat: (root, paths) => Promise.all(paths.map((relPath) => statOne(root, relPath))),
    locate: (workKey, absPaths) =>
      Promise.all(
        absPaths.map(async (absPath): Promise<Located | null> => {
          const found = await roots.locate(workKey, absPath);
          if (found === null) return null;
          const stat = await statOne(found.root, found.relPath);
          return stat === null ? null : { root: found.root, relPath: found.relPath, stat };
        }),
      ),
  };
}
