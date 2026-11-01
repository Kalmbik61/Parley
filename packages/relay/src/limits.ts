// Лимиты по IP (спека 6.4). Счётчики только в памяти; каждая карта ограничена по размеру.
export const MINUTE = 60_000;
export const DAY = 86_400_000;

export interface Bucket {
  limit: number;
  windowMs: number;
}

export const BUCKETS = {
  connect: { limit: 30, windowMs: MINUTE },
  pair: { limit: 10, windowMs: MINUTE },
  newRoute: { limit: 5, windowMs: DAY },
} as const satisfies Record<string, Bucket>;

export type BucketName = keyof typeof BUCKETS;

interface Window {
  start: number;
  n: number;
}

export interface LimiterOptions {
  buckets?: Record<BucketName, Bucket>;
  /** Потолок записей в каждой карте: память не растёт без предела. */
  maxEntries?: number;
  now?: () => number;
}

export class Limiter {
  private readonly maps = new Map<BucketName, Map<string, Window>>();
  private readonly buckets: Record<BucketName, Bucket>;
  private readonly max: number;
  private readonly now: () => number;

  constructor(o: LimiterOptions = {}) {
    this.buckets = o.buckets ?? BUCKETS;
    this.max = o.maxEntries ?? 50_000;
    this.now = o.now ?? Date.now;
  }

  /** Считает событие; false — лимит окна исчерпан. */
  hit(name: BucketName, key: string): boolean {
    const b = this.buckets[name];
    let map = this.maps.get(name);
    if (!map) this.maps.set(name, (map = new Map()));
    const t = this.now();
    let w = map.get(key);
    if (w && t - w.start >= b.windowMs) w = undefined;
    if (!w) {
      if (map.size >= this.max) this.evict(map, b.windowMs, t);
      w = { start: t, n: 0 };
    }
    map.delete(key);
    map.set(key, w);
    if (w.n >= b.limit) return false;
    w.n++;
    return true;
  }

  size(name: BucketName): number {
    return this.maps.get(name)?.size ?? 0;
  }

  private evict(map: Map<string, Window>, windowMs: number, t: number): void {
    for (const [k, w] of map) if (t - w.start >= windowMs) map.delete(k);
    // Всё ещё полно: убираем самые давние по обращению (порядок Map).
    while (map.size >= this.max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
}
