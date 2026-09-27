/**
 * Стор вкладки «Файлы» правого сайдбара (кусок 7.2, спека 10.1): выбор корня человеком и
 * раскрытые папки. Буферы добавит 7.3a, режим поиска — 7.4. Содержимое папок здесь не
 * хранится: его держит само дерево (`files/Tree.tsx`) — оно живёт, пока панель открыта, и
 * перечитывает папки по событиям слежения.
 *
 * Ключ корня — `rootKey` из `shared/work-keys.ts` (5.2), своего нет: тот же ключ у main и в
 * событиях `treeChanged`.
 */

import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import type { FileRootSpec } from '../../shared/layout-types.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';

export interface FilesState {
  /** Выбор человека в `RootPicker` по `workKey`; пока его нет — `defaultRoot`. */
  rootByWork: Record<string, FileRootSpec>;
  /** Раскрытые папки по `rootKey`: относительные пути, '' — корень (он раскрыт всегда). */
  expanded: Record<string, Set<string>>;
  setRoot(workKey: string, spec: FileRootSpec): void;
  toggleDir(rootKey: string, dir: string): void;
}

export const useFilesStore = create<FilesState>((set) => ({
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
}));

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
