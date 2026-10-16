import { readFile, writeFile } from 'node:fs/promises';
import { workPaths } from '@parley/core';

/**
 * Переписывает карту работы в раскладку v3: индекс без писем и решений, `schemaVersion` 3. Журналов у свежей
 * работы ещё нет — письма появятся строками `appendMessage`.
 */
export async function toJournalLayout(projectPath: string, workId: string): Promise<void> {
  const file = workPaths(projectPath, workId).map;
  const index = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  delete index.messages;
  delete index.decisionExports;
  await writeFile(file, `${JSON.stringify({ ...index, schemaVersion: 3 }, null, 2)}\n`);
}
