/**
 * Таймер простоя хоста: `startHost` зовёт `notify(idle)` при любой перемене
 * числа клиентов или занятых ключей `busy()`. Пока условие «пусто» держится
 * непрерывно `idleMs`, срабатывает `onIdle` — отсчёт сбрасывается любым
 * отклонением, а не измеряется от последнего события.
 */
export interface IdleWatcher {
  notify(idle: boolean): void;
  stop(): void;
}

export function watchIdle(idleMs: number, onIdle: () => void): IdleWatcher {
  let timer: NodeJS.Timeout | null = null;

  return {
    notify(idle) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (idle) {
        timer = setTimeout(onIdle, idleMs);
        timer.unref();
      }
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
