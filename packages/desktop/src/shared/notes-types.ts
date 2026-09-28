/**
 * Заметки к строкам диффа (спека 11.4, кусок 8.4a). Тип здесь, а не в рендерере: его берут
 * мост, main (`notes-store.ts`, проверка аргументов `app:save-notes`) и рендерер, а
 * `tsconfig.node.json` импорт из `renderer/` не пропустит.
 */
import { isSessionId } from './work-keys.js';

export interface DiffNote {
  /** 8 hex. */
  id: string;
  /** Путь в worktree (или в проекте). */
  path: string;
  side: 'modified' | 'original';
  /** 1-based, включительно. */
  startLine: number;
  endLine: number;
  /** 1..4000 символов. */
  body: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** sessionId получателя. */
  sentTo: string | null;
  /** Текст строки startLine на момент создания — по нему заметка переезжает (`review/notes/anchor.ts`). */
  anchor: { text: string };
  stale: boolean;
}

export interface NotesFile {
  version: 1;
  notes: DiffNote[];
}

/** Пределы файла заметок сессии (план, «Числа»): у спеки есть только 1..4000 тела. */
export const NOTES_LIMITS = { notes: 1000, fileBytes: 1024 * 1024, body: 4000, anchor: 4000 } as const;

const NOTE_ID = /^[0-9a-f]{8}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLine(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isDiffNote(value: unknown): value is DiffNote {
  if (!isRecord(value)) return false;
  const { anchor, body, sentAt, sentTo } = value;
  return (
    typeof value.id === 'string' &&
    NOTE_ID.test(value.id) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    (value.side === 'modified' || value.side === 'original') &&
    isLine(value.startLine) &&
    isLine(value.endLine) &&
    value.startLine <= value.endLine &&
    typeof body === 'string' &&
    body.length >= 1 &&
    body.length <= NOTES_LIMITS.body &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (sentAt === null || typeof sentAt === 'string') &&
    // sentTo — тоже sessionId: окно берёт его в ярлык и ищет сессию по нему, чужого формата не ждёт.
    (sentTo === null || (typeof sentTo === 'string' && isSessionId(sentTo))) &&
    isRecord(anchor) &&
    typeof anchor.text === 'string' &&
    anchor.text.length <= NOTES_LIMITS.anchor &&
    typeof value.stale === 'boolean'
  );
}

/**
 * Форма `NotesFile` спеки 11.4 с пределами `NOTES_LIMITS`; sentTo — isSessionId или null,
 * startLine ≤ endLine. Размер — байты UTF-8 компактного JSON: ровно так его пишет
 * `main/notes-store.ts`, и принятый здесь файл при чтении не окажется «больше 1 МБ».
 */
export function isNotesFile(value: unknown): value is NotesFile {
  if (!isRecord(value) || value.version !== 1) return false;
  const { notes } = value;
  if (!Array.isArray(notes) || notes.length > NOTES_LIMITS.notes || !notes.every(isDiffNote)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= NOTES_LIMITS.fileBytes;
}
