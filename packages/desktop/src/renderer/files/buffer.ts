/**
 * Буфер файла — машина состояний спеки 10.5 (кусок 7.3a). Чистая: стор (`files/store.ts`)
 * держит модели и зовёт мост, редактор (7.3b) только показывает `bufferView` и шлёт правки.
 *
 * Состояния спеки — `clean`, `dirty`, `disk-changed-clean`, `disk-changed-dirty`, `deleted`;
 * служебные — `loading`, `saving`, `error`. Правка агента на диске молча не перетирается: при
 * правках человека буфер уходит в `disk-changed-dirty`, и решает человек.
 */

import type { TextFile } from '../../shared/files-types.js';

/** Ключ буфера и точки «не сохранён»: у двух работ одного проекта id вкладки `file:p:src/a.ts` одинаковый. */
export function bufferKey(workKey: string, tabId: string): string {
  return `${workKey}\0${tabId}`;
}

/** Обратно к работе и вкладке: NUL не бывает ни в пути проекта, ни в id работы. */
export function splitBufferKey(key: string): { workKey: string; tabId: string } {
  const cut = key.indexOf('\0');
  return { workKey: key.slice(0, cut), tabId: key.slice(cut + 1) };
}

export type BufferStatus =
  | 'loading'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'disk-changed-clean'
  | 'disk-changed-dirty'
  | 'deleted'
  | 'error';

export interface BufferModel {
  status: BufferStatus;
  text: string;
  savedText: string;
  mtimeMs: number | null;
  diskMtimeMs: number | null;
  /** mtime последней своей записи: её эхо слежения пропускается. */
  ownWriteMtimeMs: number | null;
  /** Событие, пришедшее во время saving. */
  pendingDiskMtimeMs: number | null;
  readOnlyReason: 'too-large' | 'not-utf8' | null;
  keepMine: boolean;
  /** Код decodeIpcError; слова — у FileBody (7.3b). */
  errorCode: string | null;
  /** Тихая перезагрузка: плашка «Обновлён с диска» 2 с. */
  reloadedAt: number | null;
  /**
   * Текст, ушедший в `write` (дополнение плана): правка во время `saving` остаётся правкой, а
   * сохранённым после `saved` считается записанное, а не то, что в буфере к ответу.
   */
  savingText: string | null;
}

export type BufferEvent =
  | { type: 'loaded'; file: TextFile }
  | { type: 'edited'; text: string }
  /** Во время saving — пропускается. */
  | { type: 'save-started' }
  | { type: 'saved'; mtimeMs: number }
  /** write ответил conflict. */
  | { type: 'save-conflict'; mtimeMs: number }
  | { type: 'disk-changed'; mtimeMs: number }
  | { type: 'disk-deleted' }
  | { type: 'reloaded'; file: TextFile; at: number }
  | { type: 'keep-mine' }
  /** При loading — error; при saving — назад в dirty. */
  | { type: 'failed'; code: string };

/** Плашка «Обновлён с диска» — 2 с (спека 10.5). */
export const RELOADED_FLASH_MS = 2000;

export function initialBuffer(): BufferModel {
  return {
    status: 'loading',
    text: '',
    savedText: '',
    mtimeMs: null,
    diskMtimeMs: null,
    ownWriteMtimeMs: null,
    pendingDiskMtimeMs: null,
    readOnlyReason: null,
    keepMine: false,
    errorCode: null,
    reloadedAt: null,
    savingText: null,
  };
}

/** Несохранённые правки человека: точка вкладки, вопрос закрытия и счёт для main. */
export function isBufferDirty(model: BufferModel): boolean {
  return model.status !== 'loading' && model.status !== 'error' && model.text !== model.savedText;
}

function fromDisk(model: BufferModel, file: TextFile): BufferModel {
  return {
    ...model,
    status: 'clean',
    text: file.text,
    savedText: file.text,
    mtimeMs: file.mtimeMs,
    diskMtimeMs: file.mtimeMs,
    pendingDiskMtimeMs: null,
    readOnlyReason: file.readOnlyReason,
    keepMine: false,
    errorCode: null,
    savingText: null,
  };
}

