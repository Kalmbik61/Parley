/**
 * Данные «Изменений» без разметки (кусок 8.2a, спека 11.1, 11.2, 13): источник
 * изменений сессии, таблица главной кнопки, секции файлов и тексты. Вкладка
 * «Изменения» (8.2b) и вкладка диффа (8.3) рисуют по ним, а не решают сами.
 */

import type { DiffFile, MergeCheck, MergeResult, ProjectChanges, WorktreeDiff } from '@harnas/core';
import { HOST_ERROR_REASONS } from '@harnas/protocol';
import type { IpcErrorInfo } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';

export type ChangesSource =
  /**
   * `branch` и `base` — из `WorktreeInfo` сессии: в `WorktreeDiff` имени базы нет, а
   * кнопке «Слить в master» и тексту агенту оно нужно.
   */
  | { kind: 'worktree'; branch: string; base: string; diff: WorktreeDiff; check: MergeCheck | null }
  | { kind: 'project'; changes: ProjectChanges }
  /** Worktree запланирован (`createdAt: null`): вызовов нет. */
  | { kind: 'pending' };

export type PrimaryAction =
  | { kind: 'commit-project' }
  | { kind: 'commit' }
  | { kind: 'merge'; base: string }
  | { kind: 'ask-agent'; files: string[] }
  | { kind: 'nothing' };

/** Таблица спеки 11.2; check: null (ещё не пришёл, не звали или отказал) — как unsupported. */
export function primaryActionFor(source: ChangesSource): PrimaryAction {
  if (source.kind === 'pending') return { kind: 'nothing' };
  if (source.kind === 'project') return source.changes.files.length > 0 ? { kind: 'commit-project' } : { kind: 'nothing' };
  // Незакоммиченное — коммит и при конфликтах: слияние всё равно откажет `uncommitted`.
  if (source.diff.uncommitted) return { kind: 'commit' };
  if (source.diff.commits.length === 0) return { kind: 'nothing' };
  if (source.check?.status === 'conflicts') return { kind: 'ask-agent', files: source.check.files };
  // clean, unsupported и null: конфликт узнаётся при слиянии, как сейчас.
  return { kind: 'merge', base: source.base };
}

/**
 * Секции файлов: uncommitted — files с путём из uncommittedPaths (у project — все files), branch — остальные.
 * `files` — всё отличие от `mergeBase`, а `uncommitted` — один флаг на весь дифф: секция из `files`
 * не пустела бы после коммита. Путь из `uncommittedPaths` без записи в `files` (правка вернула
 * файл к `mergeBase`) не показывается — кнопку держит `uncommitted`.
 *
 * `moreUntracked` (раунд fix-final-c, п. 1): неотслеживаемые сверх предела хоста —
 * `uncountedUntracked` последних записей `files`, без чисел. Строк им нет: их заменяет одна строка
 * «+N more untracked». Старый хост поля не шлёт — 0.
 */
export function changesSections(source: ChangesSource): { uncommitted: DiffFile[]; branch: DiffFile[]; moreUntracked: number } {
  if (source.kind === 'pending') return { uncommitted: [], branch: [], moreUntracked: 0 };
  if (source.kind === 'project') {
    const more = Math.min(source.changes.uncountedUntracked ?? 0, source.changes.files.length);
    return { uncommitted: source.changes.files.slice(0, source.changes.files.length - more), branch: [], moreUntracked: more };
  }
  const dirty = new Set(source.diff.uncommittedPaths);
  const more = Math.min(source.diff.uncountedUntracked ?? 0, source.diff.files.length);
  const listed = source.diff.files.slice(0, source.diff.files.length - more);
  const uncommitted: DiffFile[] = [];
  const branch: DiffFile[] = [];
  for (const file of listed) (dirty.has(file.path) ? uncommitted : branch).push(file);
  return { uncommitted, branch, moreUntracked: more };
}

/** Тост ответа worktrees.merge — таблица спеки 11.2; conflicts — файлы для секции «Конфликты». */
export function mergeResultText(result: MergeResult, base: string): { text: string; conflicts: string[] | null } {
  if (result.ok) return { text: S.changes.merged(base), conflicts: null };
  switch (result.reason) {
    case 'base_not_checked_out':
      return { text: S.changes.mergeFailed.baseNotCheckedOut(base), conflicts: null };
    case 'base_dirty':
      return { text: S.changes.mergeFailed.baseDirty(base), conflicts: null };
    case 'uncommitted':
      return { text: S.changes.mergeFailed.uncommitted, conflicts: null };
    case 'conflict':
      return { text: S.changes.mergeFailed.conflict(result.files.join(', ')), conflicts: result.files };
  }
}

/** Текст спеки 11.2 для «Попросить агента разрешить» — английский шаблон из S. */
export function askAgentText(branch: string, base: string, files: string[]): string {
  return [S.changes.askAgentIntro(branch, base), ...files.map((file) => `- ${file}`), S.changes.askAgentInstruction(base)].join('\n');
}

/** Тело вкладки при отказе загрузки: git-missing — S.changes.gitMissing, not-a-repo — S.changes.notARepo, worktree-corrupt — S.changes.worktreeCorrupt, прочее — errorText(code, S.errors.actions.loadChanges). */
export function changesErrorText(error: IpcErrorInfo): string {
  // Сообщение хоста — русский текст рантайма: человеку — только свой английский.
  console.warn('[harnas] changes', error.code, error.message);
  const reason = error.data?.['reason'];
  if (reason === HOST_ERROR_REASONS.gitMissing) return S.changes.gitMissing;
  if (reason === HOST_ERROR_REASONS.notARepo) return S.changes.notARepo;
  if (reason === HOST_ERROR_REASONS.worktreeCorrupt) return S.changes.worktreeCorrupt;
  return errorText(error.code, S.errors.actions.loadChanges);
}

/** Предел `pty.send` (5.1): больше хост ответил бы `bad_request`, и тост сказал бы только «failed». */
const SEND_LIMIT_BYTES = 65_536;

/** Текст влезает в один pty.send: UTF-8 не больше 65 536 байт (5.1). */
export function fitsSendLimit(text: string): boolean {
  return new TextEncoder().encode(text).length <= SEND_LIMIT_BYTES;
}
