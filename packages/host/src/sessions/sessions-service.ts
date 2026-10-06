/**
 * Создание, запуск, остановка и удаление сессий — план, кусок 1.7.
 *
 * `launch()` — общая точка входа что для интерактивного запуска
 * (`sessions.create`/`sessions.resume`), что для фонового autoLaunch: план
 * команды строит core (`planLaunch`/`planResume`/`planNew`), а хост только
 * находит бинарь, собирает окружение и заводит PTY. Канал звонка здесь всегда
 * выключен (`{ channel: false }`) — хост про него ничего не знает (спека 4.2).
 *
 * Две оси (кусок 3.4): «Остановить» усыпляет (`sleeping` — письмо поднимет),
 * «Закрыть» закрывает насовсем (`closed`). Закрытую не поднимает ни письмо, ни
 * ручной `resume`, а живой PTY закрытой в карте сессии хост гасит сам.
 */

import {
  addMessage,
  baseBranchOf,
  createChildSession,
  createNewSession,
  createPendingSession,
  createWorktree,
  deleteSession,
  DirtyWorktreeError,
  discardWorktree,
  finishExited,
  findRunnerBinary,
  GitStateError,
  InvalidRevisionError,
  feedSupported,
  isGitRepo,
  loadConfig,
  loadProviders,
  isClaudeCode,
  providerReadiness,
  providerReadinessError,
  readSecret,
  openEvents,
  planLaunch,
  planNew,
  planResume,
  plannedWorktree,
  processStartedAt,
  readMap,
  sessionTag,
  startSession,
  SYSTEM,
  transitionSession,
  updateMap,
  workPaths,
  writeBrief,
  type ModelEffortChoice,
  type WorkEntry,
  type ProviderEntry,
} from '@parley/core';
import { HOST_ERROR_REASONS, refKey } from '@parley/protocol';
import type { SessionRef, WorksSnapshot } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { HookServer } from '../hooks/hook-server.js';
import type { ProviderVersions } from '../providers/versions.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { gitFailure } from '../worktrees/worktrees-service.js';
import { createSkillInstaller } from './agent-skills.js';
import { autoLaunchCandidates } from './auto-launch.js';
import { findInterrupted } from './interrupted.js';
import { resolveModelChoice } from './model-choice.js';
import { providerLaunchEnv } from './provider-env.js';

export interface CreateSessionInput {
  projectPath: string;
  workId: string | null;
  provider: string;
  label: string;
  task: string;
  parent: string | null;
  /** Своя рабочая копия git — план пишется сразу, каталог заводит `launch()` (спека 8.1). */
  worktree?: boolean;
  /**
   * Модель и усилие из диалога запуска (дизайн комнат, 3.2; спека нормалайзера, 5.3). Пару проверяет
   * `resolveModelChoice`: вне каталога провайдера — `bad_request`, пустое значение — «по умолчанию», без флага.
   * Разрешённый выбор ложится в запись сессии (`WorkSession.model`, `.effort`): его берут и повторный запуск,
   * и resume.
   */
  model?: string;
  effort?: string;
}

export type LaunchMode = 'launch' | 'resume' | 'new';

/** Что `launch()` передаёт плану запуска сверх самой сессии. */
export interface LaunchChoice {
  /** Указатель первым ходом `resume`, если провайдер его принимает. */
  prompt?: string;
  model?: string;
  effort?: string;
}

