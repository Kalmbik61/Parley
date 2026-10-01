/**
 * Описание субагента Claude Code из его `meta.json` (Parley 0.2.0, активность агентов). Claude
 * кладёт файл рядом с транскриптом родителя: `<транскрипт без .jsonl>/subagents/agent-<id>.meta.json`,
 * а в нём — `agentType` и `description`. Снимок фоновых задач в хуках называет описание не всегда,
 * и тогда хост спрашивает файл.
 *
 * Только чтение одного этого файла, и любой сбой — `null`: файла может ещё не быть, а окну хватит и
 * того, что есть. Больше ничего из каталога Claude хост не читает.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SubagentMeta {
  agentType: string | null;
  description: string | null;
}

/** id субагента — hex-строка Claude Code; всё, что похоже на путь, до файловой системы не доходит. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * `null` — читать нечего: путь не годится, файла ещё нет, он не разбирается или в нём нет ни типа,
 * ни описания. Вызывающий повторит попытку при следующем обновлении.
 */
export async function readSubagentMeta(
  transcriptPath: string,
  agentId: string,
): Promise<SubagentMeta | null> {
  if (!path.isAbsolute(transcriptPath) || !SAFE_ID.test(agentId)) return null;
  const file = path.join(
    transcriptPath.replace(/\.jsonl$/, ''),
    'subagents',
    `agent-${agentId}.meta.json`,
  );

  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  const record = data as Record<string, unknown>;
  const meta = {
    agentType: textOf(record['agentType']),
    description: textOf(record['description']),
  };
  return meta.agentType === null && meta.description === null ? null : meta;
}
