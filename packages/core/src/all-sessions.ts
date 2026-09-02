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
  const [claude, codex] = await Promise.all([buildIndex(claudeRoot), buildCodexIndex(codexRoot)]);

  return [...claude, ...codex].sort((a, b) =>
    String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')),
  );
}
