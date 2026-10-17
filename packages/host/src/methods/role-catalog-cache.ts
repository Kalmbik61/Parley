import { readCodexRoleContext, sessionRoleCatalog } from '@parley/core';
import type { CodexContextOptions } from '@parley/core';

type Catalog = typeof sessionRoleCatalog;
type ReadContext = (options: CodexContextOptions) => ReturnType<typeof readCodexRoleContext>;

/**
 * Дорого здесь одно: чтение конфигурации Codex (`codex app-server`, до 8 с). Оно держится столько,
 * сколько нужно окну на пачку плашек и открытие диалога; файлы ролей (`.claude/agents`, роли Codex)
 * читаются каждый раз, поэтому новая роль видна сразу. Конфигурация Codex меняется редко и подписки на
 * неё нет — инвалидация только по времени. Непроверенный ответ (Codex не успел) не держится вовсе.
 */
export const CODEX_CONTEXT_TTL_MS = 30_000;

/**
 * Одинаковые запросы каталога склеиваются, пока идёт первый, и ещё столько после него: пачка плашек
 * приходит не в одну миллисекунду. Дольше нельзя — запись роли должна быть видна.
 */
export const ROLE_CATALOG_COALESCE_MS = 1_500;

interface Options {
  coalesceMs?: number;
  contextTtlMs?: number;
  now?: () => number;
  readContext?: ReadContext;
}

/**
 * Каталог для `roles.list` и `recipes.list`: общий промис на одинаковые одновременные запросы (ключ — `cwd`
 * и параметры) и кэш чтения конфигурации Codex через адаптер `context`. Отказ не кэшируется.
 */
export function createCachedCatalog(
  catalog: Catalog = sessionRoleCatalog,
  { coalesceMs = ROLE_CATALOG_COALESCE_MS, contextTtlMs = CODEX_CONTEXT_TTL_MS, now = Date.now, readContext = readCodexRoleContext }: Options = {},
): Catalog {
  const contexts = new Map<string, { at: number | null; value: ReturnType<ReadContext> }>();
  const cachedContext: ReadContext = (options) => {
    const key = JSON.stringify([options.cwd, options.command, options.configArgs, options.env?.['CODEX_HOME']]);
    const time = now();
    const hit = contexts.get(key);
    if (hit !== undefined && (hit.at === null || time - hit.at < contextTtlMs)) return hit.value;
    for (const [other, entry] of contexts) if (entry.at !== null && time - entry.at >= contextTtlMs) contexts.delete(other);
    // `at: null` — чтение идёт; по его концу проверенный ответ получает отметку времени, прочий и отказ уходят.
    const entry: { at: number | null; value: ReturnType<ReadContext> } = { at: null, value: readContext(options) };
    contexts.set(key, entry);
    entry.value.then(
      (result) => {
        if (contexts.get(key) !== entry) return;
        if (result.verified) entry.at = now();
        else contexts.delete(key);
      },
      () => {
        if (contexts.get(key) === entry) contexts.delete(key);
      },
    );
    return entry.value;
  };

  const entries = new Map<string, { at: number | null; value: Promise<Awaited<ReturnType<Catalog>>> }>();
  return (cwd, options) => {
    const key = `${cwd}\0${JSON.stringify(options ?? {})}`;
    const time = now();
    const hit = entries.get(key);
    if (hit !== undefined && (hit.at === null || time - hit.at < coalesceMs)) return hit.value;
    for (const [other, entry] of entries) if (entry.at !== null && time - entry.at >= coalesceMs) entries.delete(other);
    const value = catalog(cwd, options?.context === undefined ? { ...options, context: cachedContext } : options);
    const entry: { at: number | null; value: typeof value } = { at: null, value };
    entries.set(key, entry);
    value.then(
      () => {
        if (entries.get(key) === entry) entry.at = now();
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return value;
  };
}
