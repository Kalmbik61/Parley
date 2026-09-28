/**
 * Стор заметок к диффу (спека 11.4, кусок 8.4a): заметки загруженных сессий, запись через
 * `app.saveNotes` после 300 мс тишины по сессии и исход отправки. Файл пишет только main
 * (`main/notes-store.ts`) — рендерер отдаёт ему весь `NotesFile` сессии.
 */
import { toast } from 'sonner';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { NOTES_LIMITS, type DiffNote } from '../../../shared/notes-types.js';
import { S } from '../../../shared/strings.js';
import type { SendOutcome } from '../../terminal/send.js';
import { relocate } from './anchor.js';

/** Запись файла заметок — через 300 мс тишины (план, «Числа»). */
const SAVE_DELAY_MS = 300;

export function notesKey(workKey: string, sessionId: string): string {
  return `${workKey}\0${sessionId}`;
}

export interface NotesState {
  /** Заметки загруженных сессий по notesKey. */
  bySession: Record<string, DiffNote[]>;
  /**
   * Первый вызов — app.loadNotes (мост запоминается для записи); повтор после удачи — ничего.
   * corruptedTo — тост S.notes.corrupted. Отказ чтения — тост S.notes.loadFailed, запись сессии
   * запрещена до удачного чтения; следующий вызов (открытие вкладки диффа) читает снова.
   */
  load(bridge: HarnasBridge, workKey: string, sessionId: string): Promise<void>;
  /** Новая заметка: id — 8 hex, createdAt и updatedAt — сейчас, anchor.text — строка startLine. */
  add(
    workKey: string,
    sessionId: string,
    note: Pick<DiffNote, 'path' | 'side' | 'startLine' | 'endLine' | 'body'>,
    anchorText: string,
  ): void;
  update(workKey: string, sessionId: string, id: string, body: string): void;
  remove(workKey: string, sessionId: string, id: string): void;
  /** relocate заметок файла и стороны по свежим строкам; 8.4b зовёт на каждом чтении сторон. */
  relocateFile(workKey: string, sessionId: string, path: string, side: DiffNote['side'], lines: string[]): void;
  /** Исход попытки отправки (onOutcome sendWithToast, 5.4): inserted — sentAt и sentTo; прочее — без изменений. */
  applyOutcome(workKey: string, sessionId: string, ids: string[], sentTo: string, outcome: SendOutcome): void;
}

/** Загрузки по notesKey: повторный `load` получает тот же промис и мост не зовёт. */
const loads = new Map<string, Promise<void>>();
/** Мост записи по notesKey — тот, через который сессию загрузили. */
const bridges = new Map<string, HarnasBridge>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Сессии, чей файл заметок прочитан: писать можно только их. Пока чтение идёт, запись ждёт его конца
 * (он сам перевзведёт таймер); отказ чтения (EACCES и т. п. — не битый файл) запрещает запись, иначе
 * первая же правка затёрла бы заметки, которых окно не видело (fix-8.4a, пункты 1 и 3).
 */
const readable = new Set<string>();

function newId(taken: DiffNote[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!taken.some((note) => note.id === id)) return id;
  }
}

