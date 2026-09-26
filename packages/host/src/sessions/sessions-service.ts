/**
 * Создание, запуск, остановка и удаление сессий — план, кусок 1.7.
 *
 * `launch()` — общая точка входа что для интерактивного запуска
 * (`sessions.create`/`sessions.resume`), что для фонового autoLaunch: план
 * команды строит core (`planLaunch`/`planResume`/`planNew`), а хост только
 * находит бинарь, собирает окружение и заводит PTY. Канал звонка здесь всегда
 * выключен (`{ channel: false }`) — хост про него ничего не знает (спека 4.2).
 */

import {
  agentEnv,
  createChildSession,
  createNewSession,
  createPendingSession,
  deleteSession,
  finishExited,
  findRunnerBinary,
  loadConfig,
  planLaunch,
  planNew,
  planResume,
  processStartedAt,
  readMap,
  startSession,
  updateMap,
  type WorkEntry,
} from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { SessionRef, WorksSnapshot } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { autoLaunchCandidates } from './auto-launch.js';

export interface CreateSessionInput {
  projectPath: string;
  workId: string | null;
  provider: string;
  label: string;
  task: string;
  parent: string | null;
}

export type LaunchMode = 'launch' | 'resume' | 'new';

export interface SessionsService {
  create(input: CreateSessionInput): Promise<SessionRef>;
  launch(ref: SessionRef, mode: LaunchMode): Promise<void>;
  stop(ref: SessionRef): Promise<void>;
  delete(ref: SessionRef): Promise<void>;
  live(ref: SessionRef): boolean;
  stopAll(): Promise<void>;
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

  // Процесс вышел — сессия засыпает (спецификация 7.1): письмо её поднимет.
  // Итог `done`/`failed` — другая ось, выход процесса его не трогает.
  pty.on('exit', (ref, exit) => {
    const key = refKey(ref);
    const done = finishExited(ref.projectPath, ref.workId, ref.sessionId, {
      exitCode: exit.exitCode,
      signal: exit.signal ?? undefined,
    })
      .catch((error: unknown) => {
        host.log.error('переход сессии в sleeping не записался', { ref, error: String(error) });
      })
      .finally(() => {
        finalizing.delete(key);
      });
    finalizing.set(key, done);
  });

  async function launch(ref: SessionRef, mode: LaunchMode): Promise<void> {
    const key = refKey(ref);
    if (launching.has(key) || pty.get(ref) !== undefined) return;
    launching.add(key);
    try {
      const map = await readMap(ref.projectPath, ref.workId);
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) {
        throw new Error(`сессии ${ref.sessionId} нет в карте работы ${ref.workId}`);
      }

      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, { channel: false });

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
      const handle = pty.start(ref, { command, args: plan.args, cwd: plan.cwd, env });
      await startSession(ref.projectPath, ref.workId, ref.sessionId, plan.providerSessionId, {
        pid: handle.pid,
        startedAtProcess: await processStartedAt(handle.pid),
        launchedBy: 'host',
      });
    } finally {
      launching.delete(key);
    }
  }

  /**
   * Сессию, заведённую `sessions.create`, тут же откроют в терминале — в
   * отличие от той, что фоном поднял autoLaunch, отмечаем её увиденной сразу,
   * чтобы до первого `pty.attach` она не мигала непрочитанной.
   */
  async function createInteractive(ref: SessionRef, mode: LaunchMode): Promise<SessionRef> {
    await launch(ref, mode);
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

  async function create(input: CreateSessionInput): Promise<SessionRef> {
    const { projectPath, workId, provider, label, task, parent } = input;

    if (workId === null) {
      const created = await createNewSession(projectPath, null);
      const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      return createInteractive(ref, 'new');
    }

    if (task === '' && parent === null) {
      const created = await createNewSession(projectPath, workId);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      return createInteractive(ref, 'new');
    }

    if (task === '' && parent !== null) {
      const created = await createChildSession(projectPath, workId, parent);
      const ref = { projectPath, workId, sessionId: created.session.id };
      await applyChoice(ref, label, provider);
      return createInteractive(ref, 'launch');
    }

    const sessionId = await createPendingSession(projectPath, workId, {
      provider,
      label,
      task,
      parent,
      contextFrom: parent === null ? [] : [parent],
    });
    return createInteractive({ projectPath, workId, sessionId }, 'launch');
  }

  async function stop(ref: SessionRef): Promise<void> {
    if (pty.get(ref) === undefined) return;
    await pty.stop(ref);
    // Само событие `exit` уже прошло (см. выше) — если запись карты ещё
    // пишется, дожидаемся её, чтобы вызывающая сторона не читала гонку.
    await finalizing.get(refKey(ref));
  }

  async function del(ref: SessionRef): Promise<void> {
    await stop(ref);
    await deleteSession(ref.projectPath, ref.workId, ref.sessionId);
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
    void runAutoLaunch(snapshot, previous);
  });

  return {
    create,
    launch,
    stop,
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
  };
}
