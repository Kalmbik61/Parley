/**
 * Индекс логов провайдера по id сессии у провайдера: перенос `use-log-index.ts` и
 * `use-sessions.ts` TUI без React (дизайн TUI v2, 4.3 и 5.1). Живёт по событиям
 * `watchSessions` — без опроса.
 *
 * Своей файловой логики не заводит: список сессий строит и обновляет core
 * (`buildAllSessions`, `watchSessions`), здесь только разложение по id и подписка.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  adapterV1,
  buildAllSessions,
  buildIndex,
  customProviderProjectRoots,
  claudeSource,
  codexSource,
  qwenSource,
  defaultQwenRoot,
  isQwenTranscriptPath,
  qwenBindingHolds,
  defaultRoot,
  discoverSession,
  claudeCostIn,
  claudeDeltaIdsIn,
  claudeUsageFromTimelines,
  codexUsageFromTimeline,
  createSessionIndexer,
  extendUsageTimeline,
  watchSessions,
  type ActivityLog,
  type DescendantUsage,
  type DiscoveredSubagent,
  type IndexReuse,
  type MetricsRoots,
  type SessionChange,
  type SessionIndex,
  type SessionIndexer,
  type SessionWatcher,
  type SubagentTimeline,
  type TimelineReader,
  type UsageSummary,
  type UsageTimeline,
  type UsageWindow,
  type WorkSession,
  usageKey,
  withDescendants,
  byFamily,
} from '@parley/core';
import { hostPaths } from '../paths.js';
import { readHostVersion } from '../version.js';
import { LOG_INDEX_CACHE_FILE, loadLogIndexCache, saveLogIndexCache, type LogIndexCacheEntry } from './log-index-cache.js';

/** Итог первой сборки: сколько файлов в индексе и сколько из них разобрано заново (остальные взяты из кэша). */
export interface LogIndexStartStats {
  files: number;
  parsed: number;
}

/**
 * Что изменилось в индексе: подписчику, который пересчитывает свои сессии, нет смысла трогать остальные.
 * Без аргумента подписчика зовут на первый полный список — тогда пересчитывается всё.
 */
export interface LogChange {
  /**
   * Задела ли запись эту сессию: её собственный лог, лог её порождённого треда Codex (токены потомков идут в
   * итог родителя) или она активна и ещё не привязана к логу (`providerSessionId === null`: привязка `maybeLink` идёт по появлению логов, закрытым и непущенным она не нужна).
   */
  affects(session: WorkSession): boolean;
}

export interface LogIndex {
  /** `null` — остановлен до конца сборки. */
  start(): Promise<LogIndexStartStats | null>;
  /** Запись индекса по `providerSessionId` сессии; `undefined` — лога нет. */
  index(session: WorkSession): SessionIndex | undefined;
  /**
   * Токены разговора вместе с потомками, которых увидел индекс: подагенты Claude уже в итоге записи, а
   * порождённые треды Codex находятся по `parentId` и складываются здесь (один тред — один раз). `undefined` —
   * лога нет или он собран кодом до P36.
   */
  usage(session: WorkSession): UsageSummary | undefined;
  /** Журналы прямых субагентов треда Codex этой сессии (`parent_thread_id`); у сессии без журнала — []. */
  childLogs(session: WorkSession): Array<{ threadId: string; file: string }>;
  /**
   * Токены разговора за окна времени — срез для итога комнаты (спека расхода токенов, 5.3), с потомками: подагенты
   * Claude и порождённые треды Codex режутся теми же окнами. `undefined` — лога нет. Срез кэшируется по окнам, размеру
   * и mtime всех прочитанных файлов: повтор без новых записей файлов не читает.
   */
  usageIn(session: WorkSession, windows: readonly UsageWindow[], excludeIds?: ReadonlySet<string>): Promise<UsageSummary | undefined>;
  /** Стоимость Claude Code за окно по `cost-state` лога; `undefined` — лога нет, не Claude. */
  costIn(session: WorkSession, window: UsageWindow): Promise<number | null | undefined>;
  /** Нативные id ответов лога Claude внутри окон; `undefined` — лога нет, не Claude. */
  idsIn(session: WorkSession, windows: readonly UsageWindow[]): Promise<Set<string> | undefined>;
  /** Что известно про лог сессии для страховки `activityOf`; `null` — лога нет (4.3). */
  log(session: WorkSession): ActivityLog | null;
  onChange(listener: (change?: LogChange) => void): () => void;
  /**
   * Начать следить за ещё одним корнем истории Claude Code (папка `projects` своего провайдера, спека своих
   * провайдеров 5.6). Идемпотентно; каталог должен уже существовать. До `start()` корень просто запоминается.
   */
  watchClaudeRoot(root: string): void;
  /**
   * Перечитать один rollout-файл Codex и влить в индекс — как событие наблюдателя. На macOS `fs.watch` дозаписи
   * Codex не доставляет, поэтому `codex-log-poll.ts` зовёт это по опросу. Ошибку чтения (кроме «файла нет»)
   * не глотаем, а отдаём вызывающему: поллер ловит её сам и пробует на следующем проходе, как `onError` наблюдателя.
   */
  reindex(file: string): Promise<void>;
  /**
   * Перечитать файлы, чьи размер или mtime изменились с последнего перечитывания (страховка от потерянных событий
   * fs.watch): основному наблюдателю и наблюдателям из `watchClaudeRoot`. Без изменений стоит один `stat` на файл, чтения нет.
   * До `start()` и после `stop()` — ничего.
   */
  rescan(files: readonly string[]): void;
  stop(): void;
}

