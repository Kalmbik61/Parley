/**
 * Хранилище `~/.harnas/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе (спека 3.4, кусок 1.1 плана окна). Запись — как в
 * `layout-store.ts`: временный файл рядом плюс `rename`, что на одной файловой
 * системе атомарно — читатель не увидит наполовину записанный JSON.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harnasHome } from '@harnas/core';
import { DEFAULT_UI, normalizeUi, type UiFile } from '../shared/ui-types.js';

/** `~/.harnas/desktop/ui.json` — рядом с `layouts.json` (`layout-store.ts`). */
export function desktopUiPath(home: string = harnasHome()): string {
  return path.join(home, 'desktop', 'ui.json');
}

/**
 * Битый или отсутствующий файл читается как `DEFAULT_UI` (план, «ui.json»):
 * разбираться в причине незачем — следующий `save` перезапишет файл валидным
 * содержимым сам.
 */
async function readUiFile(file: string): Promise<UiFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_UI;
    throw error;
  }
  try {
    return normalizeUi(JSON.parse(raw));
  } catch {
    return DEFAULT_UI;
  }
}

async function writeAtomic(file: string, text: string, doRename: typeof rename): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await doRename(tmp, file);
}

export interface UiStore {
  load(): Promise<UiFile>;
  /** Сливает патч по ключам верхнего уровня: вложенный объект заменяется целиком (план, «ui.json»). */
  save(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
}

export interface CreateUiStoreOptions {
  /** Подставной `rename` для теста атомарности — `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`. */
  rename?: typeof rename;
}

export function createUiStore(file: string, options: CreateUiStoreOptions = {}): UiStore {
  const doRename = options.rename ?? rename;

  return {
    load: () => readUiFile(file),

    async save(patch) {
      const current = await readUiFile(file);
      // `normalizeUi` после слияния — не только клапан для ключей из патча
      // (ширины сайдбаров и т.п.), но и гарантия, что на диске всегда лежит
      // валидный `UiFile`, даже если патч пришёл из IPC необработанным.
      const merged = normalizeUi({ ...current, ...patch, version: 1 });
      await writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, doRename);
      return merged;
    },
  };
}
