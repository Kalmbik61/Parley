import type { SessionRef } from '@parley/protocol';
import { HostCallError, refKey } from './host-link.js';
import type { HostLink } from './host-link.js';
import type { BridgeLog } from './log.js';

/**
 * Подписки телефонов на ленту сессии (спека 4.2, 5.6): счётчик по `ref` на все телефоны. Хост видит один клиент —
 * мост: первый подписчик подписывает мост у хоста, последний отписавшийся (или отключившийся) телефон снимает.
 * Подписки хоста живут в соединении: новая эпоха их обнуляет, и мост восстанавливает их для живых подписчиков.
 *
 * Всё по одному `ref` — смена набора телефонов и вызовы хоста — идёт одной очередью: шаг решает, звать ли хост,
 * по набору на своё начало. Подписка во время отписки (и наоборот) сходится к последнему намерению каждого
 * телефона, а не к порядку ответов хоста; одновременные подписки ждут одного вызова хоста.
 */
export interface FeedSubscriptions {
  /** Телефон подписан, и мост подписан у хоста в текущей эпохе; ошибка хоста — телефон не подписан. */
  subscribe(deviceId: string, ref: SessionRef): Promise<{ ok: true }>;
  /** Телефон отписан; хост отписывается, если подписчиков не осталось. Ошибка хоста телефону не идёт. */
  unsubscribe(deviceId: string, ref: SessionRef): Promise<{ ok: true }>;
  /** Телефон отключился: `feed.changed` ему больше не идёт, его подписки сняты. */
  dropDevice(deviceId: string): void;
  /** Кому из телефонов идёт `feed.changed` этого `ref`. */
  subscribers(ref: SessionRef): ReadonlySet<string>;
  stop(): void;
}

interface Entry {
  key: string;
  ref: SessionRef;
  phones: Set<string>;
  /** Эпоха, в которой мост подписан у хоста; `null` — не подписан. */
  hostEpoch: string | null;
  /** Хвост очереди по этому `ref`. */
  tail: Promise<void>;
  /** Шагов в очереди: запись удаляется, только когда очередь пуста, подписчиков и подписки хоста нет. */
  queued: number;
}

const NONE: ReadonlySet<string> = new Set();

export function createFeedSubscriptions(options: { host: HostLink; log: BridgeLog }): FeedSubscriptions {
  const { host, log } = options;
  const entries = new Map<string, Entry>();
  let stopped = false;

  function entryOf(ref: SessionRef): Entry {
    const key = refKey(ref);
    let entry = entries.get(key);
    if (!entry) {
      // Хосту уходит только `ref` из трёх полей: лишние ключи телефона в ключ подписки не попадают.
      const clean = { projectPath: ref.projectPath, workId: ref.workId, sessionId: ref.sessionId };
      entry = { key, ref: clean, phones: new Set(), hostEpoch: null, tail: Promise.resolve(), queued: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  /** Шаг в очередь `ref`: результат — вызывающему; ошибка шага очередь не рвёт. */
  function enqueue<T>(entry: Entry, step: () => Promise<T>): Promise<T> {
    entry.queued++;
    const run = entry.tail.then(step);
    entry.tail = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        entry.queued--;
        if (entry.queued === 0 && entry.phones.size === 0 && entry.hostEpoch === null && entries.get(entry.key) === entry) {
          entries.delete(entry.key);
        }
      });
    return run;
  }

  /** Подписать мост у хоста, если подписчики есть, а подписки этой эпохи нет. */
  async function ensure(entry: Entry): Promise<void> {
    const epoch = host.epoch;
    if (stopped || entry.phones.size === 0 || (entry.hostEpoch !== null && entry.hostEpoch === epoch)) return;
    await host.call('feed.subscribe', { ref: entry.ref });
    // Ответ пришёл по сокету этой эпохи: ответы ушедшего соединения HostLink отвергает (`host_offline`).
    entry.hostEpoch = epoch;
  }

  /** Снять подписку моста, если подписчиков не осталось. Подписка прошлой эпохи умерла вместе с её сокетом. */
  async function settle(entry: Entry): Promise<void> {
    if (entry.phones.size > 0 || entry.hostEpoch === null) return;
    const epoch = entry.hostEpoch;
    entry.hostEpoch = null;
    if (stopped || epoch !== host.epoch || host.status !== 'online') return;
    try {
      await host.call('feed.unsubscribe', { ref: entry.ref });
    } catch (error) {
      // Дельты телефонам уже не идут; хост снимет подписку сам, когда закроется сокет.
      log.warn('feed.unsubscribe_failed', { error });
    }
  }

  const unlisten = host.subscribe((event) => {
    if (event.type !== 'status' || event.status !== 'online') return;
    // Хост `online` в новой эпохе: его подписки обнулены — восстановить для живых подписчиков.
    for (const entry of [...entries.values()]) {
      if (entry.phones.size === 0) continue;
      enqueue(entry, async () => {
        try {
          await ensure(entry);
        } catch (error) {
          // Хост снова ушёл — повторит следующий `online`. Иной отказ (сессии больше нет) снимает подписчиков:
          // телефон подпишется заново, когда пересинхронизируется на новой эпохе.
          log.warn('feed.resubscribe_failed', { error });
          if (!(error instanceof HostCallError && error.code === 'host_offline')) {
            entry.phones.clear();
            await settle(entry);
          }
        }
      }).catch(() => undefined);
    }
  });

  return {
    subscribe(deviceId, ref) {
      const entry = entryOf(ref);
      return enqueue(entry, async () => {
        const already = entry.phones.has(deviceId);
        entry.phones.add(deviceId);
        try {
          await ensure(entry);
        } catch (error) {
          // Отказ относится к этой попытке: телефон не подписан. Был подписан раньше — значит, подписка хоста этой
          // эпохи есть и вызова не было; сюда он попадает только без неё.
          if (!already || entry.hostEpoch !== host.epoch) entry.phones.delete(deviceId);
          await settle(entry);
          throw error;
        }
        return { ok: true } as const;
      });
    },
    async unsubscribe(deviceId, ref) {
      const entry = entries.get(refKey(ref));
      if (entry) {
        await enqueue(entry, async () => {
          entry.phones.delete(deviceId);
          await settle(entry);
        });
      }
      return { ok: true };
    },
    dropDevice(deviceId) {
      for (const entry of [...entries.values()]) {
        if (!entry.phones.has(deviceId) && entry.queued === 0) continue;
        // Сразу — чтобы дельты не шли закрытой сессии; в очереди — чтобы ждущая подписка этого телефона не вернула его.
        entry.phones.delete(deviceId);
        enqueue(entry, async () => {
          entry.phones.delete(deviceId);
          await settle(entry);
        }).catch(() => undefined);
      }
    },
    subscribers(ref) {
      return entries.get(refKey(ref))?.phones ?? NONE;
    },
    stop() {
      stopped = true;
      unlisten();
      for (const entry of entries.values()) entry.phones.clear();
      entries.clear();
    },
  };
}
