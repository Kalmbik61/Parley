/**
 * Что помощник отправил агентам в Chat (спека 2026-10-14, 7.4): `<parleyHome>/assistant/sent.jsonl`, строка — `{ ref,
 * text, at }`. Окно по нему помечает такие сообщения в ленте Chat («You (via assistant)»).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assistantCwd } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';

const KEEP = 500;
const SLACK = 100;
const RETURN = 50;

const fileOf = (home: string): string => path.join(assistantCwd(home), 'sent.jsonl');

export async function appendSent(home: string, ref: SessionRef, text: string, at: string): Promise<void> {
  const file = fileOf(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify({ ref, text, at })}\n`, { encoding: 'utf8', mode: 0o600 });
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  if (lines.length > KEEP + SLACK) await writeFile(file, `${lines.slice(-KEEP).join('\n')}\n`, { mode: 0o600 });
}

export async function readSent(home: string, ref: SessionRef): Promise<Array<{ text: string; at: string }>> {
  let raw: string;
  try {
    raw = await readFile(fileOf(home), 'utf8');
  } catch {
    return [];
  }
  const key = refKey(ref);
  const items: Array<{ text: string; at: string }> = [];
  for (const line of raw.split('\n')) {
    try {
      const entry = JSON.parse(line) as { ref?: SessionRef; text?: unknown; at?: unknown };
      if (entry.ref !== undefined && refKey(entry.ref) === key && typeof entry.text === 'string' && typeof entry.at === 'string') {
        items.push({ text: entry.text, at: entry.at });
      }
    } catch {
      // битая строка — пропустить
    }
  }
  return items.slice(-RETURN);
}
