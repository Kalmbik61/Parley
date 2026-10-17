import { sessionRoleCatalog } from '@parley/core';

type Catalog = typeof sessionRoleCatalog;

/**
 * Каталог ролей живёт столько, сколько нужно окну на пачку плашек и открытие диалога. Каждый его
 * сбор запускает `codex app-server` (до 8 с); файлы ролей меняются редко, а подписки на них нет —
 * инвалидация только по времени: правка роли видна не позже чем через эту паузу.
 */
export const ROLE_CATALOG_TTL_MS = 30_000;

/**
 * Каталог с общим кэшем для `roles.list` и `recipes.list`: ключ — `cwd` и параметры каталога,
 * одновременные одинаковые запросы делят один промис, результат держится `ttlMs`. Ошибка не кэшируется.
 */
export function createCachedCatalog(
  catalog: Catalog = sessionRoleCatalog,
  { ttlMs = ROLE_CATALOG_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): Catalog {
  const entries = new Map<string, { at: number; value: Promise<Awaited<ReturnType<Catalog>>> }>();
  return (cwd, options) => {
    const key = `${cwd}\0${JSON.stringify(options ?? {})}`;
    const time = now();
    const hit = entries.get(key);
    if (hit !== undefined && time - hit.at < ttlMs) return hit.value;
    for (const [other, entry] of entries) if (time - entry.at >= ttlMs) entries.delete(other);
    const value = catalog(cwd, options);
    const entry = { at: time, value };
    entries.set(key, entry);
    value.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return value;
  };
}
