/**
 * Методы `sessions.*`: создание, возобновление, остановка, закрытие и удаление
 * сессий, прерванные падением хоста (план, куски 1.7 и 3.4). Сам запуск и правила создания живут в `SessionsService` —
 * здесь только разбор параметров протокола и форма ответа.
 */

import type { Handler } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';
import { switchMode } from '../pty/mode-switch.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';

export interface SessionMethodDeps {
  sessions: SessionsService;
  /** Печать хоста и чтение экрана для `sessions.setMode`. */
  pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText'>;
  /** Лента узнаёт сверенный режим; без неё метод только отвечает. */
  feed?: Pick<FeedService, 'noteMode'>;
}

export interface SessionHandlers {
  sessionsCreate: Handler<'sessions.create'>;
  sessionsResume: Handler<'sessions.resume'>;
  sessionsStop: Handler<'sessions.stop'>;
  sessionsDelete: Handler<'sessions.delete'>;
  sessionsClose: Handler<'sessions.close'>;
  sessionsInterrupted: Handler<'sessions.interrupted'>;
  sessionsSetMode: Handler<'sessions.setMode'>;
  sessionsResumeInterrupted: Handler<'sessions.resumeInterrupted'>;
}

export function createSessionHandlers(deps: SessionMethodDeps): SessionHandlers {
  return {
    sessionsCreate: async (params) => {
      // `exactOptionalPropertyTypes`: zod даёт `worktree?: boolean | undefined`,
      // а `CreateSessionInput.worktree?: boolean` явного `undefined` ключом не
      // принимает — той же дорогой, что `LaunchOptions.prompt` в `launch.ts`.
      const { worktree, model, effort, role, agent, ...rest } = params;
      const ref = await deps.sessions.create({
        ...rest,
        ...(role === undefined ? {} : { role }),
        ...(agent === undefined ? {} : { agent }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      });
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
      await deps.sessions.delete(params.ref, params.force);
      return { ok: true };
    },

    sessionsClose: async (params) => {
      await deps.sessions.close(params.ref);
      return { ok: true };
    },

    sessionsInterrupted: async () => ({ refs: deps.sessions.interrupted() }),

    // Нажатия Shift+Tab — печать хоста по явному действию человека; ответов хукам тут нет.
    sessionsSetMode: async (params) => {
      const result = await switchMode({ pty: deps.pty }, params.ref, params.mode);
      if (result.mode !== null) deps.feed?.noteMode(params.ref, result.mode);
      return result;
    },

    sessionsResumeInterrupted: async (params) => {
      await deps.sessions.resumeInterrupted(params.refs);
      return { ok: true };
    },
  };
}
