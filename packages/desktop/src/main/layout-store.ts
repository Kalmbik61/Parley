/**
 * Хранилище раскладок окна: `~/.harnas/desktop/layouts.json` (кусок 2.2 плана
 * каркаса, спека 3.4, 5.8). Формат v2 — ключ по `workKey` (по одной раскладке
 * `WorkLayout` на работу), а не общий на всё окно, как был v1: у каждой работы
 * теперь своя раскладка. Прежний `Workspace.tsx` (до 2.7) продолжает читать и
 * писать сюда же свою единую сетку dockview под ключом `window` — формат это
 * не мешает, он просто словарь по ключу.
 *
 * v1 (`{ version: 1, layouts }`, кусок 2.2 прежнего плана) и любой битый файл
 * читаются как пустой v2-файл (план, «Поведение»): раскладки dockview не
 * мигрируют — решено в разделе 1 диалога спеки, у каждой работы раскладка
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
  /** Оставляет раскладки только этих работ и ключ `window` прежнего `Workspace` (до 2.7). */
  retain(workKeys: string[]): Promise<void>;
}

/** Раскладка больше `maxBytes` — сохранение отказывает, старый файл остаётся (спека 5.8). */
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

function emptyFile(): LayoutsFileV2 {
  return { version: 2, works: {} };
}

/** Ключи, для которых `keep` истинно; порядок не важен — файл лишь хранилище по ключу. */
function filterWorks(works: Record<string, unknown>, keep: (key: string) => boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(works)) {
    if (keep(key)) result[key] = value;
  }
  return result;
}

/**
 * v1 (`layouts`) и битый JSON — оба читаются как пустой v2-файл (план,
 * «Поведение»): разбираться в причине повреждения незачем — следующий
 * `save`/`remove`/`retain` перезапишет файл валидным v2-содержимым сам.
 */
async function readLayoutsFile(file: string): Promise<LayoutsFileV2> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw error;
  }

  try {
    const data = JSON.parse(raw) as Partial<LayoutsFileV2>;
    if (data.version !== 2 || typeof data.works !== 'object' || data.works === null) return emptyFile();
    return { version: 2, works: data.works };
  } catch {
    return emptyFile();
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

  async function writeFile(next: LayoutsFileV2): Promise<void> {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    if (sizeBytes > maxBytes) throw new LayoutTooLargeError(file, sizeBytes, maxBytes);
    await writeAtomic(file, text, doRename);
  }

  return {
    async load(workKey) {
      const data = await readLayoutsFile(file);
      return data.works[workKey] ?? null;
    },

    save: (workKey, layout) =>
      enqueue(async () => {
        const data = await readLayoutsFile(file);
        await writeFile({ version: 2, works: { ...data.works, [workKey]: layout } });
      }),

    remove: (workKey) =>
      enqueue(async () => {
        const data = await readLayoutsFile(file);
        await writeFile({ version: 2, works: filterWorks(data.works, (key) => key !== workKey) });
      }),

    retain: (workKeys) =>
      enqueue(async () => {
        const data = await readLayoutsFile(file);
        const keep = new Set([...workKeys, 'window']);
        await writeFile({ version: 2, works: filterWorks(data.works, (key) => keep.has(key)) });
      }),
  };
}
