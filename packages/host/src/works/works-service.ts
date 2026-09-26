/**
 * Список работ хоста: сколько их, в каких проектах, кто их держит.
 *
 * Источник — глобальный индекс (`readWorksIndex`) плюс карта каждого известного
 * проекта. Наблюдатель за одним `harnasHome()` ловит только смену самого
 * индекса — содержимое чужого `.harnas/works/<id>/map.json` лежит вне его поля
 * зрения, поэтому на каждый известный проект заводится свой `watchWorks`
 * (спецификация 3.3, 4.2, план, кусок 1.4).
 *
 * Карту пишут трое — TUI, хост и MCP-серверы агентов (ревью, пункт 5): таймаут
 * `map.lock` здесь не роняет сервис, а уходит уведомлением `host.notice` и
 * повторяется на следующем изменении. Карту, которая есть на диске, но не
 * разбирается, `readWorks` из core молча пропускает — сервис проверяет это
 * отдельно и жалуется один раз на файл, ничего в него не дописывая.
 */

import {
  gitBranch,
  harnasHome,
  MapLockTimeoutError,
  processStartedAt,
  readMap,
  readWorks,
  readWorksIndex,
  reconcileMap,
  removeHostLease,
  watchWorks,
  workPaths,
  writeHostLease,
} from '@harnas/core';
import type { HostLease, WorkEntry, WorksWatcher } from '@harnas/core';
import type { WorksSnapshot } from '@harnas/protocol';
import type { HostContext } from '../context.js';

export interface WorksServiceOptions {
  /** Сколько подряд изменений склеивается в одну рассылку `works.changed`. */
  debounceMs?: number;
  /** Таймаут `map.lock` для записей сервиса (живость, аренда). */
  lockTimeoutMs?: number;
}