/**
 * Чьи логи читает сессия: Codex — свои, всё прочее (Claude и его надстройки вроде GLM) — Claude Code.
 * Один и тот же нативный id у двух семейств друг друга не вытесняет.
 */
const logFamily = (provider: string): 'codex' | 'claude' | 'qwen' | 'other' =>
  byFamily(provider, { claude: 'claude' as const, codex: 'codex' as const, qwen: 'qwen' as const, neutral: 'other' as const });
const logKey = (provider: string, id: string): string => `${logFamily(provider)}\u0000${id}`;

/**
 * Живой транскрипт перечитывается (индексатор дочитывает хвост, но разбор всё равно не бесплатный), поэтому не чаще раза за это время.
 * Статусы «работает/ждёт» ведут хуки и терминал, лог — только страховка с порогом тишины в десятки секунд:
 * задержка на пару секунд ей не мешает. Первая запись после паузы по-прежнему ждёт обычные 300 мс.
 */
export const LIVE_REINDEX_MIN_INTERVAL_MS = 2000;

/** Сколько срезов держит кэш (спека расхода токенов, 6.2). */
const SLICE_CACHE_SIZE = 64;

/** Сколько шкал расхода по файлам держит индекс (LRU). */
export const USAGE_TIMELINE_CACHE_SIZE = 256;
/** Как долго результат обнаружения подагентов Claude считается свежим: новый подагент виден не позже этого срока. */
export const SUBAGENT_DISCOVERY_TTL_MS = 30_000;

export interface LogIndexOptions {
  /** Чтение логов для шкал расхода; в тестах подменяется, чтобы видеть, откуда и сколько читали. */
  reader?: TimelineReader;
  /** Индексатор живых логов (наблюдатель и `reindex`); по умолчанию свой. В тестах — со своим читателем. */
  indexer?: SessionIndexer;
  timelineCacheSize?: number;
  subagentTtlMs?: number;
  now?: () => number;
  /**
   * Кэш индекса между запусками: файл и версия хоста. `null` — без кэша. По умолчанию кэш включён, только когда
   * корни истории Claude и Codex не подменены (тесты и E2E уводят хост от истории человека).
   */
  cache?: { file: string; version: string } | null;
}

/** Корни истории: к основным добавляются корни своих провайдеров (по умолчанию — найденные на диске). */
export type LogIndexRoots = MetricsRoots & { customRoots?: () => string[] };

