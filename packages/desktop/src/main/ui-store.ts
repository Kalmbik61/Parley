/**
 * Хранилище `~/.parley/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе (спека 3.4, кусок 1.1 плана окна). Атомарная запись и
 * очередь на файл — общий `main/atomic-file.ts` (см. его шапку про находку C3
 * раунда исправлений 1: без очереди два `save()` без `await` между ними
 * гонялись за одним временем файла и роняли промис `ENOENT`).
 */

import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import { DEFAULT_UI, normalizeUi, type UiFile } from '../shared/ui-types.js';
import { createFileQueue, writeAtomic } from './atomic-file.js';

/** `~/.parley/desktop/ui.json` — рядом с `layouts.json` (`layout-store.ts`). */
export function desktopUiPath(home: string = parleyHome()): string {
  return path.join(home, 'desktop', 'ui.json');
}

/**
 * Вложенные объекты `UiFile`, которые `save` сливает НЕ целиком поверх
 * текущего файла, а по одному уровню (текущее ⊕ патч) перед `normalizeUi`
 * (раунд исправлений 1, находка I1/тест 12): иначе `normalizeUi` подставляет
 * `DEFAULT_UI` в подполя, которых нет в патче, — частичный `{ sound: false }`
 * откатывал бы `needsYou`/`finished`/`mail` на дефолтный `true`, хотя патч их
 * не трогал.
 */
const NESTED_KEYS = [
  'leftSidebar',
  'rightSidebar',
  'notifications',
  'voice',
  'browser',
] as const satisfies ReadonlyArray<keyof UiFile>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeUiPatch(
  current: UiFile,
  patch: Partial<Omit<UiFile, 'version'>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of NESTED_KEYS) {
    const patchValue = (patch as Partial<Record<(typeof NESTED_KEYS)[number], unknown>>)[key];
    if (isPlainObject(patchValue)) {
      merged[key] = { ...(current[key] as Record<string, unknown>), ...patchValue };
    }
  }
  return merged;
}

/**
 * Битый или отсутствующий файл читается как `DEFAULT_UI` (план, «ui.json»).
 * Любая другая ошибка чтения (каталог на месте файла, нет прав — раунд
 * исправлений 1, находка I2/тест 13) — тоже `DEFAULT_UI` с предупреждением в
 * лог main: `main/index.ts` зовёт `load()` без try/catch до создания окна, и
 * старт из-за состояния `ui.json` падать не должен.
 */
async function readUiFile(file: string): Promise<UiFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_UI;
    console.warn(`[parley] ui.json unreadable (${file}): ${(error as Error).message}`);
    return DEFAULT_UI;
  }
  try {
    return normalizeUi(JSON.parse(raw));
  } catch {
    return DEFAULT_UI;
  }
}

export interface UiStore {
  load(): Promise<UiFile>;
  /** Сливает патч по ключам верхнего уровня; вложенные объекты — на один уровень (см. `mergeUiPatch`). */
  save(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
}

export interface CreateUiStoreOptions {
  /** Подставной `rename` для теста атомарности — `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`. */
  rename?: typeof rename;
}

export function createUiStore(file: string, options: CreateUiStoreOptions = {}): UiStore {
  const doRename = options.rename ?? rename;
  // Своя очередь на каждый стор: `save` целиком (чтение + слияние + запись) —
  // одна операция очереди, иначе второй `save` читает файл до того, как
  // первый дописал свой патч (тест 8).
  const enqueue = createFileQueue();

  return {
    load: () => readUiFile(file),

    save: (patch) =>
      enqueue(async () => {
        const current = await readUiFile(file);
        // `normalizeUi` после слияния — не только клапан для ключей из патча
        // (ширины сайдбаров и т.п.), но и гарантия, что на диске всегда лежит
        // валидный `UiFile`, даже если патч пришёл из IPC необработанным.
        const merged = normalizeUi(mergeUiPatch(current, patch));
        await writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, doRename);
        return merged;
      }),
  };
}