export interface SessionsService {
  create(input: CreateSessionInput): Promise<SessionRef>;
  /** `prompt` — указатель первым ходом `resume`; `model` и `effort` перекрывают выбор из карты. */
  launch(ref: SessionRef, mode: LaunchMode, options?: LaunchChoice): Promise<void>;
  stop(ref: SessionRef): Promise<void>;
  /** Насовсем: `closed` в карте и остановка PTY, если он жив. */
  close(ref: SessionRef): Promise<void>;
  /** `force` — грязный worktree отбрасывается вместе с сессией; без него — `conflict` (спека 8.3). */
  delete(ref: SessionRef, force?: boolean): Promise<void>;
  live(ref: SessionRef): boolean;
  stopAll(): Promise<void>;
  /** Собирает прерванных посреди хода — на старте хоста, после сверки живости. */
  collectInterrupted(): Promise<void>;
  /** Прерванные, которые всё ещё спят: их ещё не подняли и не закрыли. */
  interrupted(): SessionRef[];
  /** Поднимает прерванных без промпта — только с согласия человека (спека 10). */
  resumeInterrupted(refs: readonly SessionRef[]): Promise<void>;
  /**
   * Выбор модели и effort в записи сессии (спека нормалайзера, 5.5): `null` убирает поле («по умолчанию»),
   * `undefined` оставляет как было. Процесс не трогает.
   */
  setChoice(ref: SessionRef, choice: { model?: string | null; effort?: string | null }): Promise<void>;
  /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
  exclusive: SwitchLock;
}

/**
 * Лента вида «Chat» (план 2026-10-01, Task 2): приёмник HTTP-хуков и версии CLI для порога. Оба
 * необязательны — без них сессии запускаются как до ленты: файл настроек без HTTP-хуков, токена нет.
 */
export interface SessionsFeedOptions {
  hooks?: Pick<HookServer, 'url' | 'register' | 'unregister'>;
  providerVersions?: ProviderVersions;
}

/** Ключ работы для склейки снимков «до» и «после» в autoLaunch. */
const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/**
 * Агент у своего приглашения (спека нормалайзера, 5.7–5.8): ход окончен — `idle` или ещё не просмотренный
 * `unseen`, как у доставки писем (`delivery.ts` в core). `working` и `blocked` — занят; сведений нет — тоже занят:
 * печатать и перезапускать вслепую хост не станет.
 */
export function atPrompt(live: SessionLive | undefined): boolean {
  const state = live?.activity.activity;
  return state === 'idle' || state === 'unseen';
}

/** Отказ «агент занят»: `conflict` с причиной `busy` — окно по ней выбирает свой текст. */
export function busyError(message: string): HostError {
  return new HostError('conflict', message, { reason: HOST_ERROR_REASONS.busy });
}

/** Замок смены модели и effort: вторая смена той же сессии, пока идёт первая, — `busy`. */
export type SwitchLock = <T>(ref: SessionRef, run: () => Promise<T>) => Promise<T>;

/**
 * Одна смена модели или effort на сессию за раз (спека нормалайзера, 5.7–5.8): двойной клик или `setEffort` во время
 * `setModel` получают `busy` до первой клавиши — клавиши двух смен не смешиваются, перезапуск один. Ключ ставится
 * синхронно, до первого `await`, и снимается и после сбоя.
 */
export function createSwitchLock(): SwitchLock {
  const running = new Set<string>();
  return async <T>(ref: SessionRef, run: () => Promise<T>): Promise<T> => {
    const key = refKey(ref);
    if (running.has(key)) throw busyError('Another model or effort change of this session is in progress');
    running.add(key);
    try {
      return await run();
    } finally {
      running.delete(key);
    }
  };
}

