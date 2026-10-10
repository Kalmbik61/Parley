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

import { randomUUID } from 'node:crypto';
import {
  addMessage,
  attemptKindFor,
  limitsFromConfig,
  prepareSessionRole,
  roleId,
  type SessionRole,
  type RoleCatalog,
  baseBranchOf,
  createChildSession,
  createNewSession,
  createPendingSession,
  createWorktree,
  ensureParleyMd,
  deleteSession,
  DirtyWorktreeError,
  discardWorktree,
  effortsFor,
  finishExited,
  findRunnerBinary,
  GitStateError,
  InvalidRevisionError,
  codexFeedSupported,
  feedSupported,
  isGitRepo,
  loadConfig,
  loadProviders,
  isClaudeCode,
  MapLockTimeoutError,
  providerReadiness,
  providerReadinessError,
  readSecret,
  openEvents,
  planLaunch,
  planNew,
  planResume,
  plannedWorktree,
  processStartedAt,
  querySpawnLimits,
  validateSpawnBudget,
  SpawnBudgetError,
  readMap,
  reserveAttempt,
  ResourceDeniedError,
  sessionTag,
  settleAttempt,
  startSession,
  SYSTEM,
  transitionSession,
  updateMap,
  workPaths,
  writeBrief,
  type EffortLevel,
  type LaunchPlan,
  type SpawnLimits,
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
  role?: SessionRole | null;
  agent?: string;
  /** Своя рабочая копия git — план пишется сразу, каталог заводит `launch()` (спека 8.1). */
  worktree?: boolean;
  /**
   * Модель и усилие из диалога запуска (дизайн комнат, 3.2; спека нормалайзера, 5.3). Пару проверяет
   * `resolveModelChoice`: вне каталога провайдера — `bad_request`, пустое значение — «по умолчанию», без флага.
   * Разрешённый выбор ложится в запись сессии (`WorkSession.model`, `.effort`): его берут и повторный запуск,
   * и resume.
   */
  model?: string | null;
  effort?: string | null;
}

export type LaunchMode = 'launch' | 'resume' | 'new';

/**
 * Попыток записать старт процесса в карту, пока `map.lock` занят: подъём всей работы после перезапуска хоста
 * держал замок дольше 3 с (2026-10-09), а процесс к этому моменту уже идёт.
 */
const START_WRITE_ATTEMPTS = 3;

/** Что `launch()` передаёт плану запуска сверх самой сессии. */
export interface LaunchChoice {
  /**
   * Кто просит запуск — для журнала бюджета (`resource-policy.ts`): `human` — окно, `auto` — автозапуск
   * созданного агентом, `wake` — будильник. Нет значения — человек. Возобновление будильником подчиняется ещё и
   * личному потолку `resumeRate`.
   */
  by?: 'human' | 'auto' | 'wake';
  /** Указатель первым ходом `resume`, если провайдер его принимает. */
  prompt?: string;
  model?: string | null;
  effort?: EffortLevel | null;
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
   * Выбор модели и effort в записи сессии (спека нормалайзера, 5.5): `null` — явный «Default» (снимает и умолчание
   * роли), `undefined` оставляет как было. Процесс не трогает.
   */
  setChoice(ref: SessionRef, choice: { model?: string | null; effort?: string | null }): Promise<void>;
  /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
  exclusive: SwitchLock;
  /**
   * Смена модели (спека нормалайзера, 5.8): живую сессию у приглашения перезапускает через resume с новым
   * `--model`, остальным только пишет карту. `effort` в ответе — что осталось в карте: `null` — сброшен (у новой
   * модели такого уровня нет) или его не было. Та же модель — ни записи, ни перезапуска.
   */
  setModel(ref: SessionRef, model: string): Promise<{ model: string; effort: string | null; restarted: boolean }>;
}

/**
 * Лента вида «Chat» (план 2026-10-01, Task 2): приёмник HTTP-хуков и версии CLI для порога. Оба
 * необязательны — без них сессии запускаются как до ленты: файл настроек без HTTP-хуков, токена нет.
 */