export function createLogIndex(roots: LogIndexRoots = {}, options: LogIndexOptions = {}): LogIndex {
  // Свои корни по умолчанию читаются с диска, только если основной корень не подменён (тесты и E2E уводят хост от истории человека).
  const customRoots = roots.customRoots ?? (roots.claudeRoot === undefined ? () => customProviderProjectRoots() : () => []);
  const mainRoot = roots.claudeRoot ?? defaultRoot();
  const qwenRoot = roots.qwenRoot ?? defaultQwenRoot();
  /** Корни Claude, за которыми следит или будет следить индекс; в `usageIn` по ним находится корень файла. */
  const claudeRoots = new Set<string>([mainRoot]);
  /** Наблюдатели корней, добавленных `watchClaudeRoot` после старта. */
  const extraWatchers: SessionWatcher[] = [];
  let started = false;
  const timelineCacheSize = options.timelineCacheSize ?? USAGE_TIMELINE_CACHE_SIZE;
  const subagentTtlMs = options.subagentTtlMs ?? SUBAGENT_DISCOVERY_TTL_MS;
  const now = options.now ?? Date.now;
  // Один индексатор на наблюдатель и опрос Codex: живой лог дочитывается с места, а не читается целиком.
  const indexer = options.indexer ?? createSessionIndexer();
  /**
   * Записи по файлу в порядке перечитывания (Map помнит порядок вставки): из файлов с одним id побеждает перечитанный
   * последним — как раньше в списке `sessions`, где изменившийся файл уходил в конец.
   */
  const byFile = new Map<string, SessionIndex>();
  const byId = new Map<string, SessionIndex>();
  /** Порождённые треды Codex по ключу родителя: родные признаки (`parent_thread_id`), не время и cwd. */
  const byParent = new Map<string, SessionIndex[]>();
  const listeners = new Set<(change?: LogChange) => void>();
  let watcher: SessionWatcher | undefined;
  let stopped = false;
  // Прерывает построение списка на остановке: чтение истории в гигабайты держало бы процесс хоста
  // живым и после «хост остановлен» — минутами, пока не дочитает (2026-10-06).
  const building = new AbortController();

  const keyOf = (session: SessionIndex): string => logKey(session.provider, session.id);

  const linkParent = (session: SessionIndex): void => {
    if (session.provider !== 'codex' || session.parentId === undefined) return;
    const key = logKey('codex', session.parentId);
    const list = byParent.get(key);
    if (list === undefined) byParent.set(key, [session]);
    else list.push(session);
  };

  const unlinkParent = (session: SessionIndex): void => {
    if (session.provider !== 'codex' || session.parentId === undefined) return;
    const key = logKey('codex', session.parentId);
    const rest = (byParent.get(key) ?? []).filter((child) => child !== session);
    if (rest.length === 0) byParent.delete(key);
    else byParent.set(key, rest);
  };

  /** Полная сборка карт по списку: порядок списка — порядок перечитывания (победитель по id — последний). */
  const rebuild = (list: readonly SessionIndex[]): void => {
    byFile.clear();
    byId.clear();
    byParent.clear();
    for (const session of list) {
      byFile.delete(session.file);
      byFile.set(session.file, session);
    }
    for (const session of byFile.values()) {
      byId.set(keyOf(session), session);
      linkParent(session);
    }
  };

  /**
   * Правка карт по одному файлу: `byFile` (запись файла, изменившийся уходит в конец), `byId` (новая запись
   * побеждает по своему id; ушла записанная победительницей — её id достаётся последнему оставшемуся файлу)
   * и `byParent` (ребёнок Codex переезжает к новому родителю). Обход `byFile` — только когда ушёл победитель.
   */
  const applyChange = (change: SessionChange): void => {
    const previous = byFile.get(change.file);
    if (previous !== undefined) {
      byFile.delete(change.file);
      unlinkParent(previous);
    }
    if (change.kind === 'updated') {
      byFile.set(change.file, change.session);
      byId.set(keyOf(change.session), change.session);
      linkParent(change.session);
    }
    if (previous !== undefined && byId.get(keyOf(previous)) === previous) {
      byId.delete(keyOf(previous));
      let last: SessionIndex | undefined;
      for (const session of byFile.values()) if (keyOf(session) === keyOf(previous)) last = session;
      if (last !== undefined) byId.set(keyOf(previous), last);
    }
    // Старая запись нужна для `removed` и для смены id в том же файле; к каждой добавляются предки по `parentId`.
    const ids = new Set<string>();
    for (const start of [previous, change.kind === 'updated' ? change.session : undefined]) {
      // Свой `seen` на каждое начало: цепочка нового `parentId` не должна упираться в предков старой записи.
      const seen = new Set<string>();
      for (let node = start; node !== undefined && !seen.has(logKey(node.provider, node.id)); ) {
        seen.add(logKey(node.provider, node.id));
        ids.add(logKey(node.provider, node.id));
        node = node.provider === 'codex' && node.parentId !== undefined ? byId.get(logKey('codex', node.parentId)) : undefined;
      }
    }
    const affected: LogChange = {
      affects: (session) =>
        (session.providerSessionId === null && session.lifecycle === 'active') ||
        (session.providerSessionId !== null && ids.has(logKey(session.provider, session.providerSessionId))),
    };
    for (const listener of listeners) listener(affected);
  };

  const indexOf = (session: WorkSession): SessionIndex | undefined => {
    if (session.providerSessionId === null) return undefined;
    const found = byId.get(logKey(session.provider, session.providerSessionId));
    // A Qwen session with a binding from `SessionStart` trusts only that file, and only while its records agree
    // (`sessionId`, `cwd`); another file with the same id is not this session's transcript (spec 3.5).
    if (found !== undefined && session.qwenTranscript !== undefined && logFamily(session.provider) === 'qwen') {
      return qwenBindingHolds(found, { sessionId: session.providerSessionId, binding: session.qwenTranscript }) ? found : undefined;
    }
    return found;
  };

  /** Порождённые треды Codex под корнем (дети, внуки…); цикл в данных их не зациклит. */
  const descendantIndexes = (root: SessionIndex): SessionIndex[] => {
    const seen = new Set([logKey('codex', root.id)]);
    const found: SessionIndex[] = [];
    const queue = [root];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const child of byParent.get(logKey('codex', parent.id)) ?? []) {
        const key = logKey('codex', child.id);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(child);
        found.push(child);
      }
    }
    return found;
  };

  /** Потомок с итогом. Форк унаследовал чужую историю: что в его итоге своё, не доказать. */
  const descendantOf = (child: SessionIndex, usage: UsageSummary): DescendantUsage => ({
    key: usageKey('codex', child.id, child.startedAt),
    usage,
    ...(child.forkedFrom === undefined ? {} : { overlapUnresolved: true }),
  });

  const descendantsOf = (root: SessionIndex): DescendantUsage[] =>
    descendantIndexes(root).flatMap((child) => (child.usage === undefined ? [] : [descendantOf(child, child.usage)]));

  const slices = new Map<string, UsageSummary>();
  const remember = (key: string, value: UsageSummary): UsageSummary => {
    slices.delete(key);
    slices.set(key, value);
    if (slices.size > SLICE_CACHE_SIZE) slices.delete(slices.keys().next().value as string);
    return value;
  };

  /** Шкалы расхода по файлу (LRU): срез дочитывает хвост лога, а не читает его заново. */
  const timelines = new Map<string, UsageTimeline>();
  /** Идущее дочитывание файла — общее для одновременных `usageIn` (две комнаты с одним участником). */
  const extending = new Map<string, Promise<UsageTimeline>>();
  const timelineOf = (file: string, family: 'claude' | 'codex'): Promise<UsageTimeline> => {
    const running = extending.get(file);
    if (running !== undefined) return running;
    const run = (async (): Promise<UsageTimeline> => {
      try {
        const next = await extendUsageTimeline(timelines.get(file) ?? null, file, family, options.reader);
        timelines.delete(file);
        timelines.set(file, next);
        if (timelines.size > timelineCacheSize) timelines.delete(timelines.keys().next().value as string);
        return next;
      } finally {
        // Упавшее чтение не должно оставаться «идущим»: следующий вызов начнёт заново.
        extending.delete(file);
      }
    })();
    extending.set(file, run);
    return run;
  };
  /** Подагенты Claude по главному файлу: `discoverSession` ходит по каталогам, поэтому раз в TTL. */
  const subagentCache = new Map<string, { at: number; subagents: DiscoveredSubagent[] }>();
  const subagentsOf = async (file: string, root: string): Promise<DiscoveredSubagent[]> => {
    const cached = subagentCache.get(file);
    if (cached !== undefined && now() - cached.at < subagentTtlMs) return cached.subagents;
    const { subagents } = await discoverSession(file, root);
    subagentCache.delete(file);
    subagentCache.set(file, { at: now(), subagents });
    if (subagentCache.size > timelineCacheSize) subagentCache.delete(subagentCache.keys().next().value as string);
    return subagents;
  };
  /** Подпись прочитанных файлов: размер и mtime каждого; пропавший файл — своя метка. */
  const signature = async (files: readonly string[]): Promise<string> =>
    (
      await Promise.all(
        files.map(async (file) => {
          try {
            const info = await stat(file);
            return `${file}:${info.size}:${info.mtimeMs}`;
          } catch {
            return `${file}:-`;
          }
        }),
      )
    ).join('\u0000');

  /** Корни Claude (кроме основного), которых нет среди `done`. */
  const unbuiltRoots = (done: ReadonlySet<string>): string[] => [...claudeRoots].filter((root) => !done.has(root));

  return {
    childLogs(session) {
      if (session.provider !== 'codex') return [];
      const root = indexOf(session);
      if (root === undefined) return [];
      return (byParent.get(logKey('codex', root.id)) ?? []).map((child) => ({ threadId: child.id, file: child.file }));
    },
    async start() {
      const hostVersion = readHostVersion();
      // Версия не определилась (`unknown`) — кэш не включаем: он пережил бы обновление.
      const cacheOptions =
        options.cache !== undefined
          ? options.cache
          : roots.claudeRoot === undefined && roots.codexRoot === undefined && roots.qwenRoot === undefined && hostVersion !== 'unknown'
            ? { file: path.join(hostPaths().dir, LOG_INDEX_CACHE_FILE), version: hostVersion }
            : null;
      const previous = cacheOptions === null ? new Map<string, LogIndexCacheEntry>() : await loadLogIndexCache(cacheOptions.file, cacheOptions.version);
      // Новая карта кэша — ровно файлы этой сборки: исчезнувшие выпадают. Порядок записей в индексе кэш не хранит:
      // список строит та же сборка (обход, сортировка по `endedAt`), так что победитель среди файлов с одним id тот же.
      const next = new Map<string, LogIndexCacheEntry>();
      let reused = 0;
      const reuse: IndexReuse | undefined =
        cacheOptions === null
          ? undefined
          : {
              get(file, key) {
                const entry = previous.get(file);
                if (entry === undefined || entry.key !== key) return undefined;
                reused += 1;
                return entry.index;
              },
              put(file, key, index) {
                next.set(file, { key, index });
              },
            };
      // Полный список могут читать гигабайты истории (`~/.claude/projects`) —
      // вызывающий (`ActivityService`) не ждёт эту функцию, чтобы не задерживать
      // старт хоста; `stopped` здесь ловит остановку, случившуюся, пока список
      // ещё строился: `stop()` прерывает чтение, и прерванное построение — не сбой.
      let built: SessionIndex[];
      for (const root of customRoots()) claudeRoots.add(root);
      // Корни, чьи сессии уже в `built`: `watchClaudeRoot` может добавить корень, пока список строится.
      const builtRoots = new Set<string>([mainRoot]);
      try {
        built = await buildAllSessions({ ...roots, qwenRoot, signal: building.signal, ...(reuse === undefined ? {} : { reuse }) });
        // Корни своих провайдеров — только Claude-формат; Codex в общем списке уже один раз.
        // Цикл ловит и корни, появившиеся за время самой сборки: после последней проверки `await` нет.
        for (let pending = unbuiltRoots(builtRoots); pending.length > 0; pending = unbuiltRoots(builtRoots)) {
          for (const root of pending) {
            builtRoots.add(root);
            built = [...built, ...(await buildIndex(root, adapterV1, building.signal, reuse))];
          }
          built.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
        }
      } catch (error) {
        if (stopped) return null;
        throw error;
      }
      if (stopped) return null;
      rebuild(built);
      // Наблюдатели и `started` — без `await` после последней проверки корней: `watchClaudeRoot` не теряет корень.
      watcher = watchSessions(
        applyChange,
        [
          claudeSource(roots.claudeRoot, undefined, indexer),
          ...[...claudeRoots].filter((root) => root !== mainRoot).map((root) => claudeSource(root, undefined, indexer)),
          codexSource(roots.codexRoot, indexer),
          qwenSource(qwenRoot, indexer),
        ],
        // Сбой ре-парса одного файла не должен ронять хост — следующее событие
        // попробует снова, как и у остальных наблюдателей хоста.
        { minIntervalMs: LIVE_REINDEX_MIN_INTERVAL_MS, onError: () => {} },
      );
      started = true;
      // Тех, кто уже подписался (`ActivityService.handleLogChange`), нужно
      // толкнуть и на сам первый список: иначе сессия, чей лог был на диске
      // ещё до старта хоста, ждала бы первой ЖИВОЙ записи, которой может не
      // случиться (план, кусок 1.5 — автозаголовок и привязка «на изменениях
      // логов»).
      for (const listener of listeners) listener();
      const stats: LogIndexStartStats = { files: next.size, parsed: next.size - reused };
      if (cacheOptions !== null && !stopped && (stats.parsed > 0 || next.size !== previous.size)) {
        // Кэш — ускорение, не данные: сбой записи не должен ронять индекс.
        await saveLogIndexCache(cacheOptions.file, cacheOptions.version, next).catch(() => undefined);
      }
      return stats;
    },
    watchClaudeRoot(root) {
      if (stopped || claudeRoots.has(root)) return;
      claudeRoots.add(root);
      // До старта корень подхватит сам `start()`; после — свой наблюдатель на этот корень.
      if (!started) return;
      extraWatchers.push(
        watchSessions(applyChange, [claudeSource(root, undefined, indexer)], {
          minIntervalMs: LIVE_REINDEX_MIN_INTERVAL_MS,
          onError: () => {},
        }),
      );
    },
    index: indexOf,
    usage(session) {
      const found = indexOf(session);
      if (found?.usage === undefined) return undefined;
      return found.provider === 'codex' ? withDescendants(found.usage, descendantsOf(found)) : found.usage;
    },
    async usageIn(session, windows, excludeIds) {
      const found = indexOf(session);
      if (found === undefined || found.provider === 'qwen') return undefined;
      if (found.provider === 'codex') {
        const children = descendantIndexes(found);
        const key = `codex\u0000${JSON.stringify(windows)}\u0000${await signature([found.file, ...children.map((child) => child.file)])}`;
        const cached = slices.get(key);
        if (cached !== undefined) return remember(key, cached);
        const own = codexUsageFromTimeline(await timelineOf(found.file, 'codex'), windows);
        const descendants: DescendantUsage[] = [];
        for (const child of children) {
          descendants.push(descendantOf(child, codexUsageFromTimeline(await timelineOf(child.file, 'codex'), windows)));
        }
        return remember(key, withDescendants(own, descendants));
      }
      // Корень файла — тот из известных, внутри которого он лежит (у своего провайдера он свой).
      const root = [...claudeRoots].find((known) => found.file.startsWith(known + path.sep)) ?? mainRoot;
      const subagents = await subagentsOf(found.file, root);
      const excluded = excludeIds === undefined || excludeIds.size === 0 ? '' : [...excludeIds].sort().join(',');
      const key = `claude\u0000${JSON.stringify(windows)}\u0000${excluded}\u0000${await signature([found.file, ...subagents.map((agent) => agent.file)])}`;
      const cached = slices.get(key);
      if (cached !== undefined) return remember(key, cached);
      const parent = await timelineOf(found.file, 'claude');
      const children: SubagentTimeline[] = [];
      for (const agent of subagents) children.push({ ...(await timelineOf(agent.file, 'claude')), agentId: agent.agentId });
      return remember(key, claudeUsageFromTimelines(parent, children, windows, excludeIds));
    },
    async costIn(session, window) {
      const found = indexOf(session);
      if (found === undefined || found.provider === 'codex' || found.provider === 'qwen') return undefined;
      return claudeCostIn(await timelineOf(found.file, 'claude'), window);
    },
    async idsIn(session, windows) {
      const found = indexOf(session);
      if (found === undefined || found.provider === 'codex' || found.provider === 'qwen') return undefined;
      const root = [...claudeRoots].find((known) => found.file.startsWith(known + path.sep)) ?? mainRoot;
      const subagents = await subagentsOf(found.file, root);
      const parent = await timelineOf(found.file, 'claude');
      const children: SubagentTimeline[] = [];
      for (const agent of subagents) children.push({ ...(await timelineOf(agent.file, 'claude')), agentId: agent.agentId });
      return claudeDeltaIdsIn(parent, children, windows);
    },
    log(session) {
      const found = indexOf(session);
      return found === undefined
        ? null
        : // Не `endedAt`: итоги хуков и длительность хода Claude Code пишет уже после `Stop`, и по ним
          // закончившая ход сессия числилась бы `working` ещё порог тишины — письма ей всё это время ждали бы.
          {
            lastRecordAt: found.lastWorkRecordAt,
            lastUserRecordAt: found.lastUserRecordAt,
            lastInterruptAt: found.lastInterruptAt,
            ...(found.lastApiError === undefined ? {} : { lastApiError: found.lastApiError }),
          };
    },
    async reindex(file) {
      if (stopped) return;
      let session: SessionIndex;
      try {
        // A Qwen transcript is never read as a Codex rollout.
        session = await (isQwenTranscriptPath(file, qwenRoot) ? indexer.qwen(file) : indexer.codex(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!stopped) applyChange({ kind: 'removed', file });
        return;
      }
      if (!stopped) applyChange({ kind: 'updated', file, session });
    },
    rescan(files) {
      if (stopped) return;
      watcher?.rescan(files);
      for (const extraWatcher of extraWatchers) extraWatcher.rescan(files);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      building.abort();
      watcher?.close();
      for (const extraWatcher of extraWatchers) extraWatcher.close();
      extraWatchers.length = 0;
      listeners.clear();
    },
  };
}
