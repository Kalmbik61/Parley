/**
 * Методы `wake.*`: пауза и состояние будильника живых сессий (план, кусок 1.8).
 * Пауза хранится в памяти самого сервиса — здесь только разбор параметров
 * протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import type { WakeService } from '../wake/wake-service.js';

export interface WakeMethodDeps {
  wake: WakeService;
}

export interface WakeHandlers {
  wakePause: Handler<'wake.pause'>;
  wakeResume: Handler<'wake.resume'>;
  wakeState: Handler<'wake.state'>;
}

export function createWakeHandlers(deps: WakeMethodDeps): WakeHandlers {
  return {
    wakePause: async () => {
      deps.wake.pause();
      return { paused: deps.wake.paused() };
    },

    wakeResume: async () => {
      deps.wake.resume();
      return { paused: deps.wake.paused() };
    },

    wakeState: async () => ({ paused: deps.wake.paused() }),
  };
}
