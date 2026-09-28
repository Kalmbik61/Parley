/**
 * Текст заметок агенту (спека 11.4, кусок 8.4a): один блок на отправку. Шаблон — английский из
 * `S.notes` (сверка этапа 8, I1): текст видно и можно править в окне, а русский литерал страж
 * `english-ui` не пропустит. Путь и текст заметки — данные, идут как есть, с переводами строк.
 */
import type { DiffNote } from '../../../shared/notes-types.js';
import { S } from '../../../shared/strings.js';

function block(note: DiffNote): string {
  const lines = [
    S.notes.file(note.path),
    note.startLine === note.endLine ? S.notes.line(note.startLine) : S.notes.lines(note.startLine, note.endLine),
  ];
  if (note.side === 'original') lines.push(S.notes.sideOriginal);
  lines.push(S.notes.note(note.body));
  return lines.join('\n');
}

/** Порядок — по файлу, потом по строке: сравнение путей по кодовым единицам, без локали — одинаково на любой машине. */
export function formatNotes(input: { sessionLabel: string; branch: string | null; notes: DiffNote[] }): string {
  const sorted = [...input.notes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.startLine - b.startLine;
  });
  return [S.notes.header(input.sessionLabel, input.branch), '', sorted.map(block).join('\n\n')].join('\n');
}
