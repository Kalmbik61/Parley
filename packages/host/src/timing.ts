import { performance } from 'node:perf_hooks';

export interface StepTimer {
  /** Ждёт `work()`, прибавляя его длительность (мс) к шагу `name`; одинаковые имена складываются. Ошибка пробрасывается, время всё равно учтено. */
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** Шаги в порядке первого появления, мс округлены до целых; totalMs — с создания таймера. */
  result(): { totalMs: number; steps: Record<string, number> };
}

export function createStepTimer(now: () => number = () => performance.now()): StepTimer {
  const started = now();
  const spent = new Map<string, number>();
  return {
    async step<T>(name: string, work: () => Promise<T>): Promise<T> {
      const begin = now();
      // Имя заносится сразу: порядок — по первому появлению, даже если шаги вложены.
      if (!spent.has(name)) spent.set(name, 0);
      try {
        return await work();
      } finally {
        spent.set(name, (spent.get(name) ?? 0) + (now() - begin));
      }
    },
    result() {
      const steps: Record<string, number> = {};
      for (const [name, ms] of spent) steps[name] = Math.round(ms);
      return { totalMs: Math.round(now() - started), steps };
    },
  };
}