export function createSessionsService(
  host: HostContext,
  works: WorksService,
  pty: PtyManager,
  activity: ActivityService,
  feed: SessionsFeedOptions = {},
): SessionsService {
  const { hooks, providerVersions } = feed;
  // Одна смена модели или effort на сессию за раз — общий замок `sessions.setEffort` и `sessions.setModel`.
  const exclusive = createSwitchLock();

  // Между чтением карты и `pty.start` есть await-и (план команды, поиск
  // бинаря) — за это время может подоспеть второй вызов на ту же сессию:
  // ручной `sessions.resume` поверх ещё не отработавшего autoLaunch или два
  // срабатывания autoLaunch подряд на одном и том же изменении карты.
  const launching = new Set<string>();

  // Запись карты по выходу процесса идёт асинхронно и без ожидания в самом
  // обработчике `exit` (его сигнатура синхронная) — но `stop()`/`delete()`
  // обязаны вернуться только после того, как карта уже носит `sleeping`, иначе
  // вызывающая сторона (тест, `sessions.delete`) увидит гонку с ещё не
  // дописанным файлом. Промис по каждой сессии живёт здесь до своего
  // завершения, `stop()` его дожидается следом за самим выходом процесса.
  const finalizing = new Map<string, Promise<void>>();

  // Запись `active` после старта процесса идёт позже самого `pty.start`: между
  // ними — await-ы (время старта процесса из ОС, запись карты). Процесс, который
  // вышел сразу (провалившийся `--resume`), иначе успел бы записать `sleeping`
  // раньше, чем `startSession` — `active`, и карта осталась бы с живой сессией
  // без процесса. Выход дожидается записи старта.
  const starting = new Map<string, Promise<void>>();

  // Скилл `parley` в проект и в worktree сессии перед каждым запуском (`agent-skills.ts`).
  const installSkill = createSkillInstaller(host);

  // Закрываемые сейчас: между остановкой PTY и записью `closed` сессия успевает
  // побыть `sleeping`, и письмо в этот миг подняло бы её обратно.
  const closing = new Set<string>();

  // Прерванные посреди хода на старте хоста (спека 10) — до согласия человека.
  let interruptedRefs: SessionRef[] = [];

  // Процесс вышел — сессия засыпает (спецификация 7.1): письмо её поднимет.
  // Итог `done`/`failed` — другая ось, выход процесса его не трогает.
  pty.on('exit', (ref, exit) => {
    const key = refKey(ref);
    // Токен приёмника живёт, пока жив процесс: `SessionEnd` приходит до выхода, позже хуков нет.
    hooks?.unregister(ref);
    const done = (starting.get(key) ?? Promise.resolve())
      .then(() =>
        finishExited(ref.projectPath, ref.workId, ref.sessionId, {
          exitCode: exit.exitCode,
          signal: exit.signal ?? undefined,
        }),
      )
      .catch((error: unknown) => {
        host.log.error('переход сессии в sleeping не записался', { ref, error: String(error) });
      })
      .finally(() => {
        finalizing.delete(key);
      });
    finalizing.set(key, done);
  });

  /**
   * Адрес приёмника хуков для запуска — только `claude` не ниже `FEED_MIN_VERSION`. Версия — проба
   * старта хоста по команде провайдера (короткая, ждём её); нет версии, старый `claude`, codex и прочие —
   * без хуков, окно покажет терминал.
   */
  async function feedHookUrl(provider: string): Promise<string | undefined> {
    if (!isClaudeCode(provider) || hooks === undefined || providerVersions === undefined) return undefined;
    const url = hooks.url();
    if (url === null) return undefined;
    await providerVersions.ready;
    const entry = (await loadProviders())[provider];
    if (entry === undefined) return undefined;
    const version = providerVersions.get(entry.runner.command);
    return version !== null && feedSupported(version) ? url : undefined;
  }

  async function readyProvider(provider: string): Promise<ProviderEntry> {
    const entry = (await loadProviders())[provider];
    if (entry === undefined) throw new HostError('bad_request', `unknown provider ${provider}`);
    const readiness = await providerReadiness(entry, {
      ...(providerVersions === undefined ? {} : { probeVersion: (command) => providerVersions.fresh(command) }),
    });
    const refusal = providerReadinessError(entry, readiness);
    if (refusal !== null) throw new HostError('bad_request', refusal);
    return entry;
  }

  async function launch(
    ref: SessionRef,
    mode: LaunchMode,
    options: LaunchChoice = {},
  ): Promise<void> {
    const key = refKey(ref);
    if (launching.has(key) || closing.has(key) || pty.get(ref) !== undefined) return;
    launching.add(key);
    try {
      const map = await readMap(ref.projectPath, ref.workId);
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) {
        throw new Error(`session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      // Закрытая не поднимается ничем (спека 7.1): процесс без пути в `active`
      // жил бы без записи в карте.
      if (session.lifecycle === 'closed') {
        throw new Error(`session ${ref.sessionId} is closed`);
      }

      // Before planned worktree creation, settings, skills and hook registration; repeated every launch.
      const entry = await readyProvider(session.provider);

      // Worktree запланирован (`plannedWorktree` в `create()` или `spawn_session`
      // в core), но каталога на диске ещё нет — заводим его перед первым же
      // запуском, в том числе перед `resume` прерванной сессии (спека 8.1–8.3).
      if (session.worktree !== null && session.worktree.createdAt === null) {
        const worktree = session.worktree;
        try {
          await createWorktree(ref.projectPath, worktree);
        } catch (error) {
          const text = `worktree for ${sessionTag(ref.sessionId)} was not created: ${(error as Error).message}`;
          host.broadcast('host.notice', {
            kind: 'launch-failed',
            ref,
            text,
            at: new Date().toISOString(),
          });
          const parentId = session.parent;
          if (parentId !== null) {
            await updateMap(ref.projectPath, ref.workId, (current) => {
              if (current.sessions.some((candidate) => candidate.id === parentId)) {
                addMessage(current, { from: SYSTEM, to: [parentId], text });
              }
            }).catch((mapError: unknown) => {
              host.log.error('письмо о несозданном worktree не записалось', {
                ref,
                error: String(mapError),
              });
            });
          }
          throw error;
        }
        const createdAt = new Date().toISOString();
        worktree.createdAt = createdAt;
        await updateMap(ref.projectPath, ref.workId, (current) => {
          const target = current.sessions.find((candidate) => candidate.id === ref.sessionId);
          if (target?.worktree !== null && target?.worktree !== undefined) {
            target.worktree.createdAt = createdAt;
          }
        });
      }

      // Скилл ставится после worktree: его корень к этому моменту уже на диске. Сбой установки запуск не
      // останавливает — `installSkill` его не бросает.
      await installSkill(ref, session.worktree?.path ?? null);

      const hookUrl = await feedHookUrl(session.provider);
      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, {
        channel: false,
        ...(hookUrl === undefined ? {} : { hookUrl }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      });

      let command: string;
      try {
        command = await findRunnerBinary(plan.command, process.env);
      } catch (error) {
        host.broadcast('host.notice', {
          kind: 'launch-failed',
          ref,
          text: `session ${ref.sessionId} failed to launch: ${(error as Error).message}`,
          at: new Date().toISOString(),
        });
        throw error;
      }

      // Окружение самого хоста — окружение login-shell от окна (спека 3.2);
      // `agentEnv` чистит унаследованные метки родительской сессии Claude Code
      // (П0), `plan.env` поверх добавляет свои `PARLEY_*` и `HARNAS_*`.
      // Read again after async preparation: key removal/rotation applies to this exact process.
      const secret = entry.runner.secret === undefined ? null : await readSecret(entry.runner.secret);
      if (entry.runner.secret !== undefined && secret === null) {
        throw new HostError('bad_request', 'GLM requires a saved Z.ai key in Providers');
      }
      const env = providerLaunchEnv(entry, process.env, plan.env, secret);
      // Свой токен приёмника на каждый запуск (решение А): с ним HTTP-хуки из файла настроек находят
      // сессию. Только при `hookUrl` — без него в файле настроек HTTP-хуков нет, и токен не нужен.
      if (hookUrl !== undefined && hooks !== undefined) {
        const name = entry.runner.secret === 'zai' ? 'PARLEY_HOOK_CAPABILITY' : 'PARLEY_HOOK_TOKEN';
        env[name] = hooks.register(ref, plan.providerSessionId ?? session.providerSessionId);
      }
      // `provider` — процессу не нужен, а хосту нужен: у codex состояние берётся из потока его терминала,
      // и ввод идёт своим порядком (спека комнат, 3.6).
      let handle: PtyHandle;
      try {
        handle = pty.start(ref, {
          command,
          args: plan.args,
          cwd: plan.cwd,
          env,
          provider: session.provider,
        });
      } catch (error) {
        if (hookUrl !== undefined) hooks?.unregister(ref);
        throw error;
      }
      const started = (async () => {
        await startSession(ref.projectPath, ref.workId, ref.sessionId, plan.providerSessionId, {
          pid: handle.pid,
          startedAtProcess: await processStartedAt(handle.pid),
          launchedBy: 'host',
        });
      })();
      // Выходу нужен только момент, а не результат: ошибку старта получит вызывающий.
      starting.set(key, started.catch(() => {}));
      try {
        await started;
      } finally {
        starting.delete(key);
      }
    } catch (error) {
      if (error instanceof HostError) host.broadcast('host.notice', {
        kind: 'launch-failed', ref,
        text: `session ${ref.sessionId} failed to launch: ${error.message}`,
        at: new Date().toISOString(),
      });
      throw error;
    } finally {
      launching.delete(key);
    }
  }

  /**
   * Сессию, заведённую `sessions.create`, тут же откроют в терминале — в
   * отличие от той, что фоном поднял autoLaunch, отмечаем её увиденной сразу,
   * чтобы до первого `pty.attach` она не мигала непрочитанной.
   */
  async function createInteractive(
    ref: SessionRef,
    mode: LaunchMode,
    choice: LaunchChoice,
  ): Promise<SessionRef> {
    await launch(ref, mode, choice);
    activity.markSeen(ref);
    return ref;
  }

  /**
   * Быстрая и дочерняя сессии core заводит с ярлыком `NEW_LABEL` и
   * провайдером claude. Ярлык и провайдер из диалога окна должны остаться —
   * иначе выбор человека молча терялся бы. Пустой ярлык оставляет `NEW_LABEL`,
   * и тогда сессию переименует заголовок Claude Code (автозаголовок). Модель и
   * усилие ложатся в запись так же, как их пишет `spawn_session`: без выбора полей нет.
   */
  async function applyChoice(
    ref: SessionRef,
    label: string,
    provider: string,
    choice: ModelEffortChoice,
  ): Promise<void> {
    const trimmed = label.trim();
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      if (trimmed !== '') session.label = trimmed;
      session.provider = provider;
      if (choice.model !== undefined) session.model = choice.model;
      if (choice.effort !== undefined) session.effort = choice.effort;
    });
  }

  /** База worktree ребёнка — ветка родителя, если он сам в worktree, иначе база проекта (как у `spawn_session`). */
  async function worktreeBaseFor(ref: SessionRef, parentId: string | null): Promise<string> {
    if (parentId !== null) {
      const map = await readMap(ref.projectPath, ref.workId);
      const parent = map.sessions.find((candidate) => candidate.id === parentId);
      if (parent?.worktree !== null && parent?.worktree !== undefined) return parent.worktree.branch;
    }
    return baseBranchOf(ref.projectPath);
  }

  /**
   * План worktree пишется в карту сразу — тем же путём, что `spawn_session` в
   * core (кусок 4.1); каталог на диске заводит `launch()` перед первым запуском.
   *
   * `brief: true` — бриф сессии уже записан без плана (его пишет создание
   * записи): переписываем его по карте с планом, иначе агент не узнает из
   * брифа свою ветку и базу (fix-guide, п. 3). Быстрой сессии `new` бриф не
   * пишется вовсе — ей и заводить его незачем.
   */
  async function attachWorktreePlan(ref: SessionRef, parentId: string | null, brief: boolean): Promise<void> {
    const base = await worktreeBaseFor(ref, parentId);
    const { config } = await loadConfig();
    const updated = await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      session.worktree = plannedWorktree(
        ref.projectPath,
        ref.workId,
        ref.sessionId,
        base,
        config.worktreeRoot,
      );
    });
    // Запись успели удалить — плана нет, и бриф собирать не по чему.
    const planned = updated.sessions.some((candidate) => candidate.id === ref.sessionId);
    if (brief && planned) await writeBrief(ref.projectPath, updated, ref.sessionId);
  }

  async function create(input: CreateSessionInput): Promise<SessionRef> {
    const { projectPath, workId, provider, label, task, parent, worktree } = input;
    // Secret-dependent GLM must refuse before every create branch. Other providers keep their
    // existing create/launch failure behavior; all launches still use the shared preflight below.
    if ((await loadProviders())[provider]?.runner.secret !== undefined) await readyProvider(provider);
    // Модель и усилие — раньше всего: пара не из каталога провайдера отвергается до первой записи в карте (иначе
    // осталась бы `pending`-сессия, которую нечем запустить), а пустое значение — «по умолчанию». Разрешённый выбор
    // пишется в запись сессии на всех путях ниже: повторный запуск и resume берут его оттуда (спека нормалайзера, 5.5).
    const choice = await resolveModelChoice(provider, input.model, input.effort);

    // Проверка до создания сессии, а не после (как и в `spawn_session` core,
    // кусок 4.1) — иначе в карте осталась бы pending-сессия, которую нечем завести.
    if (worktree === true && !(await isGitRepo(projectPath))) {
      throw new HostError('bad_request', 'the project has no git — a worktree cannot be created');
    }

    if (workId === null) {
      const created = await createNewSession(projectPath, null);
      const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, choice);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent === null) {
      const created = await createNewSession(projectPath, workId);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, choice);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent !== null) {
      const created = await createChildSession(projectPath, workId, parent);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, choice);
      if (worktree === true) await attachWorktreePlan(ref, parent, true);
      return createInteractive(ref, 'launch', choice);
    }

    const sessionId = await createPendingSession(projectPath, workId, {
      provider,
      label,
      task,
      parent,
      contextFrom: parent === null ? [] : [parent],
      ...choice,
    });
    const ref = { projectPath, workId, sessionId };
    if (worktree === true) await attachWorktreePlan(ref, parent, true);
    return createInteractive(ref, 'launch', choice);
  }

  async function stop(ref: SessionRef): Promise<void> {
    if (pty.get(ref) === undefined) return;
    await pty.stop(ref);
    // Само событие `exit` уже прошло (см. выше) — если запись карты ещё
    // пишется, дожидаемся её, чтобы вызывающая сторона не читала гонку.
    await finalizing.get(refKey(ref));
  }

  async function setChoice(
    ref: SessionRef,
    choice: { model?: string | null; effort?: string | null },
  ): Promise<void> {
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) {
        throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      if (choice.model === null) delete session.model;
      else if (choice.model !== undefined) session.model = choice.model;
      if (choice.effort === null) delete session.effort;
      else if (choice.effort !== undefined) session.effort = choice.effort;
    });
  }

  async function close(ref: SessionRef): Promise<void> {
    const key = refKey(ref);
    closing.add(key);
    try {
      // Сначала остановка, потом `closed`: выход процесса дописывает в карту код
      // выхода и итоговые метрики, а закрытую сессию `finishExited` не трогает.
      await stop(ref);
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session === undefined) {
          throw new Error(`session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
        }
        if (session.lifecycle !== 'closed') transitionSession(map, ref.sessionId, 'closed');
      });
    } finally {
      closing.delete(key);
    }
  }

  async function del(ref: SessionRef, force = false): Promise<void> {
    await stop(ref);
    // Worktree — рабочая копия на диске, а не только запись в карте: грязную
    // без явного согласия теряют молча (спека 8.3), поэтому проверка раньше
    // самого удаления записи.
    const map = await readMap(ref.projectPath, ref.workId).catch(() => null);
    const worktree = map?.sessions.find((candidate) => candidate.id === ref.sessionId)?.worktree;
    if (worktree !== null && worktree !== undefined && worktree.createdAt !== null) {
      try {
        await discardWorktree(ref.projectPath, worktree, { force });
      } catch (error) {
        if (error instanceof DirtyWorktreeError) throw new HostError('conflict', error.message);
        // Ветка из карты — не ревизия, `.git` worktree подменён: тот же bad_request, что у
        // worktrees.merge/discard.
        if (error instanceof InvalidRevisionError || error instanceof GitStateError) throw gitFailure(error);
        throw error;
      }
    }
    await deleteSession(ref.projectPath, ref.workId, ref.sessionId);
  }

  /**
   * Сессию закрыл `close_session` агента прямо в карте, а её PTY ещё жив: хост
   * гасит процесс сам — закрытая сессия жить не должна.
   */
  function stopClosed(snapshot: WorksSnapshot): void {
    for (const entry of snapshot.entries) {
      for (const session of entry.map.sessions) {
        if (session.lifecycle !== 'closed') continue;
        const ref: SessionRef = {
          projectPath: entry.projectPath,
          workId: entry.map.work.id,
          sessionId: session.id,
        };
        const key = refKey(ref);
        if (pty.get(ref) === undefined || closing.has(key)) continue;
        closing.add(key);
        stop(ref)
          .catch((error: unknown) => {
            host.log.error('остановка закрытой сессии не удалась', { ref, error: String(error) });
          })
          .finally(() => closing.delete(key));
      }
    }
  }

  async function runAutoLaunch(snapshot: WorksSnapshot, previous: WorksSnapshot): Promise<void> {
    const previousByKey = new Map<string, WorkEntry>(
      previous.entries.map((entry) => [workKey(entry.projectPath, entry.map.work.id), entry]),
    );
    // Настройку читаем максимум раз на пачку изменений, и только если в ней
    // вообще нашёлся кандидат — иначе на каждое `works.changed` без надобности
    // читался бы файл настроек.
    let enabled: boolean | undefined;

    for (const entry of snapshot.entries) {
      const prevEntry = previousByKey.get(workKey(entry.projectPath, entry.map.work.id));
      const firstRead = works.firstReadDone(entry.projectPath, entry.map.work.id);
      const candidates = autoLaunchCandidates(prevEntry, entry, firstRead);
      if (candidates.length === 0) continue;

      if (enabled === undefined) {
        enabled = (await loadConfig()).config.autoLaunch;
      }
      if (!enabled) continue;

      for (const sessionId of candidates) {
        const ref: SessionRef = {
          projectPath: entry.projectPath,
          workId: entry.map.work.id,
          sessionId,
        };
        launch(ref, 'launch').catch((error: unknown) => {
          host.log.error('autoLaunch: запуск сессии не удался', { ref, error: String(error) });
        });
      }
    }
  }

  works.onChange((snapshot, previous) => {
    stopClosed(snapshot);
    void runAutoLaunch(snapshot, previous);
  });

  /** Та же сессия всё ещё спит — её не подняли и не закрыли с момента сбора. */
  function stillSleeping(ref: SessionRef): boolean {
    const session = works
      .entry(ref.projectPath, ref.workId)
      ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    return session?.lifecycle === 'sleeping';
  }

  return {
    create,
    launch,
    stop,
    close,
    delete: del,
    setChoice,
    exclusive,
    live: (ref) => pty.get(ref) !== undefined,
    async stopAll() {
      await Promise.all(
        pty.list().map((handle) =>
          stop(handle.ref).catch((error: unknown) => {
            host.log.error('остановка сессии на выключении хоста не удалась', {
              ref: handle.ref,
              error: String(error),
            });
          }),
        ),
      );
    },
    async collectInterrupted() {
      interruptedRefs = await findInterrupted(works.snapshot().entries, (ref) =>
        openEvents(workPaths(ref.projectPath, ref.workId).events)
          .read(ref.sessionId)
          .catch(() => null),
      );
    },
    interrupted: () => interruptedRefs.filter(stillSleeping),
    async resumeInterrupted(refs) {
      for (const ref of refs) {
        // Поднимаем только тех, кто всё ещё спит: закрытую (спека 7.1) и уже
        // поднятую — нет. Карта — свежим чтением: снимок работ мог отстать.
        const map = await readMap(ref.projectPath, ref.workId).catch(() => null);
        const session = map?.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session?.lifecycle !== 'sleeping') continue;
        await launch(ref, 'resume').catch((error: unknown) => {
          host.log.error('подъём прерванной сессии не удался', { ref, error: String(error) });
        });
      }
      const asked = new Set(refs.map(refKey));
      interruptedRefs = interruptedRefs.filter((ref) => !asked.has(refKey(ref)));
    },
  };
}
