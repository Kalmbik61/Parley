/**
 * Переезд заметки по свежим строкам стороны (спека 11.4, кусок 8.4a): строки файла
 * сдвигаются правками агента, и заметка ищет свой якорь — текст строки startLine на момент
 * создания.
 */
import { NOTES_LIMITS, type DiffNote } from '../../../shared/notes-types.js';

/** Поиск якоря — ±20 строк (спека 11.4). */
const SEARCH_RADIUS = 20;

/**
 * Якорь длиннее предела хранится обрезанным (`store.ts#add`): такой сверяется с тем же
 * префиксом строки, иначе заметка к длинной строке устаревала бы сразу.
 */
function matches(line: string | undefined, anchor: string): boolean {
  if (line === undefined) return false;
  return anchor.length >= NOTES_LIMITS.anchor ? line.slice(0, NOTES_LIMITS.anchor) === anchor : line === anchor;
}

/**
 * Ищет anchor.text: своя строка → ±20 строк → не нашла (stale). Ближняя строка — первой, при
 * равном расстоянии — ниже: вставка выше заметки сдвигает её вниз чаще, чем удаление вверх.
 * Не нашла — позиция прежняя: заметка рисуется приглушённой на своём месте.
 */
export function relocate(note: DiffNote, lines: string[]): { startLine: number; endLine: number; stale: boolean } {
  const span = note.endLine - note.startLine;
  const at = (start: number): { startLine: number; endLine: number; stale: boolean } => ({
    startLine: start,
    endLine: start + span,
    stale: false,
  });
  const text = note.anchor.text;
  if (matches(lines[note.startLine - 1], text)) return at(note.startLine);
  for (let distance = 1; distance <= SEARCH_RADIUS; distance += 1) {
    for (const start of [note.startLine + distance, note.startLine - distance]) {
      if (start >= 1 && matches(lines[start - 1], text)) return at(start);
    }
  }
  return { startLine: note.startLine, endLine: note.endLine, stale: true };
}
