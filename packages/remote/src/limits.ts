/** Потолки прикладного слоя моста (спека 5.5, 5.7). */
export const MAX_FRAME_FROM_PHONE = 64 * 1024;
export const MAX_FRAME_TO_PHONE = 8 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const MUTATING_PER_MINUTE = 30;
export const COALESCE_MS = 1000;
/** Чтения (всё, что не изменяет и не метод моста) — на устройство, поверх `MAX_IN_FLIGHT`. */
export const READS_PER_MINUTE = 120;
/** `push.register` пишет `devices.json`: чаще 10 раз в минуту не нужно. */
export const PUSH_REGISTER_PER_MINUTE = 10;

/**
 * Изменяющие методы этапа A (спека 5.7): решения и запуск с телефона (`sessions.create`, `rooms.create`, `rooms.send`,
 * правки 10–11). Этап B добавит записи таблицы 4.2. Метод, которого нет в белом списке, всё равно отказывается раньше.
 */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'feed.decide',
  'rooms.resolveProposal',
  'sessions.create',
  'rooms.create',
  'rooms.send',
  // Сообщение агенту (A27, правки 13): повтор с тем же `clientMsgId` лимит не тратит (A30).
  'pty.send',
  // Решение по карточке согласия (A27): как `feed.decide`; цель в журнале — `id` карточки.
  'consents.decide',
  // Пробуждение спящей сессии (A37a, правки 19): лимит и журнал `call` с сессией из `ref`; `phone.action` нет.
  'sessions.resume',
]);

/** Скользящее окно: не больше `max` событий за `windowMs`, по одному счётчику на ключ. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** `true` — учтено; `false` — предел, событие не учитывается. */
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
