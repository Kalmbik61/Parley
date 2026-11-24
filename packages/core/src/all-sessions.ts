import { adapterV1 } from './adapter-v1.js';
import { defaultCodexRoot } from './codex/discover.js';
import { buildCodexIndex } from './codex/index-session.js';
import { defaultRoot } from './discover.js';
import { defaultQwenRoot } from './qwen/discover.js';
import { buildQwenIndex } from './qwen/index-session.js';
import type { IndexReuse } from './index-reuse.js';
import type { SessionIndex } from './session-index.js';
import { buildIndex } from './session-tree.js';

export interface AllSessionsOptions {
  claudeRoot?: string;
  codexRoot?: string;
  qwenRoot?: string;
  /**
   * Прерывает чтение истории (остановка хоста): новые файлы не открываются, начатые
   * закрываются, промис отклоняется `AbortError`.
   */
  signal?: AbortSignal;
  /** Записи прошлого запуска: файл с совпавшим ключом не читается (кэш индекса хоста). */
  reuse?: IndexReuse;
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
  qwenRoot = defaultQwenRoot(),
  signal,
  reuse,
}: AllSessionsOptions = {}): Promise<SessionIndex[]> {
  // Источники — по очереди, а не `Promise.all`: у каждого свой предел в
  // INDEX_READ_CONCURRENCY файлов, и вместе они держали бы вдвое больше чтений
  // в пуле libuv хоста (раунд lane-r3, п. 1).
  const claude = await buildIndex(claudeRoot, adapterV1, signal, reuse);
  const codex = await buildCodexIndex(codexRoot, signal, reuse);

  const qwen = await buildQwenIndex(qwenRoot, signal, reuse);

  return [...claude, ...codex, ...qwen].sort((a, b) =>
    String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')),
  );
}
