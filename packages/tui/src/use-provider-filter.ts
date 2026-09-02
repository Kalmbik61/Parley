import { PROVIDERS, type Provider, type SessionIndex } from '@harnas/core';
import { useCallback, useMemo, useState } from 'react';

/** null — показывать всех. */
export type ProviderFilter = Provider | null;

export interface ProviderFilterState {
  filter: ProviderFilter;
  /** Сессии после применения фильтра. */
  visible: SessionIndex[];
  /** Провайдеры, реально присутствующие в списке. */
  present: Provider[];
  cycle: () => void;
}

/**
 * Фильтр по провайдеру для общего списка сессий.
 *
 * Перебираются только те провайдеры, чьи сессии реально есть: предлагать фильтр
 * по Codex, когда его сессий ни одной, — бессмысленно.
 *
 * `extra` — провайдеры сессий работ: у работы, созданной через CLI или MCP, логов
 * ещё нет, и по одному индексу логов её провайдер было бы не выбрать (дизайн 6.5).
 */
export function useProviderFilter(
  sessions: SessionIndex[],
  extra: readonly string[] = [],
): ProviderFilterState {
  const [filter, setFilter] = useState<ProviderFilter>(null);

  const present = useMemo(() => {
    const seen = new Set<Provider>();
    for (const session of sessions) seen.add(session.provider);
    // Набор провайдеров открыт (providers.json), а фильтр знает только встроенные:
    // чужой id в него не превращается.
    for (const provider of extra) {
      if (provider in PROVIDERS) seen.add(provider as Provider);
    }
    // Провайдеры без истории (GLM) не могут появиться из сессий, но выбрать их
    // нужно: только так до них дотягивается запуск новой сессии.
    for (const provider of Object.values(PROVIDERS)) {
      if (!provider.hasHistory) seen.add(provider.id);
    }
    return [...seen].sort();
  }, [sessions, extra]);

  const cycle = useCallback(() => {
    setFilter((current) => {
      // Порядок обхода: все → первый провайдер → … → последний → снова все.
      // Перебираем даже единственного провайдера: им может быть раннер без
      // истории (GLM), и другого способа выбрать его нет.
      if (present.length === 0) return null;
      if (current === null) return present[0] ?? null;
      const at = present.indexOf(current);
      return at === -1 || at === present.length - 1 ? null : (present[at + 1] ?? null);
    });
  }, [present]);

  const visible = useMemo(
    () => (filter === null ? sessions : sessions.filter((s) => s.provider === filter)),
    [sessions, filter],
  );

  return { filter, visible, present, cycle };
}
