/**
 * Отправка заметок агенту (кусок 8.4b, спека 11.4): одна заметка, заметки файла или все
 * неотправленные — одним текстом `formatNotes` через `sendWithToast` (5.4, таблица тостов 8.6).
 *
 * - Текст длиннее предела `pty.send` (64 КиБ UTF-8) не уходит: тост `S.send.tooLong` (сверка M10).
 * - Исход каждой попытки — первой и каждого Retry тоста — доходит до `applyOutcome`: `sentAt`
 *   ставит только вставка, `blocked`, `busy` и `no-paste-mode` оставляют заметки неотправленными.
 * - Одно нажатие — одно действие: пока первая попытка тех же заметок не ответила, повтор (двойной
 *   клик) ничего не шлёт — `pty.send` не идемпотентен (как «Send» `AskAgentDialog`, fix-8).
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

/** Неотправленные и неустаревшие — пакет «Send file notes» и «Send all unsent». */
export function batchable(notes: DiffNote[]): DiffNote[] {
  return notes.filter((note) => note.sentAt === null && !note.stale);
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
  const deps: SendWithToastDeps = {
    ...input.deps,
    onOutcome: (outcome) => {
      input.deps.onOutcome?.(outcome);
      useNotesStore.getState().applyOutcome(input.workKey, input.sessionId, ids, input.to, outcome);
    },
  };
  for (const key of keys) inFlight.add(key);
  void sendWithToast(deps, ref, text, true).finally(() => {
    for (const key of keys) inFlight.delete(key);
  });
}
