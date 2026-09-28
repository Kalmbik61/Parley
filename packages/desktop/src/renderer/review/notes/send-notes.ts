/**
 * Отправка заметок агенту (кусок 8.4b, спека 11.4): одна заметка, заметки файла или все
 * неотправленные — одним текстом `formatNotes` через `sendWithToast` (5.4, таблица тостов 8.6).
 *
 * - Текст длиннее предела `pty.send` (64 КиБ UTF-8) не уходит: тост `S.send.tooLong` (сверка M10).
 * - Исход каждой попытки — первой и каждого Retry тоста — доходит до `applyOutcome`: `sentAt`
 *   ставит только вставка, `blocked`, `busy` и `no-paste-mode` оставляют заметки неотправленными.
 * - Одно нажатие — одно действие: пока первая попытка тех же заметок не ответила, повтор (двойной
 *   клик) ничего не шлёт — `pty.send` не идемпотентен (как «Send» `AskAgentDialog`, fix-8).
 * - Одна незавершённая отправка на заметку (раунд fix-8.4b, п. 3): у тоста набора постоянный id —
 *   новая попытка заменяет прежний тост. Новое нажатие «Send» (карточка, ▾, «Send file notes»,
 *   «Send all unsent») с теми же заметками гасит их прежний «Retry» (тост другого набора снимается,
 *   своего — заменяется исходом новой попытки): его повтор больше ничего не шлёт. «Retry» — сам явное нажатие: шлёт, только пока его тост — последний для всех своих заметок
 *   и ни одна из них не в полёте.
 *
 * Зовут её только нажатия человека: ни загрузка, ни переезд, ни сохранение заметки (рамка 15.1).
 */

import { toast } from 'sonner';
import type { DiffNote } from '../../../shared/notes-types.js';
import { S } from '../../../shared/strings.js';
import { sessionTag } from '../../lib/participant.js';
import { sendWithToast, type SendWithToastDeps } from '../../terminal/send.js';
import { fitsSendLimit } from '../state.js';
import { formatNotes } from './format.js';
import { notesKey, useNotesStore } from './store.js';

export interface SendNotesInput {
  deps: SendWithToastDeps;
  projectPath: string;
  workId: string;
  /** Работа и сессия диффа — владелец заметок (ключ стора) и ярлык в заголовке текста. */
  workKey: string;
  sessionId: string;
  branch: string | null;
  notes: DiffNote[];
  /** Получатель — выбор `SendMenu`. */
  to: string;
}

/** Заметки, чья отправка ещё не ответила: `notesKey` + id. */
const inFlight = new Set<string>();
/** Тост с «Retry» по заметке (`notesKey` + id): чей повтор ещё в силе. */
const retryable = new Map<string, string>();

/** Неотправленные и неустаревшие — пакет «Send file notes» и «Send all unsent». */
export function batchable(notes: DiffNote[]): DiffNote[] {
  return notes.filter((note) => note.sentAt === null && !note.stale);
}

/**
 * Повторы тостов этих заметок больше ничего не шлют; чужие тосты сняты. Свой (`keep`) не снимается:
 * его заменит тост новой попытки — sonner слил бы новый тост с уже снимаемым и потерял его.
 */
function supersede(keys: string[], keep: string): void {
  const stale = new Set<string>();
  for (const key of keys) {
    const id = retryable.get(key);
    if (id !== undefined) stale.add(id);
  }
  for (const [key, id] of retryable) if (stale.has(id)) retryable.delete(key);
  for (const id of stale) if (id !== keep) toast.dismiss(id);
}

export function sendNotes(input: SendNotesInput): void {
  const { notes } = input;
  if (notes.length === 0) return;
  const owner = notesKey(input.workKey, input.sessionId);
  const keys = notes.map((note) => `${owner}\0${note.id}`);
  if (keys.some((key) => inFlight.has(key))) return;
  const text = formatNotes({ sessionLabel: sessionTag(input.sessionId), branch: input.branch, notes });
  if (!fitsSendLimit(text)) {
    // Хост ответил бы bad_request, и тост сказал бы только «failed»: предел — до вызова.
    toast.error(S.send.tooLong);
    return;
  }
  const ids = notes.map((note) => note.id);
  const ref = { projectPath: input.projectPath, workId: input.workId, sessionId: input.to };
  // Один id на набор: владелец, получатель и заметки.
  const toastId = `notes-send:${owner}\0${input.to}\0${ids.join(',')}`;

  const attempt = (): void => {
    for (const key of keys) inFlight.add(key);
    const deps: SendWithToastDeps = {
      ...input.deps,
      toastId,
      retry: () => {
        // Повтор жив, только пока его тост — последний для всех его заметок и они не в полёте.
        if (keys.some((key) => inFlight.has(key) || retryable.get(key) !== toastId)) return;
        supersede(keys, toastId);
        attempt();
      },
      onOutcome: (outcome) => {
        input.deps.onOutcome?.(outcome);
        useNotesStore.getState().applyOutcome(input.workKey, input.sessionId, ids, input.to, outcome);
        // «Retry» у тоста — только при busy (таблица 8.6): тогда его повтор в силе.
        if (!('error' in outcome) && outcome.reason === 'busy') for (const key of keys) retryable.set(key, toastId);
      },
    };
    void sendWithToast(deps, ref, text, true).finally(() => {
      for (const key of keys) inFlight.delete(key);
    });
  };

  supersede(keys, toastId);
  attempt();
}
