import { defaultCodexRoot } from './codex/discover.js';
import { buildCodexIndex } from './codex/index-session.js';
import { defaultRoot } from './discover.js';
import type { SessionIndex } from './session-index.js';
import { buildIndex } from './session-tree.js';

export interface AllSessionsOptions {
  claudeRoot?: string;
  codexRoot?: string;
}

/**
 * Единый список сессий всех провайдеров, свежие первыми.
 *
 * Провайдер, чей каталог отсутствует (агент просто не установлен), молча даёт
 * пустой список: харнесс не должен требовать наличия всех CLI сразу.
 * GLM сюда не попадает — своей истории у него нет (specs/runners.md).
 */
export async function buildAllSessions({
  claudeRoot = defaultRoot(),
  codexRoot = defaultCodexRoot(),
}: AllSessionsOptions = {}): Promise<SessionIndex[]> {
  // Источники — по очереди, а не `Promise.all`: у каждого свой предел в
  // INDEX_READ_CONCURRENCY файлов, и вместе они держали бы вдвое больше чтений
  // в пуле libuv хоста (раунд lane-r3, п. 1).
  const claude = await buildIndex(claudeRoot);
  const codex = await buildCodexIndex(codexRoot);

  return [...claude, ...codex].sort((a, b) =>
    String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')),
  );
}