export const useNotesStore: UseBoundStore<StoreApi<NotesState>> = create<NotesState>((set, get) => {
  const scheduleSave = (workKey: string, sessionId: string): void => {
    const key = notesKey(workKey, sessionId);
    const pending = saveTimers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    saveTimers.set(
      key,
      setTimeout(() => {
        saveTimers.delete(key);
        const bridge = bridges.get(key);
        // Файл не прочитан — записи нет. Чтение ещё идёт: его конец перевзведёт таймер, если правки
        // были, — так на сессию один отложенный save, а не второй, повешенный на загрузку. Чтение
        // отказало или его не было: писать поверх непрочитанного файла нельзя.
        if (bridge === undefined || !readable.has(key)) return;
        const notes = get().bySession[key] ?? [];
        bridge.app.saveNotes(workKey, sessionId, { version: 1, notes }).catch((error: unknown) => {
          // Отказ main (форма, диск): человек видит тост, заметки остаются в окне, следующая правка
          // попробует снова; причина — в консоль.
          toast.error(S.notes.saveFailed);
          console.warn('[harnas] notes save failed', decodeIpcError(error).message);
        });
      }, SAVE_DELAY_MS),
    );
  };

  /** Меняет заметки сессии; change вернул null — ни состояния, ни записи. */
  const edit = (workKey: string, sessionId: string, change: (notes: DiffNote[]) => DiffNote[] | null): void => {
    const key = notesKey(workKey, sessionId);
    const next = change(get().bySession[key] ?? []);
    if (next === null) return;
    set((state) => ({ bySession: { ...state.bySession, [key]: next } }));
    scheduleSave(workKey, sessionId);
  };

  return {
    bySession: {},

    load: (bridge, workKey, sessionId) => {
      const key = notesKey(workKey, sessionId);
      const running = loads.get(key);
      if (running !== undefined) return running;
      bridges.set(key, bridge);
      const read = (async (): Promise<boolean> => {
        let loaded: DiffNote[];
        try {
          const { file, corruptedTo } = await bridge.app.loadNotes(workKey, sessionId);
          loaded = file.notes;
          if (corruptedTo !== null) toast.error(S.notes.corrupted(corruptedTo));
        } catch (error) {
          // Файл есть, но не прочитан: писать поверх нельзя — человек узнаёт тостом, что его правки
          // сессии останутся только в окне; причина — в консоль.
          toast.error(S.notes.loadFailed);
          console.warn('[harnas] notes load failed', decodeIpcError(error).message);
          return false;
        }
        readable.add(key);
        // Заметки, поставленные до ответа (или за время неудачного чтения), не теряются: файловые —
        // первыми, окна — за ними.
        const early = get().bySession[key] ?? [];
        set((state) => ({ bySession: { ...state.bySession, [key]: [...loaded, ...early] } }));
        if (early.length > 0) scheduleSave(workKey, sessionId);
        return true;
      })();
      // Неудача забывает загрузку: следующий load (открытие вкладки диффа сессии) прочитает снова.
      // then — всегда позже loads.set ниже, даже если мост отказал синхронно.
      const loading: Promise<void> = read.then((ok) => {
        if (!ok && loads.get(key) === loading) loads.delete(key);
      });
      loads.set(key, loading);
      return loading;
    },

    add: (workKey, sessionId, note, anchorText) =>
      edit(workKey, sessionId, (notes) => {
        const now = new Date().toISOString();
        return [
          ...notes,
          {
            id: newId(notes),
            path: note.path,
            side: note.side,
            startLine: note.startLine,
            endLine: note.endLine,
            body: note.body,
            createdAt: now,
            updatedAt: now,
            sentAt: null,
            sentTo: null,
            // Длинная строка — обрезанным префиксом: main отказал бы всему файлу (`isNotesFile`),
            // а `anchor.ts#relocate` сверяет такой якорь с тем же префиксом.
            anchor: { text: anchorText.slice(0, NOTES_LIMITS.anchor) },
            stale: false,
          },
        ];
      }),

    update: (workKey, sessionId, id, body) =>
      edit(workKey, sessionId, (notes) => {
        if (!notes.some((note) => note.id === id)) return null;
        const now = new Date().toISOString();
        return notes.map((note) => (note.id === id ? { ...note, body, updatedAt: now } : note));
      }),

    remove: (workKey, sessionId, id) =>
      edit(workKey, sessionId, (notes) => {
        const next = notes.filter((note) => note.id !== id);
        return next.length === notes.length ? null : next;
      }),

    relocateFile: (workKey, sessionId, path, side, lines) =>
      edit(workKey, sessionId, (notes) => {
        let changed = false;
        const next = notes.map((note) => {
          if (note.path !== path || note.side !== side) return note;
          const moved = relocate(note, lines);
          if (moved.startLine === note.startLine && moved.endLine === note.endLine && moved.stale === note.stale) return note;
          changed = true;
          return { ...note, ...moved };
        });
        return changed ? next : null;
      }),

    applyOutcome: (workKey, sessionId, ids, sentTo, outcome) => {
      // Отправленным считается и вставка без Enter (`draft`, `input`, `restarted`): текст уже у
      // агента, повторная отправка его задвоила бы. `blocked`, `busy`, `no-paste-mode` и отказ
      // вызова — без изменений: Retry тоста придёт сюда же своим исходом (решение сверки I2).
      if ('error' in outcome || !(outcome.inserted || outcome.submitted)) return;
      const wanted = new Set(ids);
      edit(workKey, sessionId, (notes) => {
        if (!notes.some((note) => wanted.has(note.id))) return null;
        const now = new Date().toISOString();
        return notes.map((note) => (wanted.has(note.id) ? { ...note, sentAt: now, sentTo } : note));
      });
    },
  };
});
