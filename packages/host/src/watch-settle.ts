/**
 * Дочитывание после включения fs-наблюдателя.
 *
 * `fs.watch` на macOS включается не сразу: запись, сделанная между вызовом и реальным запуском потока событий
 * (под нагрузкой — десятки и сотни миллисекунд), не приходит никогда, и до следующей записи её не увидит никто.
 * Одно чтение сразу после создания наблюдателя окна не закрывает — оно само укладывается в него. Поэтому
 * после создания наблюдателя источник перечитывается ещё несколько раз с нарастающими паузами: чтение без
 * новых данных ничего не меняет, а потерянная запись находится не позже последней паузы.
 */

/** Паузы дочитывания от создания наблюдателя, мс. */
export const WATCH_SETTLE_MS: readonly number[] = [300, 1000, 3000];

export interface Settler {
  /** Начинает отсчёт заново: прежние ещё не сработавшие паузы отменяются. */
  schedule(): void;
  cancel(): void;
}

export function createSettler(run: () => void, delays: readonly number[] = WATCH_SETTLE_MS): Settler {
  let timers: NodeJS.Timeout[] = [];
  const cancel = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  return {
    schedule() {
      cancel();
      // `unref`: дочитывание не должно держать процесс живым.
      timers = delays.map((ms) => setTimeout(run, ms).unref());
    },
    cancel,
  };
}
