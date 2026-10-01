/**
 * Стороны файла вкладки диффа (кусок 8.3, спека 11.3): что показывает Monaco слева и справа.
 * Ветка — версия в `mergeBase` против рабочего дерева; коммит — родитель против самого коммита.
 * Большой и двоичный файл не уходят в редактор: заглушка, а у текстового — «Show anyway».
 */

import type { ParleyBridge } from '../../shared/bridge.js';
import type { DiffFile, FileRoot, TextFile } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

export interface DiffSides {
  original: string | null;
  modified: string | null;
  tooLarge: boolean;
  binary: boolean;
}

/** Таблица чисел плана: живых редакторов не больше 20, файл больше 1 МБ — заглушка. */
export const DIFF_LIMITS = { maxEditors: 20, maxFileBytes: 1024 * 1024 } as const;

type FilesApi = Pick<ParleyBridge['files'], 'gitShow' | 'readText'>;

/** Отказ `files:too-large` (больше 20 МБ, 7.1a) — не ошибка вкладки, а заглушка большого файла. */
const TOO_LARGE = Symbol('too-large');

async function side(read: Promise<TextFile | null>): Promise<TextFile | null | typeof TOO_LARGE> {
  try {
    return await read;
  } catch (error) {
    if (decodeIpcError(error).code === 'files:too-large') return TOO_LARGE;
    throw error;
  }
}

/**
 * Стороны файла: ветка — base ↔ рабочее дерево (base — mergeBase, у сессии без worktree — 'HEAD');
 * коммит — родитель ↔ коммит; R — original по oldPath.
 */
export async function loadSides(input: {
  files: FilesApi;
  root: FileRoot;
  file: DiffFile;
  mode: { kind: 'branch'; base: string } | { kind: 'commit'; hash: string };
}): Promise<DiffSides> {
  const { files, root, file, mode } = input;
  const before = mode.kind === 'branch' ? mode.base : `${mode.hash}^`;
  // У A левой стороны нет, у D — правой: лишний вызов дал бы null или `not_found`.
  const original = file.status === 'A' ? null : side(files.gitShow(root, before, file.oldPath ?? file.path));
  const modified =
    file.status === 'D'
      ? null
      : side(mode.kind === 'branch' ? files.readText(root, file.path) : files.gitShow(root, mode.hash, file.path));
  const [left, right] = await Promise.all([original, modified]);
  if (left === TOO_LARGE || right === TOO_LARGE) {
    // Текста стороны больше 20 МБ нет вовсе: «Show anyway» показал бы пустую сторону — без текста обеих.
    return { original: null, modified: null, tooLarge: true, binary: false };
  }
  // Корневой коммит: `hash^` нет — `gitShow` отдаёт null, сторона пустая.
  const binary = left?.binary === true || right?.binary === true;
  const tooLarge = (left?.size ?? 0) > DIFF_LIMITS.maxFileBytes || (right?.size ?? 0) > DIFF_LIMITS.maxFileBytes;
  return { original: left?.text ?? null, modified: right?.text ?? null, tooLarge, binary };
}
