/**
 * Журнал почты Parley (спека 2026-11-12, 3.2a): `<работа>/mail/<сессия>.jsonl`, по строке `{at, text}` на каждую доставку
 * письма вместе с указателем. Нужен лента при севе: Claude Code может не записать контекст хука, а письма должны остаться.
 * Отдельно от `events/`: маленький файл, читается целиком, метрики его не видят.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { workPaths } from '@parley/core';
import type { MailJournalEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';

const fileOf = (ref: SessionRef): string => path.join(workPaths(ref.projectPath, ref.workId).mail, `${ref.sessionId}.jsonl`);

/** Дописывает строку журнала; каталог создаётся. Синхронно: запись короткая и должна лечь до ответа хуку. Сбой — исключение. */
export function appendMailJournal(ref: SessionRef, entry: MailJournalEntry): void {
  const file = fileOf(ref);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: entry.at, text: entry.text })}\n`, 'utf8');
}

/** Строки журнала сессии; нет файла, битая строка — пропуск. */
export async function readMailJournal(ref: SessionRef): Promise<MailJournalEntry[]> {
  let raw: string;
  try {
    raw = await readFile(fileOf(ref), 'utf8');
  } catch {
    return [];
  }
  const entries: MailJournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null && typeof (value as { at?: unknown }).at === 'string' && typeof (value as { text?: unknown }).text === 'string') {
        entries.push({ at: (value as MailJournalEntry).at, text: (value as MailJournalEntry).text });
      }
    } catch {
      /* битая строка — пропуск */
    }
  }
  return entries;
}
