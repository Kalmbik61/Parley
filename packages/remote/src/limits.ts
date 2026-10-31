/** Потолки прикладного слоя моста (спека 5.5, 5.7). */
export const MAX_FRAME_FROM_PHONE = 64 * 1024;
export const MAX_FRAME_TO_PHONE = 8 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const MUTATING_PER_MINUTE = 30;
export const COALESCE_MS = 1000;

/** Изменяющие методы этапа A (спека 5.7). Этап B добавит записи таблицы 4.2. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(['feed.decide', 'rooms.resolveProposal']);

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
    forget(key: string): void {
      hits.delete(key);
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
