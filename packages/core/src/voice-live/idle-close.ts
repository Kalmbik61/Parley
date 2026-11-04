/**
 * Автозакрытие Live (спека «Голос↔Ассистент» §9, T6): сессия закрывается после `IDLE_CLOSE_MS` без речи человека,
 * без воспроизведения модели, без открытых Request и без речи в очереди. Сигналы речи — локальные (VAD клиента и уровень
 * удалённого трека), поэтому политика живёт на клиенте. Закрытие идёт обычным путём (`voice.session.close`): usage
 * записывает хост по `session.closed`. Открытые job не отменяются.
 *
 * Тишина отсчитывается от последней активности: сигнал речи, воспроизведения, делегация или момент, когда было занято.
 * `onIdle` вызывается один раз на сессию.
 */
export const IDLE_CLOSE_MS = 3 * 60_000;

export interface IdleCloserDeps {
  now(): number;
  /** Есть открытые Request, речь в очереди или ещё ждущие делегации: сессия нужна. */
  busy(): boolean;
  onIdle(): void;
  idleMs?: number;
}

export interface IdleCloser {
  /** Началась Live-сессия. */
  start(): void;
  humanSpeaking(value: boolean): void;
  modelPlaying(value: boolean): void;
  /** Любая другая активность (например, новая делегация). */
  activity(): void;
  /** Раз в тик. */
  step(): void;
  /** Сессия закончилась. */
  stop(): void;
}

export function createIdleCloser(deps: IdleCloserDeps): IdleCloser {
  const idleMs = deps.idleMs ?? IDLE_CLOSE_MS;
  let running = false;
  let fired = false;
  let human = false;
  let model = false;
  let lastActive = 0;

  const touch = (): void => {
    lastActive = deps.now();
  };

  return {
    start() {
      running = true;
      fired = false;
      human = false;
      model = false;
      touch();
    },
    humanSpeaking(value) {
      human = value;
      touch();
    },
    modelPlaying(value) {
      model = value;
      touch();
    },
    activity: touch,
    step() {
      if (!running || fired) return;
      if (human || model || deps.busy()) {
        touch();
        return;
      }
      if (deps.now() - lastActive < idleMs) return;
      fired = true;
      deps.onIdle();
    },
    stop() {
      running = false;
    },
  };
}
