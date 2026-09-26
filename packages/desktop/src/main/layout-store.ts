/**
 * Хранилище раскладок окна: `~/.harnas/desktop/layouts.json` (кусок 2.2 плана
 * окна, спека 5.1 — «раскладка запоминается для каждой работы»). Формат файла
 * держит несколько раскладок сразу (`layouts`, ключ — по плану `workKey`), а не
 * одну: план рассчитан на будущее, где у каждой работы свой ключ, и завтрашний
 * переход на него не потребует миграции файла — сегодня `use-layout-persistence.ts`
 * пишет сюда единственным ключом (см. комментарий там про то, почему сетка
 * куска 2.1 общая на все работы, а не по одной на каждую).
 *
 * Запись — как `writeAtomic` в `packages/core/src/work/store.ts`: временный
 * файл рядом плюс `rename`. `rename` на одной файловой системе — атомарная
 * операция ОС, так что читатель (тест 5 куска) не может увидеть наполовину
 * записанный JSON — только старое содержимое до переименования или новое
 * после него.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harnasHome } from '@harnas/core';

export interface LayoutsFile {
  version: 1;
  layouts: Record<string, unknown>;
}

/** 1 МБ — предел из плана куска 2.2: одна раскладка не должна раздувать файл без границ. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface LayoutStore {
  load(workKey: string): Promise<unknown | null>;
  save(workKey: string, layout: unknown): Promise<void>;
}

/** Раскладка больше `maxBytes` — сохранение отказывает, старый файл остаётся (план, «Поведение»). */
export class LayoutTooLargeError extends Error {
  constructor(file: string, sizeBytes: number, maxBytes: number) {
    super(`раскладка ${file}: ${sizeBytes} байт больше предела ${maxBytes}`);
    this.name = 'LayoutTooLargeError';
  }
}

/** `~/.harnas/desktop/layouts.json` — `harnasHome()` уже слушает `HARNAS_HOME` (`@harnas/core`). */
export function desktopLayoutsPath(home: string = harnasHome()): string {
  return path.join(home, 'desktop', 'layouts.json');
}

function emptyFile(): LayoutsFile {
  return { version: 1, layouts: {} };
}

/**
 * Битый файл — план требует пустые раскладки вместо падения (кусок 2.2,
 * «Поведение»): читатель тут не один (окно могло упасть посреди записи), и
 * разбираться в причине незачем — при следующем `save` файл перезапишется
 * валидным содержимым сам собой.
 */
async function readLayoutsFile(file: string): Promise<LayoutsFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw error;
  }

  try {
    const data = JSON.parse(raw) as Partial<LayoutsFile>;
    if (data.version !== 1 || typeof data.layouts !== 'object' || data.layouts === null) return emptyFile();
    return { version: 1, layouts: data.layouts };
  } catch {
    return emptyFile();
  }
}

async function writeAtomic(file: string, text: string, doRename: typeof rename): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await doRename(tmp, file);
}

export interface CreateLayoutStoreOptions {
  maxBytes?: number;
  /**
   * Подставной `rename` для теста атомарности (кусок 2.2, тест 5): `vi.spyOn`
   * на `node:fs/promises` не может подменить именованный экспорт (`Cannot
   * redefine property`) — тот же приём DI, что и `run` в `captureShellEnv`
   * (`shell-env.ts`), решает это без глобального мока модуля.
   */
  rename?: typeof rename;
}

export function createLayoutStore(file: string, options: CreateLayoutStoreOptions = {}): LayoutStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const doRename = options.rename ?? rename;

  return {
    async load(workKey) {
      const data = await readLayoutsFile(file);
      return data.layouts[workKey] ?? null;
    },

    async save(workKey, layout) {
      const data = await readLayoutsFile(file);
      const next: LayoutsFile = { version: 1, layouts: { ...data.layouts, [workKey]: layout } };
      const text = `${JSON.stringify(next, null, 2)}\n`;
      const sizeBytes = Buffer.byteLength(text, 'utf8');
      if (sizeBytes > maxBytes) throw new LayoutTooLargeError(file, sizeBytes, maxBytes);
      await writeAtomic(file, text, doRename);
    },
  };
}