/** Диск изменился (спека 10.5): эхо своей записи и повтор уже известного mtime — не изменение. */
function diskChanged(model: BufferModel, mtimeMs: number): BufferModel {
  if (model.ownWriteMtimeMs !== null && mtimeMs <= model.ownWriteMtimeMs) return model;
  const edited = model.text !== model.savedText;
  switch (model.status) {
    case 'clean':
    case 'dirty':
      if (mtimeMs === model.diskMtimeMs) return model;
      return { ...model, status: edited ? 'disk-changed-dirty' : 'disk-changed-clean', diskMtimeMs: mtimeMs, keepMine: false };
    case 'disk-changed-clean':
    case 'disk-changed-dirty':
      return mtimeMs === model.diskMtimeMs ? model : { ...model, diskMtimeMs: mtimeMs };
    case 'deleted':
      // Файл появился снова (например, `git checkout` агента) — как изменение на диске.
      return { ...model, status: edited ? 'disk-changed-dirty' : 'disk-changed-clean', diskMtimeMs: mtimeMs };
    case 'saving':
      // Ответ `write` ещё не пришёл: применится после него, только если новее записанного.
      return { ...model, pendingDiskMtimeMs: Math.max(model.pendingDiskMtimeMs ?? mtimeMs, mtimeMs) };
    case 'loading':
    case 'error':
      return model;
  }
}

/** Конец записи: отложенное событие диска применяется к уже новой модели. */
function afterSave(model: BufferModel, pending: number | null): BufferModel {
  const next = { ...model, pendingDiskMtimeMs: null };
  return pending === null ? next : diskChanged(next, pending);
}

export function bufferReducer(model: BufferModel, event: BufferEvent): BufferModel {
  switch (event.type) {
    case 'loaded':
      if (model.status !== 'loading' && model.status !== 'error') return model;
      return fromDisk(model, event.file);
    case 'edited': {
      if (model.status === 'loading' || model.status === 'error' || model.readOnlyReason !== null) return model;
      if (event.text === model.text) return model;
      const edited = event.text !== model.savedText;
      switch (model.status) {
        case 'clean':
        case 'dirty':
          return { ...model, text: event.text, status: edited ? 'dirty' : 'clean' };
        case 'disk-changed-clean':
        case 'disk-changed-dirty':
          return { ...model, text: event.text, status: edited ? 'disk-changed-dirty' : 'disk-changed-clean' };
        case 'saving':
        case 'deleted':
          return { ...model, text: event.text };
      }
      return model;
    }
    case 'save-started':
      if (model.status === 'saving' || model.status === 'loading' || model.status === 'error') return model;
      return { ...model, status: 'saving', savingText: model.text };
    case 'saved': {
      if (model.status !== 'saving') return model;
      const written = model.savingText ?? model.text;
      const saved: BufferModel = {
        ...model,
        status: model.text === written ? 'clean' : 'dirty',
        savedText: written,
        mtimeMs: event.mtimeMs,
        diskMtimeMs: event.mtimeMs,
        ownWriteMtimeMs: event.mtimeMs,
        keepMine: false,
        errorCode: null,
        savingText: null,
      };
      return afterSave(saved, model.pendingDiskMtimeMs);
    }
    case 'save-conflict':
      if (model.status !== 'saving') return model;
      // Диск изменился после открытия: решение — за человеком (баннер и сравнение — 7.3b).
      return { ...model, status: 'disk-changed-dirty', diskMtimeMs: event.mtimeMs, pendingDiskMtimeMs: null, keepMine: false, savingText: null };
    case 'disk-changed':
      return diskChanged(model, event.mtimeMs);
    case 'disk-deleted':
      // Во время записи удаление не применяется: наш `rename` файл и создаст.
      if (model.status === 'loading' || model.status === 'error' || model.status === 'saving') return model;
      // mtimeMs — null: следующая запись создаёт файл (`expectedMtimeMs: null`).
      return { ...model, status: 'deleted', mtimeMs: null, diskMtimeMs: null, keepMine: false };
    case 'reloaded':
      if (model.status === 'loading' || model.status === 'saving') return model;
      return { ...fromDisk(model, event.file), reloadedAt: event.at };
    case 'keep-mine':
      if (model.status !== 'disk-changed-dirty') return model;
      return { ...model, status: 'dirty', keepMine: true };
    case 'failed':
      if (model.status === 'loading') return { ...model, status: 'error', errorCode: event.code };
      if (model.status === 'saving') {
        return afterSave({ ...model, status: 'dirty', savingText: null }, model.pendingDiskMtimeMs);
      }
      return model;
  }
}

/** Что показать: баннер, диалог перед записью, плашку «Обновлён с диска» (2 с после reloadedAt). */
export function bufferView(
  model: BufferModel,
  now: number,
): { banner: 'none' | 'disk-changed' | 'deleted'; confirmOverwrite: boolean; reloadedFlash: boolean } {
  const banner = model.status === 'disk-changed-dirty' ? 'disk-changed' : model.status === 'deleted' ? 'deleted' : 'none';
  const reloadedFlash = model.reloadedAt !== null && now >= model.reloadedAt && now - model.reloadedAt < RELOADED_FLASH_MS;
  return { banner, confirmOverwrite: model.keepMine, reloadedFlash };
}
