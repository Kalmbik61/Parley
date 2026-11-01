import type { WorksSnapshot } from '@parley/protocol';
import { REMOTE_EVENTS, projectWorksSnapshot } from '@parley/protocol/remote';
import type { HostLink, HostLinkEvent } from './host-link.js';
import { refKey } from './host-link.js';
import type { PhoneSessions } from './session-contract.js';
import { COALESCE_MS, MAX_FRAME_TO_PHONE, MAX_QUEUE_BYTES } from './limits.js';
import type { BridgeLog } from './log.js';

export interface FanoutOptions {
  host: HostLink;
  sessions: PhoneSessions;
  log: BridgeLog;
  coalesceMs?: number;
}

export interface Fanout {
  /** Сессия подтверждена (A7): начальное состояние или `bridge.status`. */
  sessionActive(deviceId: string): void;
  sessionClosed(deviceId: string): void;
  /** Кадр телефону через единую очередь; `false` — кадр не ушёл (больше 8 МиБ или сессия не активна). */
  send(deviceId: string, message: unknown): boolean;
  stop(): void;
}

interface Phone {
  statusKey: string | null;
  /** Начальное состояние отправлено: живые события идут. */
  live: boolean;
  lastRevision: number;
  pendingWorks: WorksSnapshot | null;
  pendingActivity: Map<string, unknown>;
  worksTimer?: NodeJS.Timeout | undefined;
  activityTimer?: NodeJS.Timeout | undefined;
}

const encoder = new TextEncoder();
const LIVE_EVENTS: ReadonlySet<string> = new Set(REMOTE_EVENTS);

export function createFanout(options: FanoutOptions): Fanout {
  const { host, sessions, log } = options;
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const phones = new Map<string, Phone>();

  function drop(deviceId: string): void {
    const phone = phones.get(deviceId);
    if (!phone) return;
    clearTimers(phone);
    phones.delete(deviceId);
  }

  function clearTimers(phone: Phone): void {
    if (phone.worksTimer) clearTimeout(phone.worksTimer);
    if (phone.activityTimer) clearTimeout(phone.activityTimer);
    phone.worksTimer = undefined;
    phone.activityTimer = undefined;
    phone.pendingWorks = null;
    phone.pendingActivity = new Map();
  }

  function send(deviceId: string, message: unknown): boolean {
    if (!phones.has(deviceId)) return false;
    const frame = encoder.encode(JSON.stringify(message));
    if (frame.length > MAX_FRAME_TO_PHONE) {
      log.warn('fanout.frame_too_large', { deviceId, size: frame.length });
      return false;
    }
    if (!sessions.send(deviceId, frame)) {
      // Подтверждённой сессии нет: телефон отпущен.
      drop(deviceId);
      return false;
    }
    if (sessions.bufferedBytes(deviceId) > MAX_QUEUE_BYTES) {
      log.warn('fanout.slow_phone', { deviceId });
      drop(deviceId);
      sessions.close(deviceId, 'slow');
      return false;
    }
    return true;
  }

  function sendStatus(deviceId: string, phone: Phone): void {
    send(deviceId, { event: 'bridge.status', data: { host: host.status, epoch: host.epoch } });
    phone.statusKey = `${host.status}|${host.epoch}`;
  }

  /** §5.5: `bridge.status`, проекция снимка, `activity.snapshot`; потом живые события. */
  function sendInitial(deviceId: string, phone: Phone): void {
    const snapshot = host.snapshot;
    if (!snapshot) {
      sendStatus(deviceId, phone);
      return;
    }
    let projected: ReturnType<typeof projectWorksSnapshot>;
    try {
      projected = projectWorksSnapshot(snapshot);
    } catch (error) {
      // Телефон не остаётся без единого кадра: статус уходит, сессия закрывается, и он переподключится с отступом.
      log.error('fanout.projection_failed', { error });
      sendStatus(deviceId, phone);
      drop(deviceId);
      sessions.close(deviceId, 'protocol');
      return;
    }
    sendStatus(deviceId, phone);
    if (!phones.has(deviceId)) return;
    send(deviceId, { event: 'works.changed', data: projected });
    if (!phones.has(deviceId)) return;
    send(deviceId, {
      event: 'activity.snapshot',
      data: { epoch: host.epoch, items: [...host.activity.values()].map((e) => ({ ref: e.ref, activity: e.activity, metrics: e.metrics })) },
    });
    phone.lastRevision = projected.revision;
    phone.live = true;
  }

  function refresh(deviceId: string, phone: Phone): void {
    clearTimers(phone);
    phone.live = false;
    phone.lastRevision = -1;
    if (host.status === 'online') {
      sendInitial(deviceId, phone);
    } else {
      const key = `${host.status}|${host.epoch}`;
      if (key !== phone.statusKey) sendStatus(deviceId, phone);
    }
  }

  function flushWorks(deviceId: string, phone: Phone): void {
    phone.worksTimer = undefined;
    const raw = phone.pendingWorks;
    phone.pendingWorks = null;
    if (!raw) return;
    try {
      const projected = projectWorksSnapshot(raw);
      phone.lastRevision = projected.revision;
      send(deviceId, { event: 'works.changed', data: projected });
    } catch (error) {
      log.error('fanout.projection_failed', { error });
    }
  }

  function flushActivity(deviceId: string, phone: Phone): void {
    phone.activityTimer = undefined;
    const items = [...phone.pendingActivity.values()];
    phone.pendingActivity = new Map();
    for (const data of items) {
      if (!send(deviceId, { event: 'activity.changed', data })) return;
    }
  }

  function onWorksChanged(deviceId: string, phone: Phone, data: unknown): void {
    const raw = data as WorksSnapshot;
    const revision = raw?.revision ?? 0;
    // Старый `revision` внутри эпохи не побеждает; новая эпоха сбрасывает защиту (`refresh`).
    const floor = phone.pendingWorks ? (phone.pendingWorks.revision ?? 0) : phone.lastRevision;
    if (revision < floor) return;
    phone.pendingWorks = raw;
    phone.worksTimer ??= setTimeout(() => flushWorks(deviceId, phone), coalesceMs);
  }

  function onActivityChanged(deviceId: string, phone: Phone, data: unknown): void {
    const ref = (data as { ref?: Parameters<typeof refKey>[0] } | null)?.ref;
    if (!ref) return;
    phone.pendingActivity.set(refKey(ref), data);
    phone.activityTimer ??= setTimeout(() => flushActivity(deviceId, phone), coalesceMs);
  }

  const unsubscribe = host.subscribe((event: HostLinkEvent) => {
    if (event.type === 'status') {
      for (const [deviceId, phone] of [...phones]) {
        if (phones.get(deviceId) === phone) refresh(deviceId, phone);
      }
      return;
    }
    if (!LIVE_EVENTS.has(event.event)) return;
    for (const [deviceId, phone] of [...phones]) {
      if (!phone.live || phones.get(deviceId) !== phone) continue;
      if (event.event === 'works.changed') onWorksChanged(deviceId, phone, event.data);
      else if (event.event === 'activity.changed') onActivityChanged(deviceId, phone, event.data);
      else send(deviceId, { event: event.event, data: event.data });
    }
  });

  return {
    sessionActive(deviceId) {
      drop(deviceId);
      const phone: Phone = { statusKey: null, live: false, lastRevision: -1, pendingWorks: null, pendingActivity: new Map() };
      phones.set(deviceId, phone);
      refresh(deviceId, phone);
    },
    sessionClosed: drop,
    send,
    stop() {
      unsubscribe();
      for (const deviceId of [...phones.keys()]) drop(deviceId);
    },
  };
}
