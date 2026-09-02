/** Счётчик значений: модели, инструменты, роли, типы записей — везде одно и то же. */
export class Counter {
  private readonly counts = new Map<string, number>();

  add(key: string | null): void {
    if (key === null) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Записи в порядке убывания частоты — так их и показывает UI. */
  toObject(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort((a, b) => b[1] - a[1]));
  }

  top(exclude: ReadonlySet<string> = new Set()): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const [key, count] of this.counts) {
      if (exclude.has(key)) continue;
      if (count > bestCount) {
        best = key;
        bestCount = count;
      }
    }
    return best;
  }
}

/** Реплика в одну строку — заголовок в списке всё равно однострочный. */
export function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Не модель, а служебная пометка Claude Code — в бейдже показывать нечего. */
export const SYNTHETIC_MODEL = '<synthetic>';
