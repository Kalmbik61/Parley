import { isHumanUnread, needsYouCount, needsYouItems, needsYouWorkOfMap } from '@parley/core/attention';
import type { NeedsYouWork } from '@parley/core/attention';
import type { RoomsMailEvent } from '@parley/protocol';
import type { DeviceStore } from './devices.js';
import { refKey } from './host-link.js';
import type { HostLink } from './host-link.js';
import type { BridgeLog } from './log.js';
import type { PushGatewayClient } from './push-gateway-client.js';

/** Присутствие человека у Мака (спека 9.3): `null` — окна нет, то есть шлём всегда. */
export type Presence = 'active' | 'idle' | 'locked' | null;

export const PUSH_BATCH_MS = 3000;

export interface PushNotifierOptions {
  host: HostLink;
  devices: Pick<DeviceStore, 'list' | 'get' | 'setPush'>;
  /** `null` — адреса шлюза нет (до оплаты аккаунта Apple): push не шлётся. */
  gateway: PushGatewayClient | null;
  /** `routeId` хоста сейчас: после сброса (7.9) он другой. */
  routeId: () => string;
  log: BridgeLog;
  now?: () => number;
  batchMs?: number;
}

export interface PushNotifier {
  /** Окно сообщает присутствие; `null` — окно закрыто или управляющее соединение ушло. */
  setPresence(presence: Presence): void;
  stop(): void;
}

/**
 * Повод для push (спека 9.2): в множестве ключей ждущих пунктов эпохи появился ключ, которого не было.
 *  - сессия: `session:<project>␀<work>␀<session>:<n>`, `n` растёт на каждый вход в `needs-you`;
 *  - решение комнаты: `room:<project>/<work>/<room>:<proposalId>:<rev>`;
 *  - письмо: `letter:<project>/<work>:<messageId>` — из `rooms.mail`.
 * Уход пункта и падение счётчика push не дают. Первая картина эпохи — база: ждавшее при подключении push не даёт.
 * Пачка 3 с → проверка присутствия → по одному `POST /v1/push` на устройство с токеном; 410 стирает токен через
 * `DeviceStore` (единственный писатель `devices.json`); недоступный шлюз — пропуск без повтора, запись в лог.
 */
export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const { host, devices, gateway, log } = options;
  const now = options.now ?? Date.now;
  const batchMs = options.batchMs ?? PUSH_BATCH_MS;

  let epoch: string | null = null;
  let baselined = false;
  let presence: Presence = null;
  let timer: NodeJS.Timeout | null = null;
  let warnedNoGateway = false;

  let known = new Set<string>();
  /** Сессии в `needs-you` сейчас: базовый ключ → номер входа. */
  let inNeedsYou = new Map<string, number>();
  /** Наибольший номер входа по сессии за эпоху. */
  const counters = new Map<string, number>();
  const letterKeys = new Set<string>();
  /** Абсолютное число непрочитанных прямых писем по работам из `rooms.mail`; снимок обнуляет (его число свежее или равно). */
  const letterUnread = new Map<string, number>();

  const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

  function reset(nextEpoch: string | null): void {
    if (timer) clearTimeout(timer);
    timer = null;
    epoch = nextEpoch;
    baselined = false;
    known = new Set();
    inNeedsYou = new Map();
    counters.clear();
    letterKeys.clear();
    letterUnread.clear();
  }

  function works(): NeedsYouWork[] {
    return (host.snapshot?.entries ?? []).map((entry) => {
      const base = needsYouWorkOfMap(entry.projectPath, entry.map);
      const unread = letterUnread.get(workKey(entry.projectPath, entry.map.work.id));
      return unread === undefined ? base : { ...base, unreadLetters: unread };
    });
  }

  const activityOf = (projectPath: string, workId: string, sessionId: string) =>
    host.activity.get(refKey({ projectPath, workId, sessionId }))?.activity ?? null;

  function recompute(): void {
    if (host.status !== 'online' || host.snapshot === null) return;
    const next = new Set<string>();
    const nextIn = new Map<string, number>();
    for (const item of needsYouItems(works(), activityOf)) {
      if (item.kind === 'session') {
        const n = inNeedsYou.get(item.key) ?? (counters.get(item.key) ?? 0) + 1;
        counters.set(item.key, n);
        nextIn.set(item.key, n);
        next.add(`${item.key}:${n}`);
      } else if (item.kind === 'room') next.add(item.key);
    }
    for (const key of letterKeys) next.add(key);
    inNeedsYou = nextIn;
    const fresh = [...next].some((key) => !known.has(key));
    known = next;
    if (!baselined) {
      baselined = true;
      return;
    }
    if (fresh && timer === null) timer = setTimeout(() => void flush(), batchMs);
  }

  function onMail(event: RoomsMailEvent): void {
    letterUnread.set(workKey(event.projectPath, event.workId), event.unread.letters);
    for (const room of event.rooms) {
      if (room.roomId !== null) continue;
      const keyOf = (id: string): string => `letter:${event.projectPath}/${event.workId}:${id}`;
      for (const letter of room.letters) if (isHumanUnread(letter)) letterKeys.add(keyOf(letter.id));
      for (const read of room.reads) if (read.reader === 'human') letterKeys.delete(keyOf(read.id));
      for (const id of room.deleted) letterKeys.delete(keyOf(id));
    }
  }

  async function flush(): Promise<void> {
    timer = null;
    if (presence === 'active') {
      log.info('push.suppressed', { reason: 'presence' });
      return;
    }
    const count = needsYouCount(works(), activityOf);
    if (count === 0) return;
    if (gateway === null) {
      if (!warnedNoGateway) log.info('push.no_gateway');
      warnedNoGateway = true;
      return;
    }
    const route = options.routeId();
    await Promise.all(
      devices
        .list()
        .filter((d) => d.state === 'active' && d.push !== undefined)
        .map(async (d) => {
          const push = d.push!;
          const result = await gateway.send({ token: push.apnsToken, env: push.env, count, route });
          if (result !== 'invalid-token') return;
          // Токен недействителен: стираем, если телефон не успел прислать новый.
          if (devices.get(d.deviceId)?.push?.apnsToken !== push.apnsToken) return;
          try {
            await devices.setPush(d.deviceId, null, now());
            log.info('push.token_erased');
          } catch (error) {
            log.error('push.erase_failed', { error });
          }
        }),
    );
  }

  const unsubscribe = host.subscribe((event) => {
    if (event.type === 'status') {
      if (event.status !== 'online' || event.epoch !== epoch) reset(event.epoch);
      if (event.status === 'online') recompute();
      return;
    }
    if (event.type !== 'host' || host.status !== 'online') return;
    if (event.event === 'works.changed') letterUnread.clear();
    else if (event.event === 'rooms.mail') onMail(event.data as RoomsMailEvent);
    else if (event.event !== 'activity.changed') return;
    recompute();
  });
  if (host.status === 'online') {
    epoch = host.epoch;
    recompute();
  }

  return {
    setPresence(next) {
      presence = next;
    },
    stop() {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
