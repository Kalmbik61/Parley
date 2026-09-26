/**
 * Методы `sessions.*`: создание, возобновление, остановка и удаление сессий
 * (план, кусок 1.7). Сам запуск и правила создания живут в `SessionsService` —
 * здесь только разбор параметров протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import type { SessionsService } from '../sessions/sessions-service.js';

export interface SessionMethodDeps {
  sessions: SessionsService;
}

export interface SessionHandlers {
  sessionsCreate: Handler<'sessions.create'>;
  sessionsResume: Handler<'sessions.resume'>;
  sessionsStop: Handler<'sessions.stop'>;
  sessionsDelete: Handler<'sessions.delete'>;
}

export function createSessionHandlers(deps: SessionMethodDeps): SessionHandlers {
  return {
    sessionsCreate: async (params) => {
      const ref = await deps.sessions.create(params);
      return { ref };
    },

    sessionsResume: async (params) => {
      await deps.sessions.launch(params.ref, 'resume');
      return { ok: true };
    },

    sessionsStop: async (params) => {
      await deps.sessions.stop(params.ref);
      return { ok: true };
    },

    sessionsDelete: async (params) => {
      await deps.sessions.delete(params.ref);
      return { ok: true };
    },
  };
}
