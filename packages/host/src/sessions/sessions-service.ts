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
  agentEnv,
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
  isGitRepo,
  loadConfig,
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
  type EffortLevel,
  type WorkEntry,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef, WorksSnapshot } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { gitFailure } from '../worktrees/worktrees-service.js';
import { createSkillInstaller } from './agent-skills.js';
import { autoLaunchCandidates } from './auto-launch.js';
import { findInterrupted } from './interrupted.js';
import { resolveModelChoice } from './model-choice.js';

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
   * Модель и усилие из диалога запуска (дизайн комнат, 3.2). До команды они доезжают через
   * реестр провайдеров: тот, у кого в шаблоне нет их подстановок, выбор молча отбрасывает.
   * Модель — значение из списка провайдера, если список есть (`resolveModelChoice`: вне списка —
   * `bad_request`); пустая — «по умолчанию», без флага.
   */
  model?: string;
  effort?: EffortLevel;
}

export type LaunchMode = 'launch' | 'resume' | 'new';

/** Что `launch()` передаёт плану запуска сверх самой сессии. */
export interface LaunchChoice {
  /** Указатель первым ходом `resume`, если провайдер его принимает. */
  prompt?: string;
  model?: string;
  effort?: EffortLevel;
}

export interface SessionsService {
  create(input: CreateSessionInput): Promise<SessionRef>;
  /** `prompt` — указатель первым ходом `resume`; `model` и `effort` — только у новой сессии. */
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
}

/** Ключ работы для склейки снимков «до» и «после» в autoLaunch. */
const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

export function createSessionsService(
  host: HostContext,
  works: WorksService,
  pty: PtyManager,
  activity: ActivityService,
): SessionsService {
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

  // Скилл `harnas` в проект и в worktree сессии перед каждым запуском (`agent-skills.ts`).
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
        throw new Error(`сессии ${ref.sessionId} нет в карте работы ${ref.workId}`);
      }
      // Закрытая не поднимается ничем (спека 7.1): процесс без пути в `active`
      // жил бы без записи в карте.
      if (session.lifecycle === 'closed') {
        throw new Error(`сессия ${ref.sessionId} закрыта`);
      }

      // Worktree запланирован (`plannedWorktree` в `create()` или `spawn_session`
      // в core), но каталога на диске ещё нет — заводим его перед первым же
      // запуском, в том числе перед `resume` прерванной сессии (спека 8.1–8.3).
      if (session.worktree !== null && session.worktree.createdAt === null) {
        const worktree = session.worktree;
        try {
          await createWorktree(ref.projectPath, worktree);
        } catch (error) {
          const text = `worktree для ${sessionTag(ref.sessionId)} не создан: ${(error as Error).message}`;
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

      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, {
        channel: false,
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
          text: `запуск сессии ${ref.sessionId} не удался: ${(error as Error).message}`,
          at: new Date().toISOString(),
        });
        throw error;
      }

      // Окружение самого хоста — окружение login-shell от окна (спека 3.2);
      // `agentEnv` чистит унаследованные метки родительской сессии Claude Code
      // (П0), `plan.env` поверх добавляет свои `HARNAS_*`.
      const env = { ...agentEnv(process.env), ...plan.env };
      // `provider` — процессу не нужен, а хосту нужен: у codex состояние берётся из потока его терминала,
      // и ввод идёт своим порядком (спека комнат, 3.6).
      const handle = pty.start(ref, {
        command,
        args: plan.args,
        cwd: plan.cwd,
        env,
        provider: session.provider,
      });
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
   * Быстрая и дочерняя сессии core заводит с ярлыком «новая сессия» и
   * провайдером claude. Ярлык и провайдер из диалога окна должны остаться —
   * иначе выбор человека молча терялся бы. Пустой ярлык оставляет «новую
   * сессию», и тогда её переименует заголовок Claude Code (автозаголовок).
   */
  async function applyChoice(ref: SessionRef, label: string, provider: string): Promise<void> {
    const trimmed = label.trim();
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      if (trimmed !== '') session.label = trimmed;
      session.provider = provider;
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
    const { projectPath, workId, provider, label, task, parent, worktree, effort } = input;
    // Модель — раньше всего: значение не из списка провайдера отвергается до первой записи в карте
    // (иначе осталась бы `pending`-сессия, которую нечем запустить), а пустое — «по умолчанию».
    const model = await resolveModelChoice(provider, input.model);
    // `exactOptionalPropertyTypes`: явный `undefined` ключом в `LaunchChoice` не проходит.
    const choice: LaunchChoice = {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };

    // Проверка до создания сессии, а не после (как и в `spawn_session` core,
    // кусок 4.1) — иначе в карте осталась бы pending-сессия, которую нечем завести.
    if (worktree === true && !(await isGitRepo(projectPath))) {
      throw new HostError('bad_request', 'в проекте нет git — worktree не завести');
    }

    if (workId === null) {
      const created = await createNewSession(projectPath, null);
      const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent === null) {
      const created = await createNewSession(projectPath, workId);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent !== null) {
      const created = await createChildSession(projectPath, workId, parent);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      if (worktree === true) await attachWorktreePlan(ref, parent, true);
      return createInteractive(ref, 'launch', choice);
    }

    const sessionId = await createPendingSession(projectPath, workId, {
      provider,
      label,
      task,
      parent,
      contextFrom: parent === null ? [] : [parent],
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
          throw new Error(`сессии ${ref.sessionId} нет в карте работы ${ref.workId}`);
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
