/**
 * Ветка git проектов, чьи работы видны в сайдбаре (дизайн TUI v2, 2.1).
 *
 * Приоритетный источник ветки — индекс логов провайдера; у работы, чьи сессии
 * ещё не оставили лога, ветки там нет вовсе, и тогда её читает эта страховка.
 * Файл читается один раз на проект — состав проектов меняется редко.
 */

import { gitBranch, type WorkEntry } from '@harnas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

export function useGitBranch(
  entries: readonly WorkEntry[],
): (projectPath: string) => string | null {
  const [branches, setBranches] = useState<ReadonlyMap<string, string>>(new Map());
  // Ключ эффекта — сам состав проектов: список работ приходит новым массивом
  // на каждое событие watcher, и по нему `.git/HEAD` перечитывался бы без нужды.
  const paths = useMemo(
    () => [...new Set(entries.map((entry) => entry.projectPath))].sort().join('\n'),
    [entries],
  );

  useEffect(() => {
    let cancelled = false;
    const wanted = paths === '' ? [] : paths.split('\n');
    void Promise.all(wanted.map(async (path) => [path, await gitBranch(path)] as const)).then(
      (found) => {
        if (cancelled) return;
        setBranches(new Map(found.filter((pair): pair is [string, string] => pair[1] !== null)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paths]);

  return useCallback((projectPath: string) => branches.get(projectPath) ?? null, [branches]);
}
