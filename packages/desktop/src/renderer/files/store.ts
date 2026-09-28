/**
 * Стор вкладки «Файлы» правого сайдбара (кусок 7.2, спека 10.1): выбор корня человеком и
 * раскрытые папки; режим поиска — 7.4. Содержимое папок здесь не хранится: его держит само
 * дерево (`files/Tree.tsx`) — оно живёт, пока панель открыта, и перечитывает папки по событиям
 * слежения.
 *
 * Ключ корня — `rootKey` из `shared/work-keys.ts` (5.2), своего нет: тот же ключ у main и в
 * событиях `treeChanged`.
 *
 * Буферы файлов (кусок 7.3a, спека 10.5) живут здесь, а не в теле вкладки: `GroupView`
 * монтирует тело только активной вкладки, перенос в другую группу монтирует его заново, работа
 * вне трёх последних LRU размонтируется целиком. Буфер, открытый и закрытый по монтированию
 * тела, перечитал бы файл поверх правок при смене вкладки или пропал бы. Поэтому буфер живёт с
 * первого `openBuffer` до исчезновения вкладки из `layouts`, а отпускает его только
 * `bindBuffersToLayouts`.
 */

import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { FileRoot } from '../../shared/files-types.js';
import type { FileRootSpec, WorkLayout } from '../../shared/layout-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { groups } from '../layout/tree.js';
import { useLayoutStore } from '../layout/store.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { bufferKey, bufferReducer, initialBuffer, isBufferDirty, splitBufferKey, type BufferEvent, type BufferModel } from './buffer.js';
import type { DirtyBufferRef } from './close-guard.js';

export interface FileBuffer {
  root: FileRoot;
  path: string;
  /** Id подписки `files.watch`; null — ещё не ответила или не запустилась. */
  watchId: string | null;
  model: BufferModel;
}

export type SaveResult = 'saved' | 'conflict' | 'failed';

export interface FilesState {
  /** Выбор человека в `RootPicker` по `workKey`; пока его нет — `defaultRoot`. */
  rootByWork: Record<string, FileRootSpec>;
  /** Раскрытые папки по `rootKey`: относительные пути, '' — корень (он раскрыт всегда). */
  expanded: Record<string, Set<string>>;
  setRoot(workKey: string, spec: FileRootSpec): void;
  toggleDir(rootKey: string, dir: string): void;

