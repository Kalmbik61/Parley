/**
 * Методы `sessions.*`: создание, возобновление, остановка, закрытие и удаление
 * сессий, прерванные падением хоста (план, куски 1.7 и 3.4). Сам запуск и правила создания живут в `SessionsService` —
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
  sessionsClose: Handler<'sessions.close'>;
  sessionsInterrupted: Handler<'sessions.interrupted'>;
  sessionsResumeInterrupted: Handler<'sessions.resumeInterrupted'>;
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

    sessionsClose: async (params) => {
      await deps.sessions.close(params.ref);
      return { ok: true };
    },

    sessionsInterrupted: async () => ({ refs: deps.sessions.interrupted() }),

    sessionsResumeInterrupted: async (params) => {
      await deps.sessions.resumeInterrupted(params.refs);
      return { ok: true };
    },
  };
}
