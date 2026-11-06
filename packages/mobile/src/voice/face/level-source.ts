// Громкость 0..1 для роя в обход React: экран не перерисовывается, рой читает значение в своём цикле кадров.
export interface LevelSource {
  get(): number;
  /** Слушатель зовётся при каждой смене значения; возвращает отписку. */
  subscribe(listener: (level: number) => void): () => void;
}

export interface MutableLevelSource extends LevelSource {
  set(level: number): void;
}

export function createLevelSource(): MutableLevelSource {
  let level = 0;
  const listeners = new Set<(level: number) => void>();
  return {
    get: () => level,
    set(next) {
      if (next === level) return;
      level = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Источник без громкости: всегда 0. */
export const SILENT: LevelSource = { get: () => 0, subscribe: () => () => {} };
