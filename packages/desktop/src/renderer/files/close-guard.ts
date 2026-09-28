/**
 * Вопрос о несохранённых буферах (кусок 7.3a, спека 10.4): при закрытии вкладок — `CloseGuard`
 * для `requestCloseTabs` (2.2), при закрытии окна — ответ на `app:confirm-close` main.
 *
 * Ответы применяются, когда получены все: «Не сохранять» на A и «Отмена» на B, применённые по
 * одному, отбросили бы правки A, а вкладка A осталась бы открытой. «Отмена» на любой — ни одна
 * вкладка не закрыта, ничего не записано и не отброшено.
 */

import type { FileRootSpec, WorkLayout } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import type { CloseGuard } from '../layout/store.js';
import { groups } from '../layout/tree.js';

export type SaveAnswer = 'save' | 'discard' | 'cancel';

/** CloseGuard (2.2): среди закрываемых — вкладки file с грязным буфером; вопрос по каждой, ответы — после всех. */
export function createCloseGuard(deps: {
  isDirty(workKey: string, tabId: string): boolean;
  /** SaveChangesDialog. */
  ask(workKey: string, tabId: string): Promise<SaveAnswer>;
  /** false — конфликт или ошибка записи. */
  save(workKey: string, tabId: string): Promise<boolean>;
}): CloseGuard {
  return async (workKey, tabIds) => {
    // Буфер бывает только у вкладки file: у прочих видов стор и не спрашивается.
    const dirty = tabIds.filter((tabId) => tabId.startsWith('file:') && deps.isDirty(workKey, tabId));
    const toSave: string[] = [];
    for (const tabId of dirty) {
      const answer = await deps.ask(workKey, tabId);
      if (answer === 'cancel') return false;
      if (answer === 'save') toSave.push(tabId);
    }
    // Конфликт или ошибка — закрытие отменено: буфер конфликта уже в disk-changed-dirty, баннер и
    // сравнение — у его тела (7.3b). Правка агента молча не перетирается.
    for (const tabId of toSave) {
      if (!(await deps.save(workKey, tabId))) return false;
    }
    return true;
  };
}

export interface DirtyBufferRef {
  workKey: string;
  tabId: string;
  /** Имя файла для вопроса. */
  name: string;
}

/**
 * Закрытие окна и ⌘Q (решение контролёра по сверке этапа 7): main спросил `app:confirm-close`,
 * ответ — `close` или `cancel`. Грязных нет — `close` без вопроса. «Save all» закрывает окно,
 * только если удались все записи; иначе окно остаётся с тостом — правки не теряются молча.
 */
export async function answerWindowClose(deps: {
  dirty(): DirtyBufferRef[];
  ask(names: string[]): Promise<SaveAnswer>;
  save(workKey: string, tabId: string): Promise<boolean>;
  toast(text: string): void;
}): Promise<'close' | 'cancel'> {
  const dirty = deps.dirty();
  if (dirty.length === 0) return 'close';
  const answer = await deps.ask(dirty.map((item) => item.name));
  if (answer === 'cancel') return 'cancel';
  if (answer === 'discard') return 'close';
  let allSaved = true;
  // Грязные — заново, после ответа: пока вопрос окна ждал в очереди за вопросом вкладки, тот мог
  // сохранить или отбросить файл и отпустить буфер. Такой файл — не ошибка записи (fix-7.3 п. 3).
  const still = new Set(deps.dirty().map((item) => `${item.workKey}\n${item.tabId}`));
  // Все записи по очереди, а не до первой ошибки: что сохранилось — сохранено.
  for (const item of dirty.filter((entry) => still.has(`${entry.workKey}\n${entry.tabId}`))) {
    if (!(await deps.save(item.workKey, item.tabId))) allSaved = false;
  }
  if (allSaved) return 'close';
  deps.toast(S.files.saveAllFailed);
  return 'cancel';
}

/**
 * Работа исчезла из снимка не через меню этого окна (удалил другой клиент — fix-7.3 п. 1): отменить
 * это нельзя, поэтому вопрос без «Отмены» — «Save» или «Discard», но не молча. «Save» пишет что
 * может (папка проекта обычно цела); что не записалось (папки worktree больше нет, конфликт) —
 * тостом по именам: правка теряется, но человек об этом знает.
 */
export async function answerVanishedWork(deps: {
  dirty: DirtyBufferRef[];
  ask(names: string[]): Promise<'save' | 'discard'>;
  save(workKey: string, tabId: string): Promise<boolean>;
  toast(text: string): void;
}): Promise<void> {
  if (deps.dirty.length === 0) return;
  if ((await deps.ask(deps.dirty.map((item) => item.name))) === 'discard') return;
  const failed: string[] = [];
  for (const item of deps.dirty) {
    if (!(await deps.save(item.workKey, item.tabId))) failed.push(item.name);
  }
  if (failed.length > 0) deps.toast(S.files.notSaved(failed.join(', ')));
}

/**
 * Вкладки file раскладки, чей корень подходит (кусок 7.3a): «Delete…» работы закрывает их все, а
 * «Delete» сессии — вкладки её worktree, через `requestCloseTabs` — с вопросом о правках. Раскладка
 * не гидрирована — ни вкладок, ни буферов, вопроса нет.
 */
export function fileTabIds(layout: WorkLayout | undefined, match: (root: FileRootSpec) => boolean): string[] {
  if (layout === undefined) return [];
  return groups(layout).flatMap((group) => group.tabs.filter((tab) => tab.kind === 'file' && match(tab.root)).map((tab) => tab.id));
}
