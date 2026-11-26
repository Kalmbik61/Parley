/**
 * Хранилище `~/.parley/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе (спека 3.4, кусок 1.1 плана окна). Атомарная запись и
 * очередь на файл — общий `main/atomic-file.ts` (см. его шапку про находку C3
 * раунда исправлений 1: без очереди два `save()` без `await` между ними
 * гонялись за одним временем файла и роняли промис `ENOENT`).
 */

import { readFile, rename } from 'node:fs/promises';
import { parleyHome } from '@parley/core';
import { desktopUiPath as uiPathInHome } from '@parley/core/desktop-locale';
import { resolveAppLocale } from '@parley/core/i18n';
import { mergeUiPatch, normalizeUi, type UiFile } from '../shared/ui-types.js';
import { createFileQueue, writeAtomic } from './atomic-file.js';

/** `~/.parley/desktop/ui.json` — рядом с `layouts.json` (`layout-store.ts`). */
export function desktopUiPath(home: string = parleyHome()): string {
  return uiPathInHome(home);
}

/**
 * Битый или отсутствующий файл читается как `DEFAULT_UI` (план, «ui.json»).
 * Любая другая ошибка чтения (каталог на месте файла, нет прав — раунд
 * исправлений 1, находка I2/тест 13) — тоже `DEFAULT_UI` с предупреждением в
 * лог main: `main/index.ts` зовёт `load()` без try/catch до создания окна, и
 * старт из-за состояния `ui.json` падать не должен.
 */
async function readRawUiFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    console.warn(`[parley] ui.json unreadable (${file}): ${(error as Error).message}`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function migrateLegacyLocale(raw: unknown, systemLocale: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const locale = 'locale' in raw ? raw.locale : undefined;
  if (locale !== undefined && locale !== 'system') return raw;
  // Меняем только язык, сохраняя остальные настройки в исходном виде.
  return { ...raw, locale: resolveAppLocale(locale, systemLocale) };
}

export interface UiStore {
  load(): Promise<UiFile>;
  /** Сливает патч по ключам верхнего уровня; вложенные объекты — на один уровень (см. `mergeUiPatch`). */
  save(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
}

export interface CreateUiStoreOptions {
  systemLocale?: string;
  /** Подставной `rename` для теста атомарности — `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`. */
  rename?: typeof rename;
}

export function createUiStore(file: string, options: CreateUiStoreOptions = {}): UiStore {
  const doRename = options.rename ?? rename;
  const systemLocale = options.systemLocale ?? 'en';
  // Своя очередь на каждый стор: `save` целиком (чтение + слияние + запись) —
  // одна операция очереди, иначе второй `save` читает файл до того, как
  // первый дописал свой патч (тест 8).
  const enqueue = createFileQueue();

  return {
    load: () =>
      enqueue(async () => {
        const raw = await readRawUiFile(file);
        const migrated = migrateLegacyLocale(raw, systemLocale);
        if (migrated !== raw) {
          try {
            await writeAtomic(file, `${JSON.stringify(migrated, null, 2)}\n`, doRename);
          } catch (error) {
            console.warn('[parley] could not persist the interface language', error);
          }
        }
        return normalizeUi(migrated);
      }),

    save: (patch) =>
      enqueue(async () => {
        const current = normalizeUi(migrateLegacyLocale(await readRawUiFile(file), systemLocale));
        // `normalizeUi` после слияния — не только клапан для ключей из патча
        // (ширины сайдбаров и т.п.), но и гарантия, что на диске всегда лежит
        // валидный `UiFile`, даже если патч пришёл из IPC необработанным.
        const merged = normalizeUi(mergeUiPatch(current, patch));
        await writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, doRename);
        return merged;
      }),
  };
}