export interface WorksService {
  start(): Promise<void>;
  snapshot(): WorksSnapshot;
  entry(projectPath: string, workId: string): WorkEntry | undefined;
  /** Первое чтение этой работы хостом уже было: autoLaunch берёт только новое (1.7). */
  firstReadDone(projectPath: string, workId: string): boolean;
  onChange(listener: (snapshot: WorksSnapshot, previous: WorksSnapshot) => void): () => void;
  stop(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 100;

/** Ключ работы для внутренних карт сервиса: `\u0000` в путях и id не встречается. */
const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

export function createWorksService(
  host: HostContext,
  options: WorksServiceOptions = {},
): WorksService {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const lockOptions =
    options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs };

  const entries = new Map<string, WorkEntry>();
  const branches = new Map<string, string | null>();
  const watchers = new Map<string, WorksWatcher>();
  const listeners = new Set<(next: WorksSnapshot, previous: WorksSnapshot) => void>();
  const leased = new Set<string>();
  const readAlready = new Set<string>();
  const notifiedCorrupt = new Set<string>();

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let latest: WorkEntry[] = [];
  let ownLease: HostLease | null = null;

  const buildSnapshot = (): WorksSnapshot => ({
    entries: Array.from(entries.values()),
    branches: Object.fromEntries(branches),
  });

  const notice = (kind: 'map-lock' | 'map-corrupt', text: string): void => {
    host.broadcast('host.notice', { kind, ref: null, text, at: new Date().toISOString() });
    host.log.warn(`карта: ${kind}`, { text });
  };

  /**
   * Работы, о которых знает глобальный индекс, но которых нет в свежем чтении:
   * либо её каталог переехал или исчез (файла нет — молчим, как и `readWorks`),
   * либо `map.json` есть, но не разбирается — про это, в отличие от `readWorks`,
   * сервис обязан сказать (раздел «На что смотреть на ревью», пункт 5).
   */
  async function checkCorruption(present: ReadonlySet<string>): Promise<void> {
    const index = await readWorksIndex().catch(() => null);
    if (index === null) return;

    for (const item of index.works) {
      const key = workKey(item.projectPath, item.id);
      if (present.has(key)) continue;
      try {
        await readMap(item.projectPath, item.id);
        // Распарсилась — просто гонка со свежим чтением, не карта битая.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (notifiedCorrupt.has(key)) continue;
        notifiedCorrupt.add(key);
        notice('map-corrupt', workPaths(item.projectPath, item.id).map);
      }
    }
  }

  /**
   * Сверяет живость сессий с pid и подставляет в снимок уже пересчитанную карту.
   * Спящая с pid тоже кандидат: её процесс может оказаться жив (бывшая `done`
   * из карты v1), и сверка вернёт её в `active`.
   */
  async function reconcileLiveness(works: readonly WorkEntry[]): Promise<void> {
    for (const work of works) {
      const hasLiveCandidate = work.map.sessions.some(
        (session) =>
          (session.lifecycle === 'active' || session.lifecycle === 'sleeping') &&
          session.pid !== null,
      );
      if (!hasLiveCandidate) continue;

      try {
        const dead = await reconcileMap(work.projectPath, work.map.work.id, lockOptions);
        if (dead.length > 0) {
          const fresh = await readMap(work.projectPath, work.map.work.id);
          entries.set(workKey(work.projectPath, work.map.work.id), {
            projectPath: work.projectPath,
            map: fresh,
          });
        }
      } catch (error) {
        if (error instanceof MapLockTimeoutError) {
          notice('map-lock', error.message);
          continue;
        }
        host.log.error('живость работы не сверилась', {
          projectPath: work.projectPath,
          workId: work.map.work.id,
          error: String(error),
        });
      }
    }
  }

  /** Пишет аренду новой работе; уже арендованные пропускаются. */
  async function leaseWork(work: WorkEntry): Promise<void> {
    if (ownLease === null) return;
    const key = workKey(work.projectPath, work.map.work.id);
    if (leased.has(key)) return;
    try {
      await writeHostLease(work.projectPath, work.map.work.id, ownLease);
      leased.add(key);
    } catch (error) {
      host.log.error('аренда работы не записалась', {
        projectPath: work.projectPath,
        workId: work.map.work.id,
        error: String(error),
      });
    }
  }

  function ensureWatcher(projectPath: string): void {
    if (stopped || watchers.has(projectPath)) return;
    const watcher = watchWorks(
      (works) => {
        latest = works;
        scheduleRefresh();
      },
      projectPath,
      {
        // Своя склейка на уровне сервиса (см. `scheduleRefresh`): у каждого
        // проекта — свой наблюдатель, и без debounce:0 здесь несколько
        // параллельных таймеров watchWorks независимо дребезжали бы одним
        // и тем же изменением индекса.
        debounceMs: 0,
        onError: (error) =>
          host.log.warn('наблюдение за работами: событие пропущено', { error: String(error) }),
      },
    );
    watchers.set(projectPath, watcher);
  }

  function scheduleRefresh(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh(latest);
    }, debounceMs);
  }

  async function refresh(works: readonly WorkEntry[]): Promise<void> {
    if (stopped) return;
    const previous = buildSnapshot();

    // `works` — уже полный список: `readWorks` каждый раз перечитывает весь
    // глобальный индекс заново, а не только изменившийся проект, поэтому карту
    // сервиса можно просто заменить целиком, слитую по ключу `projectPath+workId`.
    const seenKeys = new Set<string>();
    entries.clear();
    for (const work of works) {
      const key = workKey(work.projectPath, work.map.work.id);
      entries.set(key, work);
      seenKeys.add(key);
      ensureWatcher(work.projectPath);
    }

    const projects = new Set(works.map((work) => work.projectPath));
    await Promise.all(
      Array.from(projects).map(async (projectPath) => {
        branches.set(projectPath, await gitBranch(projectPath));
      }),
    );
    for (const projectPath of Array.from(branches.keys())) {
      if (!projects.has(projectPath)) branches.delete(projectPath);
    }

    await reconcileLiveness(works);
    await checkCorruption(seenKeys);
    for (const work of works) await leaseWork(work);

    const snapshot = buildSnapshot();
    host.broadcast('works.changed', snapshot);
    for (const listener of listeners) listener(snapshot, previous);
    for (const key of seenKeys) readAlready.add(key);
  }

  return {
    async start() {
      ownLease = {
        pid: process.pid,
        startedAtProcess: await processStartedAt(process.pid),
        since: new Date().toISOString(),
      };

      // Наблюдатель за `harnasHome()` ловит появление новых проектов в
      // глобальном индексе, даже если на старте их ещё ни одного нет.
      ensureWatcher(harnasHome());
      const index = await readWorksIndex().catch(() => ({ schemaVersion: 1 as const, works: [] }));
      for (const item of index.works) ensureWatcher(item.projectPath);

      const initial = await readWorks(harnasHome());
      latest = initial;
      await refresh(initial);
    },
    snapshot: buildSnapshot,
    entry: (projectPath, workId) => entries.get(workKey(projectPath, workId)),
    firstReadDone: (projectPath, workId) => readAlready.has(workKey(projectPath, workId)),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();

      const pid = process.pid;
      await Promise.all(
        Array.from(entries.values()).map((work) =>
          removeHostLease(work.projectPath, work.map.work.id, pid).catch((error: unknown) => {
            host.log.error('снятие аренды не удалось', {
              projectPath: work.projectPath,
              workId: work.map.work.id,
              error: String(error),
            });
          }),
        ),
      );
    },
  };
}
