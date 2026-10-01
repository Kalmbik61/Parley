/**
 * Заметки к диффу — `~/.parley/desktop/notes/<sha1(workKey)>/<sessionId>.json` (спека 11.4,
 * кусок 8.4a). Каталог `notes/` свой, как у `ui.json`; запись атомарная и очередью на файл
 * (`atomic-file.ts`): две записи одной сессии подряд не гоняются за одним файлом.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import { isNotesFile, NOTES_LIMITS, type NotesFile } from '../shared/notes-types.js';
import { isSessionId } from '../shared/work-keys.js';
import { createFileQueue, writeAtomic } from './atomic-file.js';
import { isValidWorkKey } from './ipc.js';

/**
 * sessionId не isSessionId или workKey не isValidWorkKey (5.2) — ошибка: sessionId идёт в имя
 * файла как есть, а от workKey в путь попадает только sha1. Проверка здесь — вторая линия за
 * каналами `app:*-notes` (`ipc.ts`): стор не должен писать вне `notes/` ни при каком вызове.
 */
export function notesPath(home: string, workKey: string, sessionId: string): string {
  if (!isValidWorkKey(workKey)) throw new Error('invalid notes work key');
  if (!isSessionId(sessionId)) throw new Error(`invalid notes session id: ${sessionId}`);
  const dir = createHash('sha1').update(workKey).digest('hex');
  return path.join(home, 'desktop', 'notes', dir, `${sessionId}.json`);
}

export interface NotesStore {
  /**
   * Битый файл (не JSON, не isNotesFile, больше 1 МБ) → пустые заметки; файл переименован в
   * <sessionId>.corrupt-<время>.json рядом. corruptedTo — только это имя, полный путь — в консоль main.
   */
  load(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;
  save(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;
}

/** `20260927-140501` — местное время: имя видит человек в тосте и в Finder. */
function stamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

/** Разбор без исключений: null — файл битый. Размер — до чтения, чтобы не тянуть в память гигабайт. */
async function readNotes(file: string): Promise<NotesFile | null | 'missing'> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (size > NOTES_LIMITS.fileBytes) return null;
  const raw = await readFile(file, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    return isNotesFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createNotesStore(home: string = parleyHome()): NotesStore {
  // Одна очередь на все файлы стора: записи редки (300 мс тишины в окне), а чтение с
  // переименованием битого и запись одной сессии не должны перекрываться.
  const enqueue = createFileQueue();

  return {
    // async: неверный ключ — отказ промиса, а не синхронный throw у вызывающего.
    load: async (workKey, sessionId) => {
      const file = notesPath(home, workKey, sessionId);
      return enqueue(async () => {
        const notes = await readNotes(file);
        if (notes === 'missing') return { file: { version: 1, notes: [] }, corruptedTo: null };
        if (notes !== null) return { file: notes, corruptedTo: null };
        const corruptedTo = `${sessionId}.corrupt-${stamp(new Date())}.json`;
        const target = path.join(path.dirname(file), corruptedTo);
        await rename(file, target);
        // Полный путь — только сюда: `notes/` лежит вне корней работы, а такие пути рендерер
        // не получает (спека 15.2). Окну уходит одно имя для тоста.
        console.warn(`[parley] damaged notes file moved to ${target}`);
        return { file: { version: 1, notes: [] }, corruptedTo };
      });
    },

    save: async (workKey, sessionId, notes) => {
      const file = notesPath(home, workKey, sessionId);
      if (!isNotesFile(notes)) throw new Error('invalid notes file');
      // Компактный JSON: предел 1 МБ `isNotesFile` считает по нему же.
      return enqueue(() => writeAtomic(file, JSON.stringify(notes)));
    },
  };
}