export interface SessionsFeedOptions {
  hooks?: Pick<HookServer, 'url' | 'register' | 'unregister'>;
  providerVersions?: ProviderVersions;
  /** Injectable native limit query; production queries the runtime before spawn. */
  spawnLimits?: () => Promise<SpawnLimits | null>;
  /** Current snapshot injection for isolated tests, never a persisted default. */
  roleCatalog?: (cwd: string) => Promise<RoleCatalog>;
  /**
   * Команда хуков Codex — путь запускателя `PARLEY_HOME/bin/parley-codex-hook` (спека 2026-10-07, 5.6). Зовётся только
   * при включённой настройке `codexApprovals` и адресе приёмника; нет — хуки Codex не включаются.
   */
  codexHookCommand?: () => Promise<string | undefined>;
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
export type SwitchLock = (<T>(ref: SessionRef, run: () => Promise<T>) => Promise<T>) & {
  /** Идёт ли сейчас смена этой сессии: `pty.send` в это время не печатает — клавиши смены идут в открытый ползунок. */
  held(ref: SessionRef): boolean;
};

/**
 * Одна смена модели или effort на сессию за раз (спека нормалайзера, 5.7–5.8): двойной клик или `setEffort` во время
 * `setModel` получают `busy` до первой клавиши — клавиши двух смен не смешиваются, перезапуск один. Ключ ставится
 * синхронно, до первого `await`, и снимается и после сбоя.
 */
export function createSwitchLock(): SwitchLock {
  const running = new Set<string>();
  const lock = async <T>(ref: SessionRef, run: () => Promise<T>): Promise<T> => {
    const key = refKey(ref);
    if (running.has(key)) throw busyError('Another model or effort change of this session is in progress');
    running.add(key);
    try {
      return await run();
    } finally {
      running.delete(key);
    }
  };
  return Object.assign(lock, { held: (ref: SessionRef): boolean => running.has(refKey(ref)) });
}

export function createSessionsService(
  host: HostContext,
  works: WorksService,
  pty: PtyManager,
  activity: ActivityService,
  feed: SessionsFeedOptions = {},
): SessionsService {
  const { hooks, providerVersions } = feed;
  const spawnLimits = feed.spawnLimits ?? querySpawnLimits;
  const warned = new Set<string>();
  const creationWarnings = new Set<string>();

  function deliverWarnings(ref: SessionRef, plan: LaunchPlan): void {
    const diagnostics = plan.diagnostics ?? [];
    for (const message of plan.warnings) {
      if (!diagnostics.some((warning) => warning.message === message)) {
        host.log.warn('session launch warning', { ref, message });
      }
    }
    for (const warning of diagnostics) {
      host.log.warn('session layer warning', { ref, code: warning.code, message: warning.message });
      const key = warning.code === 'provider-override-gap'
        ? warning.code : warning.code === 'role-missing' ? `${refKey(ref)}\0${warning.code}` : `${ref.projectPath}\0${warning.code}`;
      if (warned.has(key)) continue;
      warned.add(key);
      host.broadcast('host.notice', { kind: warning.code, ref, text: warning.message, at: new Date().toISOString() });
    }
  }

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

  // Поколение этого хоста: им подписаны резервы бюджета. Резерв прошлого поколения без свидетельств неоднозначен —
  // он считается занятым и сам по сроку не снимается (`resource-policy.ts`); новая попытка той же сессии его подхватывает.
  const generation = `host-${randomUUID()}`;

  /**
   * Бюджет исчерпан — безопасный исход: процесс и worktree не создаются, модель не запускается. Автозапуску
   * созданного агентом отказ виден: уведомление человеку и системное письмо родителю (иначе тот ждал бы ребёнка).
   * Окну отказ возвращается ошибкой со значением `data.code = 'resource-budget'`, будильнику — тоже: письма ждут.
   */
  async function refuseLaunch(
    ref: SessionRef,
    parentId: string | null,
    by: 'human' | 'auto' | 'wake',
    error: ResourceDeniedError,
  ): Promise<never> {
    host.log.warn('launch refused by the resource budget', { ref, by, code: error.code, scope: error.scope });
    if (by === 'auto') {
      const text = `${sessionTag(ref.sessionId)} was not started: ${error.message}`;
      host.broadcast('host.notice', { kind: 'launch-failed', ref, text, at: new Date().toISOString() });
      if (parentId !== null) {
        await updateMap(ref.projectPath, ref.workId, (current) => {
          if (current.sessions.some((candidate) => candidate.id === parentId)) {
            addMessage(current, { from: SYSTEM, to: [parentId], text });
          }
        }).catch((mapError: unknown) => {
          host.log.error('письмо об отказе запуска не записалось', { ref, error: String(mapError) });
        });
      }
    }
    throw new HostError('conflict', error.message, {
      code: 'resource-budget',
      reason: error.code,
      scope: error.scope,
      limit: error.limit,
      used: error.used,
    });
  }

  /** Резерв слота до запуска: проверка и запись одним действием под замком карты. */
  async function reserveLaunch(
    ref: SessionRef,
    parentId: string | null,
    mode: LaunchMode,
    by: 'human' | 'auto' | 'wake',
  ): Promise<string> {
    const { config } = await loadConfig();
    let attemptId = '';
    try {
      await updateMap(
        ref.projectPath,
        ref.workId,
        (map) => {
          attemptId = reserveAttempt(map, {
            kind: attemptKindFor(map, ref.sessionId, mode),
            actor: by,
            session: ref.sessionId,
            owner: generation,
            limits: limitsFromConfig(config),
            ...(by === 'wake' ? { sessionResumeRate: config.resumeRate } : {}),
          }).id;
        },
        { touch: false },
      );
    } catch (error) {
      if (error instanceof ResourceDeniedError) return refuseLaunch(ref, parentId, by, error);
      throw error;
    }
    return attemptId;
  }

  /** Исход резерва: `spent` — процесс стартовал, `released` — запуска не было. Трогает только резерв этого поколения. */
  async function settleLaunch(ref: SessionRef, attemptId: string, outcome: 'spent' | 'released'): Promise<void> {
    await updateMap(
      ref.projectPath,
      ref.workId,
      (map) => {
        settleAttempt(map, attemptId, generation, outcome);
      },
      { touch: false },
    ).catch((error: unknown) => {
      host.log.error('исход резерва бюджета не записался', { ref, attemptId, outcome, error: String(error) });
    });
  }

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
   * Адрес приёмника хуков для запуска — `claude` не ниже `FEED_MIN_VERSION` и `codex` не ниже
   * `CODEX_FEED_MIN_VERSION`, у Codex ещё и при включённой настройке `codexApprovals` (хукам нужно доверие человека,
   * спека 2026-10-07, решение 9). Версия — проба старта хоста по команде провайдера (короткая, ждём её); нет версии,
   * старый CLI и прочие провайдеры — без хуков, окно покажет терминал.
   */
  async function feedHookUrl(provider: string): Promise<string | undefined> {
    const codex = provider === 'codex';
    if ((!isClaudeCode(provider) && !codex) || hooks === undefined || providerVersions === undefined) return undefined;
    const url = hooks.url();
    if (url === null) return undefined;
    if (codex && !(await loadConfig()).config.codexApprovals) return undefined;
    await providerVersions.ready;
    const entry = (await loadProviders())[provider];
    if (entry === undefined) return undefined;
    const version = providerVersions.get(entry.runner.command);
    if (version === null) return undefined;
    return (codex ? codexFeedSupported(version) : feedSupported(version)) ? url : undefined;
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

  /**
   * PTY жив, а карта говорит `sleeping`: запись старта когда-то не удалась. Окно по карте показывает Resume, а запуск
   * на живом процессе нового не начинает — без починки кнопка молчала бы. Дописываем `active` с приметами того же процесса.
   */
  async function repairLive(ref: SessionRef, handle: PtyHandle): Promise<void> {
    const key = refKey(ref);
    launching.add(key);
    const repaired = (async () => {
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
        (candidate) => candidate.id === ref.sessionId,
      );
      if (session?.lifecycle !== 'sleeping') return;
      host.log.warn('карта отставала от живого процесса — сессия снова active', { ref, pid: handle.pid });
      await startSession(ref.projectPath, ref.workId, ref.sessionId, null, {
        pid: handle.pid,
        startedAtProcess: await processStartedAt(handle.pid),
        launchedBy: 'host',
      });
    })();
    // Как у запуска: выход процесса посреди починки пишет `sleeping` только после неё — иначе `active` с мёртвым pid.
    starting.set(key, repaired.catch(() => {}));
    try {
      await repaired;
    } finally {
      starting.delete(key);
      launching.delete(key);
    }
  }

  async function launch(
    ref: SessionRef,
    mode: LaunchMode,
    options: LaunchChoice = {},
  ): Promise<void> {
    const key = refKey(ref);
    if (launching.has(key) || closing.has(key)) return;
    const live = pty.get(ref);
    if (live !== undefined) {
      await repairLive(ref, live);
      return;
    }
    launching.add(key);
    // Резерв слота бюджета держится до исхода: процесс стартовал — `spent`, любой отказ до старта — `released`.
    let attemptId: string | null = null;
    let processStarted = false;
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
      // Архив освобождает процессы агентов: до Reopen сессии работы не поднимает ни письмо, ни человек.
      if (map.work.status === 'archived') {
        throw new HostError('conflict', `workspace ${ref.workId} is archived: reopen it to resume its sessions`);
      }

      // Before planned worktree creation, settings, skills and hook registration; repeated every launch.
      // Первым: отказ готовности провайдера не оставляет следа в карте, в том числе резерва бюджета.
      const entry = await readyProvider(session.provider);
      // Допуск — до worktree, скилла и процесса: исчерпанный бюджет не создаёт ничего.
      attemptId = await reserveLaunch(ref, session.parent, mode, options.by ?? 'human');

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
      try {
        const result = await ensureParleyMd(ref.projectPath);
        if (result.receiptError && !creationWarnings.has(ref.projectPath)) {
          creationWarnings.add(ref.projectPath);
          host.log.warn('PARLEY.md accounting could not be completed; automatic recreation is suppressed', { projectPath: ref.projectPath });
        }
        if (result.created) host.broadcast('host.notice', {
          kind: 'parley-md-created', ref,
          text: 'Parley added PARLEY.md — team rules for your agents', at: new Date().toISOString(),
        });
      } catch {
        if (!creationWarnings.has(ref.projectPath)) {
          creationWarnings.add(ref.projectPath);
          host.log.warn('Parley could not create PARLEY.md; this session still starts', { projectPath: ref.projectPath });
        }
      }

      const hookUrl = await feedHookUrl(session.provider);
      const codexHookCommand = hookUrl !== undefined && session.provider === 'codex' ? await feed.codexHookCommand?.() : undefined;
      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, {
        channel: false,
        ...(feed.roleCatalog ? { roleCatalog: await feed.roleCatalog(session.worktree?.path ?? ref.projectPath) } : {}),
        ...(hookUrl === undefined ? {} : { hookUrl }),
        ...(codexHookCommand === undefined ? {} : { codexHookCommand }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      });
      deliverWarnings(ref, plan);

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
        // Мост хука Codex (`codex-hook-bin`) читает адрес и токен из окружения процесса — у Claude они в файле настроек.
        if (session.provider === 'codex') env['PARLEY_HOOK_URL'] = hookUrl;
        env[name] = hooks.register(
          ref,
          plan.providerSessionId ?? session.providerSessionId,
          session.provider,
        );
      }
      // `provider` — процессу не нужен, а хосту нужен: у codex состояние берётся из потока его терминала,
      // и ввод идёт своим порядком (спека комнат, 3.6).
      let handle: PtyHandle;
      try {
        // The hook token and inherited host environment are now final. No PTY starts on guard failure.
        validateSpawnBudget(command, plan.args, env, await spawnLimits());
        handle = pty.start(ref, {
          command,
          args: plan.args,
          cwd: plan.cwd,
          env,
          provider: session.provider,
        });
        processStarted = true;
      } catch (error) {
        if (hookUrl !== undefined) hooks?.unregister(ref);
        const safe = (error as NodeJS.ErrnoException).code === 'E2BIG'
          ? new SpawnBudgetError('spawn-budget-too-large') : error;
        if (safe instanceof SpawnBudgetError) {
          host.log.warn('session spawn budget rejected', { ref, code: safe.code, ...safe.details });
          throw new HostError('bad_request', safe.message, { code: safe.code, ...safe.details });
        }
        throw safe;
      }
      const started = (async () => {
        try {
          const stamp = {
            pid: handle.pid,
            startedAtProcess: await processStartedAt(handle.pid),
            launchedBy: 'host' as const,
          };
          for (let attempt = 1; ; attempt += 1) {
            try {
              await startSession(ref.projectPath, ref.workId, ref.sessionId, plan.providerSessionId, stamp,
                plan.env['PARLEY_NATIVE_CONTEXT_REVISION']);
              break;
            } catch (error) {
              // Замок держат другие писатели карты — это пройдёт; прочий сбой повтором не лечится.
              if (!(error instanceof MapLockTimeoutError) || attempt >= START_WRITE_ATTEMPTS) throw error;
              host.log.warn('запись старта сессии ждёт map.lock — повтор', { ref, attempt });
            }
          }
        } finally {
          // Процесс уже идёт: слот потрачен, даже если запись старта в карту не удалась.
          if (attemptId !== null) await settleLaunch(ref, attemptId, 'spent');
        }
      })();
      // Выходу нужен только момент, а не результат: ошибку старта получит вызывающий.
      starting.set(key, started.catch(() => {}));
      try {
        await started;
      } catch (error) {
        // Процесс идёт, а карта о нём не знает: окно по карте показывало бы спящую рядом с живым процессом.
        // Останавливаем — сессия снова без процесса, как и записано в карте, и Resume поднимет её заново.
        // `starting` снимается до остановки: запись выхода ждёт его и иначе не дождалась бы.
        starting.delete(key);
        await stop(ref).catch((stopError: unknown) => {
          host.log.error('процесс с незаписанным стартом не остановился', { ref, error: String(stopError) });
        });
        throw error;
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
      // Отмена освобождает только свой ожидающий слот: резервы других сессий и прошлых поколений остаются.
      if (attemptId !== null && !processStarted) await settleLaunch(ref, attemptId, 'released');
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
   * Быстрая и дочерняя сессии core заводит с именем по умолчанию (`addSession`
   * ставит `defaultSessionName` вместо `NEW_LABEL`) и провайдером claude. Ярлык и
   * провайдер из диалога окна должны остаться — иначе выбор человека молча терялся бы.
   * Пустой ярлык оставляет имя по умолчанию: автозаголовок Claude Code его не меняет
   * (спека архива комнат, раздел 14). Модель и усилие ложатся в запись так же, как их
   * пишет `spawn_session`: без выбора полей нет.
   */
  async function applyChoice(ref: SessionRef, label: string, provider: string, role: SessionRole | null, choice: LaunchChoice): Promise<void> {
    const trimmed = label.trim();
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      if (trimmed !== '') session.label = trimmed;
      session.provider = provider;
      session.role = role;
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
    // Пустая строка — отсутствие выбора; только явный null очищает default роли до default CLI.
    if (input.agent !== undefined && input.role !== undefined) throw new HostError('bad_request', 'agent-and-role-conflict');
    const role = input.role ?? (input.agent === undefined ? null : { source: 'claude' as const, name: input.agent });
    const registry = await loadProviders();
    const entry = registry[provider];
    if (!entry) throw new HostError('bad_request', 'unknown provider');
    await prepareSessionRole(projectPath, entry, { roleId: roleId(role), provider, mode: 'create' }, feed.roleCatalog ? await feed.roleCatalog(projectPath) : undefined);
    const resolved = await resolveModelChoice(provider, input.model ?? undefined, input.effort ?? undefined);
    // `exactOptionalPropertyTypes`: явный `undefined` ключом в `LaunchChoice` не проходит.
    const choice: LaunchChoice = {
      ...(input.model === null ? { model: null } : resolved.model === undefined ? {} : { model: resolved.model }),
      ...(input.effort === null ? { effort: null } : resolved.effort === undefined ? {} : { effort: resolved.effort }),
    };

    // Проверка до создания сессии, а не после (как и в `spawn_session` core,
    // кусок 4.1) — иначе в карте осталась бы pending-сессия, которую нечем завести.
    if (worktree === true && !(await isGitRepo(projectPath))) {
      throw new HostError('bad_request', 'the project has no git — a worktree cannot be created');
    }

    if (workId === null) {
      const created = await createNewSession(projectPath, null);
      const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, role, choice);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent === null) {
      const created = await createNewSession(projectPath, workId);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, role, choice);
      if (worktree === true) await attachWorktreePlan(ref, null, false);
      return createInteractive(ref, 'new', choice);
    }

    if (task === '' && parent !== null) {
      const created = await createChildSession(projectPath, workId, parent);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider, role, choice);
      if (worktree === true) await attachWorktreePlan(ref, parent, true);
      return createInteractive(ref, 'launch', choice);
    }