  /** Буферы по `bufferKey` (7.3a). */
  buffers: Record<string, FileBuffer>;
  /** Разовые позиции курсора по `bufferKey`: их забирает `takeReveal`. */
  reveals: Record<string, { line: number; col: number }>;
  /** Первое открытие: readText → loaded, files.watch на файл. Повтор — перемонтированное тело — ничего не делает. */
  openBuffer(bridge: HarnasBridge, workKey: string, tabId: string, root: FileRoot, path: string): void;
  dispatch(key: string, event: BufferEvent): void;
  /** ⌘S и «Сохранить» вопроса закрытия: save-started, write с mtimeMs буфера (у deleted — null), затем saved, save-conflict или failed. */
  save(bridge: HarnasBridge, workKey: string, tabId: string, options?: { overwrite?: boolean }): Promise<SaveResult>;
  /** Разовая позиция курсора (строка и колонка с 1): её забирает FileBody при монтировании и при смене. */
  revealAt(workKey: string, tabId: string, line: number, col: number): void;
  takeReveal(key: string): { line: number; col: number } | null;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Идущие записи по `bufferKey`: второй ⌘S до ответа первого получает тот же исход, а не вторую запись. */
const inFlightSaves = new Map<string, Promise<SaveResult>>();

export const useFilesStore = create<FilesState>((set, get) => {
  const patchModel = (key: string, event: BufferEvent): void =>
    set((state) => {
      const buffer = state.buffers[key];
      if (buffer === undefined) return state;
      const model = bufferReducer(buffer.model, event);
      return model === buffer.model ? state : { buffers: { ...state.buffers, [key]: { ...buffer, model } } };
    });

  return {
    rootByWork: {},
    expanded: {},
    setRoot: (workKey, spec) => set((state) => ({ rootByWork: { ...state.rootByWork, [workKey]: spec } })),
    toggleDir: (rootKey, dir) =>
      set((state) => {
        // Новый `Set`, а не правка на месте: подписки zustand сравнивают ссылки.
        const next = new Set(state.expanded[rootKey]);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        return { expanded: { ...state.expanded, [rootKey]: next } };
      }),

    buffers: {},
    reveals: {},

    openBuffer: (bridge, workKey, tabId, root, path) => {
      const key = bufferKey(workKey, tabId);
      if (get().buffers[key] !== undefined) return;
      const buffer: FileBuffer = { root, path, watchId: null, model: initialBuffer() };
      set((state) => ({ buffers: { ...state.buffers, [key]: buffer } }));
      // Ответ для уже отпущенного буфера (вкладку закрыли до ответа) никуда не пишется: сверка по
      // ссылке — буфер той же вкладки, открытый заново, это уже другой объект.
      const alive = (): boolean => get().buffers[key]?.root === root;
      bridge.files
        .readText(root, path)
        .then((file) => patchModel(key, { type: 'loaded', file }))
        .catch((error: unknown) => {
          console.warn('[harnas] files.readText', error);
          patchModel(key, { type: 'failed', code: decodeIpcError(error).code });
        });
      bridge.files
        .watch(root, path)
        .then((watchId) => {
          if (!alive()) {
            void bridge.files.unwatch(watchId).catch((error: unknown) => console.warn('[harnas] files.unwatch', error));
            return;
          }
          set((state) => {
            const current = state.buffers[key];
            return current === undefined ? state : { buffers: { ...state.buffers, [key]: { ...current, watchId } } };
          });
        })
        // Без слежения буфер работает, только не узнаёт о правках агента до записи: её
        // `expectedMtimeMs` всё равно не даст перетереть их молча.
        .catch((error: unknown) => console.warn('[harnas] files.watch', error));
    },

    dispatch: (key, event) => patchModel(key, event),

    save: (bridge, workKey, tabId, options = {}) => {
      const key = bufferKey(workKey, tabId);
      const running = inFlightSaves.get(key);
      if (running !== undefined) return running;
      const buffer = get().buffers[key];
      if (buffer === undefined) return Promise.resolve('failed');
      const { model } = buffer;
      if (model.status === 'loading' || model.status === 'error' || model.readOnlyReason !== null) return Promise.resolve('failed');
      // «Перезаписать» после конфликта — против mtime диска, который видел человек; иначе — против
      // открытого. У удалённого файла — null: запись создаёт его заново.
      const expected = options.overwrite === true ? model.diskMtimeMs : model.status === 'deleted' ? null : model.mtimeMs;
      const text = model.text;
      patchModel(key, { type: 'save-started' });
      const done = bridge.files
        .write(buffer.root, buffer.path, text, expected)
        .then((result): SaveResult => {
          if (result.ok) {
            patchModel(key, { type: 'saved', mtimeMs: result.mtimeMs });
            return 'saved';
          }
          patchModel(key, { type: 'save-conflict', mtimeMs: result.conflict.mtimeMs });
          return 'conflict';
        })
        .catch((error: unknown): SaveResult => {
          console.warn('[harnas] files.write', error);
          patchModel(key, { type: 'failed', code: decodeIpcError(error).code });
          return 'failed';
        })
        .finally(() => inFlightSaves.delete(key));
      inFlightSaves.set(key, done);
      return done;
    },

    revealAt: (workKey, tabId, line, col) =>
      set((state) => ({ reveals: { ...state.reveals, [bufferKey(workKey, tabId)]: { line, col } } })),
    takeReveal: (key) => {
      const reveal = get().reveals[key] ?? null;
      if (reveal !== null) set((state) => ({ reveals: omitKey(state.reveals, key) }));
      return reveal;
    },
  };
});

/** Ключи буферов всех вкладок file раскладок окна — тех, что сейчас есть в `layouts`. */
function liveBufferKeys(layouts: Record<string, WorkLayout>): Set<string> {
  const keys = new Set<string>();
  for (const [workKey, layout] of Object.entries(layouts)) {
    for (const group of groups(layout)) {
      for (const tab of group.tabs) if (tab.kind === 'file') keys.add(bufferKey(workKey, tab.id));
    }
  }
  return keys;
}

/** Грязные буферы окна: вопрос закрытия окна и счёт для main. */
export function dirtyBufferKeys(buffers: Record<string, FileBuffer>): string[] {
  return Object.keys(buffers).filter((key) => {
    const buffer = buffers[key];
    return buffer !== undefined && isBufferDirty(buffer.model);
  });
}

/** Имя файла буфера для вопроса «Save changes to …?». */
export function bufferName(key: string): string {
  const path = useFilesStore.getState().buffers[key]?.path ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Грязные буферы окна — для вопроса при закрытии окна. */
export function dirtyBufferRefs(): DirtyBufferRef[] {
  return dirtyBufferKeys(useFilesStore.getState().buffers).map((key) => ({ ...splitBufferKey(key), name: bufferName(key) }));
}

/**
 * Жизнь буферов: подписка на useLayoutStore — вкладки больше нет в layouts (requestCloseTabs, drop,
 * pruneLayout), и буфер отпускается с files.unwatch; files.onChanged разводится по буферам.
 *
 * Тем же подписчиком main узнаёт число грязных буферов (`app:dirty-buffers`, решение контролёра
 * по сверке этапа 7): на закрытии окна и ⌘Q он спрашивает, только если оно больше нуля.
 */
export function bindBuffersToLayouts(bridge: HarnasBridge): () => void {
  const release = (): void => {
    const live = liveBufferKeys(useLayoutStore.getState().layouts);
    const { buffers } = useFilesStore.getState();
    const gone = Object.keys(buffers).filter((key) => !live.has(key));
    if (gone.length === 0) return;
    for (const key of gone) {
      const watchId = buffers[key]?.watchId ?? null;
      if (watchId !== null) void bridge.files.unwatch(watchId).catch((error: unknown) => console.warn('[harnas] files.unwatch', error));
    }
    useFilesStore.setState((state) => {
      const next = { ...state.buffers };
      for (const key of gone) delete next[key];
      return { buffers: next, reveals: gone.reduce((acc, key) => omitKey(acc, key), state.reveals) };
    });
  };

  const unsubLayout = useLayoutStore.subscribe((state, prev) => {
    if (state.layouts !== prev.layouts) release();
  });

  // Тихая перезагрузка (спека 10.5): буфер без правок, файл изменился на диске. Читается заново,
  // и `reloaded` применяется, только если за время чтения человек не начал править.
  const reloading = new Map<string, number>();
  const reload = (key: string, buffer: FileBuffer): void => {
    const target = buffer.model.diskMtimeMs ?? 0;
    if (reloading.get(key) === target) return;
    reloading.set(key, target);
    bridge.files
      .readText(buffer.root, buffer.path)
      .then((file) => {
        const current = useFilesStore.getState().buffers[key];
        if (current?.model.status !== 'disk-changed-clean') return;
        useFilesStore.getState().dispatch(key, { type: 'reloaded', file, at: Date.now() });
      })
      .catch((error: unknown) => {
        if (decodeIpcError(error).code === 'not_found') useFilesStore.getState().dispatch(key, { type: 'disk-deleted' });
        else console.warn('[harnas] files.readText', error);
      })
      .finally(() => {
        if (reloading.get(key) === target) reloading.delete(key);
      });
  };

  let sentDirty = 0;
  const unsubFiles = useFilesStore.subscribe((state, prev) => {
    if (state.buffers === prev.buffers) return;
    for (const [key, buffer] of Object.entries(state.buffers)) {
      if (buffer.model.status !== 'disk-changed-clean') continue;
      const before = prev.buffers[key]?.model;
      if (before?.status !== 'disk-changed-clean' || before.diskMtimeMs !== buffer.model.diskMtimeMs) reload(key, buffer);
    }
    const dirty = dirtyBufferKeys(state.buffers).length;
    if (dirty !== sentDirty) {
      sentDirty = dirty;
      bridge.app.setDirtyBuffers(dirty);
    }
  });

  const unsubChanged = bridge.files.onChanged((event) => {
    const entry = Object.entries(useFilesStore.getState().buffers).find(([, buffer]) => buffer.watchId === event.id);
    if (entry === undefined) return;
    const [key] = entry;
    if (event.deleted || event.mtimeMs === null) useFilesStore.getState().dispatch(key, { type: 'disk-deleted' });
    else useFilesStore.getState().dispatch(key, { type: 'disk-changed', mtimeMs: event.mtimeMs });
  });

  // Раскладка могла измениться до подписки.
  release();

  return () => {
    unsubLayout();
    unsubFiles();
    unsubChanged();
  };
}

/** Корень по умолчанию: worktree сессии в фокусе (worktree.createdAt !== null), иначе проект. */
export function defaultRoot(entry: WorkEntry, focusedSessionId: string | null): FileRootSpec {
  const session = focusedSessionId === null ? undefined : entry.map.sessions.find((item) => item.id === focusedSessionId);
  // `createdAt: null` — worktree только запланирован, папки на диске ещё нет.
  if (session?.worktree !== null && session?.worktree !== undefined && session.worktree.createdAt !== null) {
    return { kind: 'worktree', sessionId: session.id };
  }
  return { kind: 'project' };
}

/** Корень «Файлов» работы: выбор человека, пока его нет — defaultRoot. Его же берут ⌘P и ⌘⇧F (7.4). */
export function filesRootSpec(
  rootByWork: FilesState['rootByWork'],
  entry: WorkEntry,
  focusedSessionId: string | null,
): FileRootSpec {
  return rootByWork[workKeyOf(entry.projectPath, entry.map.work.id)] ?? defaultRoot(entry, focusedSessionId);
}

/**
 * Папка корня на диске по снимку работ: проект — `projectPath`, worktree — `worktree.path` сессии.
 * null — сессии или её созданного worktree в снимке нет (корень исчез).
 */
export function rootDirOf(entry: WorkEntry, spec: FileRootSpec): string | null {
  if (spec.kind === 'project') return entry.projectPath;
  const worktree = entry.map.sessions.find((item) => item.id === spec.sessionId)?.worktree ?? null;
  return worktree === null || worktree.createdAt === null ? null : worktree.path;
}

/** Абсолютный путь файла корня: папка корня плюс относительный путь ('' — сама папка). */
export function absPathOf(entry: WorkEntry, spec: FileRootSpec, path: string): string | null {
  const dir = rootDirOf(entry, spec);
  if (dir === null) return null;
  if (path === '') return dir;
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${path}`;
}
