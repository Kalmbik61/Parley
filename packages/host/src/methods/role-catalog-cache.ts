import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readCodexRoleContext, sessionRoleCatalog } from '@parley/core';
import type { CodexContextOptions } from '@parley/core';

type Catalog = typeof sessionRoleCatalog;
type ReadContext = (options: CodexContextOptions) => ReturnType<typeof readCodexRoleContext>;

/**
 * Дорого здесь одно: чтение конфигурации Codex (`codex app-server`, до 8 с). Ключ — содержательная подпись
 * входов (`codexSignature`), а не путь: worktree без своего `.codex` делят один ответ. Оно держится столько,
 * сколько нужно окну на пачку плашек и открытие диалога; файлы ролей (`.claude/agents`, роли Codex)
 * читаются каждый раз, поэтому новая роль видна сразу. Конфигурация Codex меняется редко и подписки на
 * неё нет — инвалидация по времени и по смене подписи.
 */
export const CODEX_CONTEXT_TTL_MS = 30_000;

/**
 * Непроверенный ответ и отказ чтения Codex держатся дольше проверенного: медленный или сломанный `codex`
 * иначе перезапускался бы на каждый запрос (до 8 с каждый). Исправление человека (правка `.codex/config.toml`,
 * пользовательского config.toml) меняет подпись и ключ, поэтому видно сразу; починка самого бинаря или PATH
 * подпись не меняет — там ждём срок.
 */
export const CODEX_CONTEXT_FAILURE_TTL_MS = 60_000;

/**
 * Одинаковые запросы каталога склеиваются, пока идёт первый, и ещё столько после него: пачка плашек
 * приходит не в одну миллисекунду. Дольше нельзя — запись роли должна быть видна.
 */
export const ROLE_CATALOG_COALESCE_MS = 1_500;

const fileStamp = async (file: string): Promise<string> => {
  try {
    const info = await stat(file);
    return `${file}:${info.size}:${info.mtimeMs}`;
  } catch {
    return '';
  }
};

/**
 * Подпись входов чтения конфигурации Codex, помимо `command`, `configArgs` и `CODEX_HOME` из ключа:
 * пользовательский и системный config.toml (путь, размер, mtime) и список существующих `.codex/config.toml`
 * от `cwd` вверх до корня ФС. Если проектных файлов нет, подпись не зависит от `cwd` (worktree делят ответ);
 * если есть, в неё входит и `cwd` (доверие считается по пути проекта).
 */
async function codexSignature(cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const home = env?.['CODEX_HOME'] ?? process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex');
  const project: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const stamp = await fileStamp(path.join(dir, '.codex', 'config.toml'));
    if (stamp !== '') project.push(stamp);
    if (path.dirname(dir) === dir) break;
  }
  const outer = await Promise.all([fileStamp(path.join(home, 'config.toml')), fileStamp('/etc/codex/config.toml')]);
  return JSON.stringify([outer, project.length === 0 ? '' : [cwd, project]]);
}

interface Options {
  coalesceMs?: number;
  contextTtlMs?: number;
  failureTtlMs?: number;
  signature?: (cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;
  now?: () => number;
  readContext?: ReadContext;
}

/**
 * Каталог для `roles.list` и `recipes.list`: общий промис на одинаковые одновременные запросы (ключ — `cwd`
 * и параметры) и кэш чтения конфигурации Codex через адаптер `context`. Отказ каталога не кэшируется; отказ и непроверенный ответ чтения Codex держатся 60 с.
 */
export function createCachedCatalog(
  catalog: Catalog = sessionRoleCatalog,
  { coalesceMs = ROLE_CATALOG_COALESCE_MS, contextTtlMs = CODEX_CONTEXT_TTL_MS, failureTtlMs = CODEX_CONTEXT_FAILURE_TTL_MS, signature = codexSignature, now = Date.now, readContext = readCodexRoleContext }: Options = {},
): Catalog {
  const contexts = new Map<string, { at: number | null; ttl: number; value: ReturnType<ReadContext> }>();
  // Не более одного чтения Codex на хост одновременно: следующее ждёт конца предыдущего.
  let tail: Promise<unknown> = Promise.resolve();
  const cachedContext: ReadContext = async (options) => {
    const key = JSON.stringify([options.command, options.configArgs, options.env?.['CODEX_HOME'], await signature(options.cwd, options.env)]);
    const time = now();
    const hit = contexts.get(key);
    if (hit !== undefined && (hit.at === null || time - hit.at < hit.ttl)) return hit.value;
    for (const [other, entry] of contexts) if (entry.at !== null && time - entry.at >= entry.ttl) contexts.delete(other);
    const run = tail.then(() => readContext(options));
    tail = run.catch(() => undefined);
    // `at: null` — чтение идёт (или ждёт очереди); по его концу ответ получает отметку времени и срок:
    // проверенный — contextTtlMs, непроверенный и отказ — failureTtlMs.
    const entry: { at: number | null; ttl: number; value: ReturnType<ReadContext> } = { at: null, ttl: failureTtlMs, value: run };
    contexts.set(key, entry);
    run.then(
      (result) => {
        if (contexts.get(key) !== entry) return;
        entry.ttl = result.verified ? contextTtlMs : failureTtlMs;
        entry.at = now();
      },
      () => {
        if (contexts.get(key) === entry) entry.at = now();
      },
    );
    return run;
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