    const sessionId = await createPendingSession(projectPath, workId, {
      provider,
      label,
      task,
      parent,
      contextFrom: parent === null ? [] : [parent],
      role,
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
      // `null` — явный «Default» из меню чата: пишется как `null`, а не удаляет поле, иначе после смены
      // вернулось бы умолчание роли.
      if (choice.model !== undefined) session.model = choice.model;
      if (choice.effort !== undefined) session.effort = choice.effort;
    });
  }

  /**
   * Модель проверяет resolver; сохранённый effort остаётся, если он есть у новой модели, иначе сбрасывается в
   * «по умолчанию». Та же модель, что в карте, — ничего не пишется и не перезапускается. Сессия без процесса (спит,
   * закрыта, ждёт запуска) — только запись в карту: следующий запуск или resume возьмёт новую модель. Живая — только
   * у приглашения и без фоновых задач: запись в карту, остановка и resume с флагами из карты. Resume не поднялся —
   * ошибка уходит окну, а карта уже с новой моделью: кнопка Resume повторит запуск. Всё — под замком `exclusive`.
   */
  async function setModel(
    ref: SessionRef,
    model: string,
  ): Promise<{ model: string; effort: string | null; restarted: boolean }> {
    return exclusive(ref, async () => {
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
        (candidate) => candidate.id === ref.sessionId,
      );
      if (session === undefined) {
        throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      const entry = (await loadProviders())[session.provider];
      if (entry === undefined || !isClaudeCode(entry)) {
        throw new HostError('bad_request', 'the model of a session can be changed only for Claude Code sessions');
      }
      const next = (await resolveModelChoice(session.provider, model)).model;
      // Шаблон запуска без `{model}` (свои `args` в providers.json): модель до CLI не доедет — менять нечего.
      if (next === undefined) throw new HostError('bad_request', `provider ${entry.id} does not accept a model`);
      // Та же модель — ни записи, ни перезапуска: меню отмечает её и так.
      if (next === session.model) return { model: next, effort: session.effort ?? null, restarted: false };
      // Нет выбора effort — его нет и после смены (умолчание роли не вытесняется); выбор, которого у новой модели
      // нет, становится явным «Default» (`null`).
      const effort =
        session.effort === undefined
          ? undefined
          : session.effort !== null && (effortsFor(entry, next)?.some((level) => level.id === session.effort) ?? false)
            ? session.effort
            : null;
      // Сессия сейчас поднимается: процесса ещё нет, но он уже прочитал старую модель из карты — запись «для неживой»
      // и следующий запуск молча остались бы с ней.
      if (launching.has(refKey(ref))) throw busyError('The session is starting; try again in a moment');
      const live = pty.get(ref) !== undefined;
      if (live) {
        const state = activity.get(ref);
        if (!atPrompt(state)) throw busyError('Wait until the agent is idle');
        if (state?.activity.tasks.some((task) => task.background) === true) {
          throw busyError('Wait until background tasks finish');
        }
        // Остановка и resume потеряли бы неотправленный текст; `hasDraft` включает и указатель будильника.
        if (pty.get(ref)?.hasDraft() === true) {
          throw busyError('The input field has unsent text; send or clear it first');
        }
      }
      await setChoice(ref, { model: next, ...(effort === undefined ? {} : { effort }) });
      if (!live) return { model: next, effort: effort ?? null, restarted: false };
      await stop(ref);
      await launch(ref, 'resume');
      return { model: next, effort: effort ?? null, restarted: true };
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
   * гасит процесс сам — закрытая сессия жить не должна. Так же и всякая живая
   * сессия архивной работы: архив освобождает процессы агентов, сессии засыпают.
   */
  function stopRetired(snapshot: WorksSnapshot): void {
    for (const entry of snapshot.entries) {
      const archived = entry.map.work.status === 'archived';
      for (const session of entry.map.sessions) {
        if (!archived && session.lifecycle !== 'closed') continue;
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
        launch(ref, 'launch', { by: 'auto' }).catch((error: unknown) => {
          host.log.error('autoLaunch: запуск сессии не удался', { ref, error: String(error) });
        });
      }
    }
  }

  works.onChange((snapshot, previous) => {
    stopRetired(snapshot);
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
    setModel,
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
