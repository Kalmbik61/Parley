/**
 * Методы `sessions.*`: создание, возобновление, остановка, закрытие и удаление
 * сессий, прерванные падением хоста (план, куски 1.7 и 3.4). Сам запуск и правила создания живут в `SessionsService` —
 * здесь только разбор параметров протокола и форма ответа.
 */

import { effortsFor, hookedSince, isClaudeCode, loadProviders, readMap, resolveModelEffort } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { FeedService } from '../feed/feed-service.js';
import { switchEffort } from '../pty/effort-switch.js';
import { switchMode } from '../pty/mode-switch.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { atPrompt, busyError } from '../sessions/sessions-service.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';

export interface SessionMethodDeps {
  sessions: SessionsService;
  /**
   * Печать хоста и чтение экрана для `sessions.setMode` и `sessions.setEffort`; черновик хоста `sessions.setEffort`
   * держит, пока ползунок открыт.
   */
  pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText' | 'setHostDraft'>;
  /** Активность сессии: `sessions.setEffort` печатает только агенту у приглашения и после первого хука процесса. */
  activity: Pick<ActivityService, 'get'>;
  /** Будильник: пока он печатает указатель на письма, `sessions.setEffort` не начинает. */
  wake: Pick<WakeService, 'inFlight'>;
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
  sessionsSetEffort: Handler<'sessions.setEffort'>;
  sessionsSetModel: Handler<'sessions.setModel'>;
  sessionsResumeInterrupted: Handler<'sessions.resumeInterrupted'>;
}

export function createSessionHandlers(deps: SessionMethodDeps): SessionHandlers {
  return {
    sessionsCreate: async (params) => {
      // `exactOptionalPropertyTypes`: zod даёт `worktree?: boolean | undefined`,
      // а `CreateSessionInput.worktree?: boolean` явного `undefined` ключом не
      // принимает — той же дорогой, что `LaunchOptions.prompt` в `launch.ts`.
      const { worktree, model, effort, ...rest } = params;
      const ref = await deps.sessions.create({
        ...rest,
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

    // Ползунок `/effort` и `s` — печать хоста по явному выбору человека в меню чата (спека нормалайзера, 5.7).
    // Уровни — у модели из карты (или «по умолчанию»), их же предлагает меню; карта меняется, только когда
    // подвал подтвердил уровень. «По умолчанию» в идущей сессии не ставится: `/effort auto` стёр бы уровень,
    // сохранённый человеком. Одна смена на сессию за раз — общий замок с `sessions.setModel`.
    sessionsSetEffort: async ({ ref, effort }) =>
      deps.sessions.exclusive(ref, async () => {
        const handle = deps.pty.get(ref);
        if (handle === undefined) throw new HostError('not_found', `no live PTY for session ${ref.sessionId}`);
        const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
          (candidate) => candidate.id === ref.sessionId,
        );
        if (session === undefined) {
          throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
        }
        const entry = (await loadProviders())[session.provider];
        if (entry === undefined || !isClaudeCode(entry)) {
          throw new HostError('bad_request', 'effort of a running session can be changed only for Claude Code sessions');
        }
        const model = session.model;
        const resolved = resolveModelEffort(entry, { ...(model === undefined ? {} : { model }), effort });
        if ('error' in resolved) throw new HostError('bad_request', resolved.error);
        const levels = effortsFor(entry, model);
        if (levels === null) throw new HostError('bad_request', `provider ${entry.id} does not accept effort`);

        // Дальше — только то, что видно на экране и в журнале; при любом отказе в PTY не уходит ни одной клавиши.
        const live = deps.activity.get(ref);
        if (!atPrompt(live)) throw busyError('Wait until the agent is idle');
        // Ни одного хука с запуска процесса — хост не знает, что на экране: на вопросе доверия к папке Enter выбрал
        // бы ответ за человека (так же страхуется `pty.send`).
        if (!hookedSince(live?.activity, handle.startedAt)) {
          throw busyError('The agent has not reported ready since it started; check the terminal');
        }
        // `/effort` и Enter дописались бы к неотправленному тексту и ушли бы агенту вместе с ним.
        if (handle.hasDraft()) throw busyError('The input field has unsent text; send or clear it first');
        if (deps.wake.inFlight(ref)) throw busyError('A message pointer is being typed; try again in a moment');
        // Черновик хоста на время смены: будильник поверх него не печатает и не вклинится в клавиши ползунка.
        deps.pty.setHostDraft(ref, true);
        try {
          const result = await switchEffort(ref, effort, levels.map((level) => level.id), { pty: deps.pty });
          if (result.verified) await deps.sessions.setChoice(ref, { effort });
          return result;
        } finally {
          deps.pty.setHostDraft(ref, false);
        }
      }),

    // Модель — перезапуском через resume с новым `--model` (спека нормалайзера, 5.8): правила и порядок — в сервисе.
    sessionsSetModel: async ({ ref, model }) => deps.sessions.setModel(ref, model),

    sessionsResumeInterrupted: async (params) => {
      await deps.sessions.resumeInterrupted(params.refs);
      return { ok: true };
    },
  };
}
