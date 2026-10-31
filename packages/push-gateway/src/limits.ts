const HOUR = 3_600_000;

export interface LimitOptions {
  tokenIntervalMs?: number;
  tokenPerHour?: number;
  ipPerHour?: number;
  /** Верхняя граница записей в каждой карте: память не растёт без предела. */
  maxEntries?: number;
  now?: () => number;
}

interface Window {
  start: number;
  n: number;
  last: number;
}

/** Счётчики в памяти: ничего не пишется на диск. Ключи — только в этих картах. */
export class Limiter {
  private readonly tokens = new Map<string, Window>();
  private readonly ips = new Map<string, Window>();
  private readonly interval: number;
  private readonly perHour: number;
  private readonly ipPerHour: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(o: LimitOptions = {}) {
    this.interval = o.tokenIntervalMs ?? 3000;
    this.perHour = o.tokenPerHour ?? 60;
    this.ipPerHour = o.ipPerHour ?? 600;
    this.max = o.maxEntries ?? 100_000;
    this.now = o.now ?? Date.now;
  }

  /** Считает запрос с IP; false — лимит исчерпан. */
  allowIp(ip: string): boolean {
    const w = this.touch(this.ips, ip);
    if (w.n >= this.ipPerHour) return false;
    w.n++;
    return true;
  }

  /** Считает push на токен; false — слишком часто или слишком много за час. */
  allowToken(token: string): boolean {
    const t = this.now();
    const w = this.touch(this.tokens, token);
    if (w.n > 0 && t - w.last < this.interval) return false;
    if (w.n >= this.perHour) return false;
    w.n++;
    w.last = t;
    return true;
  }

  size(): { tokens: number; ips: number } {
    return { tokens: this.tokens.size, ips: this.ips.size };
  }

  private touch(map: Map<string, Window>, key: string): Window {
    const t = this.now();
    let w = map.get(key);
    if (w && t - w.start >= HOUR) {
      map.delete(key);
      w = undefined;
    }
    if (!w) {
      if (map.size >= this.max) this.evict(map, t);
      w = { start: t, n: 0, last: 0 };
    }
    // Перевставка держит порядок Map по давности последнего обращения.
    map.delete(key);
    map.set(key, w);
    return w;
  }

  private evict(map: Map<string, Window>, t: number): void {
    for (const [k, w] of map) {
      if (t - w.start >= HOUR) map.delete(k);
    }
    // Всё ещё полно: убираем самые давние записи.
    while (map.size >= this.max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
}
