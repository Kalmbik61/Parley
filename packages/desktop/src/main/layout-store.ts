/**
 * Хранилище раскладок окна: `~/.harnas/desktop/layouts.json` (кусок 2.2 плана
 * каркаса, спека 3.4, 5.8). Формат v2 — ключ по `workKey` (по одной раскладке
 * `WorkLayout` на работу), а не общий на всё окно, как был v1: у каждой работы
 * теперь своя раскладка.
 *
 * v1 (`{ version: 1, layouts }`, кусок 2.2 прежнего плана) и любой битый файл
 * читаются как пустой v2-файл (план, «Поведение»): раскладки прежнего центра
 * не мигрируют — решено в разделе 1 диалога спеки, у каждой работы раскладка
 * начинается заново.
 *
 * Запись — через общие `atomic-file.ts` (1.1): уникальный `.tmp` на каждый
 * вызов и очередь операций на файл. Без очереди `save`/`remove`/`retain` без
 * `await` между ними читают файл до того, как друг друга дописали, и один
 * стирает изменения другого (тест 9 куска).
 */

import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { harnasHome } from '@harnas/core';
import { createFileQueue, writeAtomic } from './atomic-file.js';

export interface LayoutsFileV2 {
  version: 2;
  works: Record<string, unknown>;
}

/** 1 МБ — предел из плана: одна раскладка не должна раздувать файл без границ. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface LayoutStore {
  load(workKey: string): Promise<unknown | null>;
  save(workKey: string, layout: unknown): Promise<void>;
  remove(workKey: string): Promise<void>;
  /** Оставляет раскладки только этих работ; прочие ключи, включая `window` прежнего центра, стирает. */
  retain(workKeys: string[]): Promise<void>;
}

/** Раскладка больше `maxBytes` — сохранение отказывает, старый файл остаётся (спека 5.8). */
export class LayoutTooLargeError extends Error {
  constructor(file: string, sizeBytes: number, maxBytes: number) {
    super(`layout ${file}: ${sizeBytes} bytes over the ${maxBytes} limit`);
    this.name = 'LayoutTooLargeError';
  }
}

/** `~/.harnas/desktop/layouts.json` — `harnasHome()` уже слушает `HARNAS_HOME` (`@harnas/core`). */
export function desktopLayoutsPath(home: string = harnasHome()): string {
  return path.join(home, 'desktop', 'layouts.json');
}

/**
 * `works` в памяти держим как `Map`, а не `Record`/`{}` (раунд исправлений 1,
 * Important B): строка `"__proto__"` на плоском объекте — не обычное
 * свойство, а унаследованный аксессор `Object.prototype.__proto__`.
 * Присваивание `obj[key] = value`, когда СВОЕГО свойства с таким именем у
 * `obj` ещё нет, идёт через этот аксессор и меняет сам `[[Prototype]]`
 * объекта вместо того, чтобы создать запись — значение тихо пропадает, а
 * объект превращается в замаскированный `Object.prototype`. Ровно это раньше
 * делала `filterWorks` в `remove`/`retain`, строя результат заново через
 * `result[key] = value` на свежем `{}`. `Map` не путает строку `"__proto__"`
 * со своим прототипом ни на чтении, ни на записи — вся внутренняя работа
 * поэтому через неё; JSON на диске `Map` не поддерживает, конвертация на
 * границе — через `Object.fromEntries`/`Object.keys`, которые создают и
 * читают СОБСТВЕННЫЕ свойства напрямую (`[[DefineOwnProperty]]`), а не через
 * `[[Set]]`/`[[Get]]`, идущие по цепочке прототипов.
 */
function emptyWorks(): Map<string, unknown> {
  return new Map();
}

/** Безопасный разбор `works` из уже распарсенного JSON — `null`, если это не объект. */
function worksFromRaw(raw: unknown): Map<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const map = new Map<string, unknown>();
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(raw, key)) map.set(key, (raw as Record<string, unknown>)[key]);
  }
  return map;
}

/**
 * v1 (`layouts`) и битый JSON — оба читаются как пустая карта (план,
 * «Поведение»): разбираться в причине повреждения незачем — следующий
 * `save`/`remove`/`retain` перезапишет файл валидным v2-содержимым сам.
 */
async function readLayoutsFile(file: string): Promise<Map<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorks();
    throw error;
  }

  try {
    const data = JSON.parse(raw) as Partial<LayoutsFileV2>;
    if (data.version !== 2) return emptyWorks();
    return worksFromRaw(data.works) ?? emptyWorks();
  } catch {
    return emptyWorks();
  }
}

export interface CreateLayoutStoreOptions {
  maxBytes?: number;
  /**
   * Подставной `rename` для теста атомарности (кусок 2.2, тест 1): `vi.spyOn`
   * на `node:fs/promises` не может подменить именованный экспорт (`Cannot
   * redefine property`) — тот же приём DI, что и `run` в `captureShellEnv`
   * (`shell-env.ts`), решает это без глобального мока модуля.
   */
  rename?: typeof rename;
}

export function createLayoutStore(file: string, options: CreateLayoutStoreOptions = {}): LayoutStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const doRename = options.rename ?? rename;
  // Очередь на файл: без неё два вызова без `await` между ними читают файл до
  // того, как первый дописал свой патч, и второй затирает изменения первого
  // при записи (тест 9, тот же приём, что и `ui-store.ts`).
  const enqueue = createFileQueue();

  async function writeWorks(works: Map<string, unknown>): Promise<void> {
    // `Object.fromEntries` создаёт собственные свойства напрямую
    // (`CreateDataPropertyOrThrow`), а не через `obj[key] = value` — безопасно
    // даже для ключа `"__proto__"` (см. комментарий у `emptyWorks` выше).
    const next: LayoutsFileV2 = { version: 2, works: Object.fromEntries(works) };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    if (sizeBytes > maxBytes) throw new LayoutTooLargeError(file, sizeBytes, maxBytes);
    await writeAtomic(file, text, doRename);
  }

  return {
    async load(workKey) {
      const works = await readLayoutsFile(file);
      return works.get(workKey) ?? null;
    },

    save: (workKey, layout) =>
      enqueue(async () => {
        const works = await readLayoutsFile(file);
        works.set(workKey, layout);
        await writeWorks(works);
      }),

    remove: (workKey) =>
      enqueue(async () => {
        const works = await readLayoutsFile(file);
        works.delete(workKey);
        await writeWorks(works);
      }),

    retain: (workKeys) =>
      enqueue(async () => {
        const works = await readLayoutsFile(file);
        const keep = new Set(workKeys);
        for (const key of [...works.keys()]) {
          if (!keep.has(key)) works.delete(key);
        }
        await writeWorks(works);
      }),
  };
}
