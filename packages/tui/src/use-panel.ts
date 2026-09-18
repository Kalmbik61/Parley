/**
 * Панель харнесса со стороны процесса: PTY агента, его размер и жизненный цикл
 * сессии в карте (дизайн TUI v2, 2.2, 5.1 и 5.4).
 *
 * Спавнится только немодифицированный бинарь провайдера из PATH — команду и
 * аргументы считает `work-launch.ts` по реестру. Здесь лишь связывание: процесс
 * поднялся — сессия `active` с `pid`, процесс вышел — `exited` с кодом.
 */

import { processStartedAt, type MetricsRoots } from '@harnas/core';
import { useCallback, useRef } from 'react';
import type { TerminalSnapshot } from './pty/terminal-buffer.js';
import type { PtyExit, PtySession } from './pty/pty-session.js';
import { useAgentPty, workRunKey, type AgentTarget } from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
import {
  createChildSession,
  createNewSession,
  deleteSession,
  deleteWork,
  finishExited,
  planLaunch,
  planNew,
  planResume,
  startSession,
  type LaunchPlan,
} from './work-launch.js';
import type { WorkSession } from '@harnas/core';
import { workKey } from './work-rows.js';

export interface PanelOptions {
  projectPath: string;
  roots: MetricsRoots;
  cols: number;
  rows: number;
  /** Ловит ли харнесс мышь сам: тогда отслеживание держится и без гостя (3.3). */
  mouseCapture?: boolean;
  /** Ошибка запуска или записи в карту уходит в строку статуса (раздел 6). */
  onFail: (reason: unknown) => void;
}

/**
 * Работа, в которую ложится сессия: проект берётся у записи работы, а не у
 * харнесса — закреплённая работа может лежать в чужом проекте (макет 4.2).
 */
export interface WorkRef {
  projectPath: string;
  workId: string;
}

export interface PanelState {
  /** Экран агента, к которому подключена панель. */
  snapshot: TerminalSnapshot | undefined;
  /** Ключ живой панели (`workRunKey`); `null` — панели нет или агент вышел. */
  attached: string | null;
  alive: (key: string) => boolean;
  /** Подключить панель к сессии; своего PTY у неё нет — панель отпускает гостя. */
  attach: (key: string) => void;
  /**
   * Быстрая сессия `new`: работа берётся выбранная, а `null` заводит «без
   * названия» в проекте харнесса, процесс стартует сразу (5.1). Колбэк получает
   * id новой сессии и ключ её работы: работа могла родиться только что, и выбор
   * едет за ней.
   */
  create: (work: WorkRef | null, created: (sessionId: string, workKey: string) => void) => void;
  /** `prefix C`: дочерняя сессия выбранной, стартует тихо — бриф контекстом. */
  createChild: (
    work: WorkRef,
    parentId: string,
    created: (sessionId: string, workKey: string) => void,
  ) => void;
  /**
   * Запуск `pending` по брифу или возобновление вышедшей через `resumeArgs`
   * (оверлеи 4.5 и 4.6). Проект берётся у работы: она может быть чужой.
   * `focus: false` — поднять процесс в фоне, панель не переключать (5.2).
   */
  start: (
    projectPath: string,
    workId: string,
    session: WorkSession,
    mode: 'launch' | 'resume',
    options?: { focus?: boolean },
  ) => void;
  /** SIGHUP процессу панели (макет 4.8). */
  close: (key: string) => void;
  /**
   * `prefix d`: закрыть процесс сессии, дождаться его выхода и удалить сессию из
   * карты и с диска (макет 4.10). Проект берётся у записи работы: закреплённая
   * работа лежит в чужом проекте, и `rm` по пути харнесса ушёл бы не туда.
   */
  remove: (work: WorkRef, sessionId: string, done: () => void) => void;
  /**
   * `prefix D`: закрыть процессы всех сессий работы, дождаться их выхода и
   * удалить работу целиком — каталог с артефактами и запись индекса (макет 4.12).
   */
  removeWork: (work: WorkRef, sessionIds: readonly string[], done: () => void) => void;
  /** Байты гостю на экране: пока панель показывает карточку, они пропадают. */
  write: (data: string) => void;
  /** Скроллбэк панели: колесо без отслеживания мыши у гостя (3.3). */
  scroll: (lines: number) => void;
}

/** Ключ живой панели цели; у не-работ панели с ключом нет. */
const keyOf = (target: AgentTarget | undefined): string | null =>
  target === undefined || target.kind !== 'work'
    ? null
    : workRunKey(target.projectPath, target.workId, target.sessionId);

export function usePanel({
  projectPath,
  roots,
  cols,
  rows,
  mouseCapture = false,
  onFail,
}: PanelOptions): PanelState {
  // Процесс поднялся — только теперь сессия становится `active`, с приметами
  // процесса, по которым её узнают после перезапуска харнесса (5.1, 5.4).
  const onStart = useCallback(
    (target: AgentTarget, pty: PtySession) => {
      if (target.kind !== 'work') return;
      void processStartedAt(pty.pid)
        .then((at) =>
          startSession(
            target.projectPath,
            target.workId,
            target.sessionId,
            target.providerSessionId,
            { pid: pty.pid, startedAtProcess: at, launchedBy: 'tui' },
          ),
        )
        .catch(onFail);
    },
    [onFail],
  );

  // Сессии, которые сейчас удаляются: их выход в карту не пишем — записи вот-вот
  // не станет, и `exited` лёг бы поверх удаления ошибкой «сессии нет» (раздел C).
  const removing = useRef(new Set<string>());

  const onExit = useCallback(
    (target: AgentTarget, exited: PtyExit) => {
      if (target.kind !== 'work') return;
      const key = workRunKey(target.projectPath, target.workId, target.sessionId);
      if (removing.current.has(key)) return;
      void finishExited(target.projectPath, target.workId, target.sessionId, exited, roots).catch(
        onFail,
      );
    },
    [roots, onFail],
  );

  const onFailed = useCallback(
    (target: AgentTarget, reason: string) => {
      onFail(new Error(`${target.kind === 'work' ? `«${target.title}» ` : ''}${reason}`));
    },
    [onFail],
  );

  const agent = useAgentPty({ onStart, onExit, onFail: onFailed });
  const { snapshot, scroll } = usePtyTerminal(agent.live, agent.active?.session, { cols, rows });
  usePtyResize(agent.active?.session, cols, rows);

  const attached = agent.active?.exit === undefined ? keyOf(agent.active?.target) : null;
  // Мышь и вставка в скобках: включаем у себя то, что запросил гость, а при
  // `mouseCapture` держим клики и колесо включёнными всегда — они нужны
  // сайдбару, даже когда живого гостя нет вовсе (3.3).
  useHostTerminalModes(
    attached !== null || mouseCapture,
    snapshot?.mouseTracking ?? 'none',
    snapshot?.bracketedPaste ?? false,
    undefined,
    mouseCapture,
  );

  /** Поднять процесс сессии в панели по готовому плану запуска. */
  const openWork = useCallback(
    (project: string, workId: string, session: WorkSession, plan: LaunchPlan, focus = true) => {
      agent.open(
        {
          kind: 'work',
          projectPath: project,
          workId,
          sessionId: session.id,
          provider: session.provider,
          title: session.label,
          command: plan.command,
          args: plan.args,
          cwd: plan.cwd,
          env: plan.env,
          providerSessionId: plan.providerSessionId,
        },
        { cols, rows },
        { focus },
      );
    },
    [agent, cols, rows],
  );

  const create = useCallback<PanelState['create']>(
    (work, created) => {
      // Новая работа заводится там, где запущен харнесс; у выбранной проект
      // берётся из её записи — она может быть чужой (макет 4.2).
      const project = work?.projectPath ?? projectPath;
      void createNewSession(project, work?.workId ?? null)
        .then(async ({ workId: id, session }) => {
          openWork(project, id, session, await planNew(project, id, session));
          created(session.id, workKey(project, id));
        })
        .catch(onFail);
    },
    [projectPath, openWork, onFail],
  );

  const createChild = useCallback<PanelState['createChild']>(
    ({ projectPath: project, workId }, parentId, created) => {
      void createChildSession(project, workId, parentId)
        .then(async ({ session }) => {
          openWork(project, workId, session, await planLaunch(project, workId, session));
          created(session.id, workKey(project, workId));
        })
        .catch(onFail);
    },
    [openWork, onFail],
  );

  const remove = useCallback<PanelState['remove']>(
    ({ projectPath: project, workId }, sessionId, done) => {
      const key = workRunKey(project, workId, sessionId);
      removing.current.add(key);
      void agent
        .stop(key)
        .then(() => deleteSession(project, workId, sessionId))
        .then(done)
        .catch(onFail)
        .finally(() => removing.current.delete(key));
    },
    [agent, onFail],
  );

  const removeWork = useCallback<PanelState['removeWork']>(
    ({ projectPath: project, workId }, sessionIds, done) => {
      const keys = sessionIds.map((id) => workRunKey(project, workId, id));
      for (const key of keys) removing.current.add(key);
      void Promise.all(keys.map((key) => agent.stop(key)))
        .then(() => deleteWork(project, workId))
        .then(done)
        .catch(onFail)
        .finally(() => {
          for (const key of keys) removing.current.delete(key);
        });
    },
    [agent, onFail],
  );

  const start = useCallback<PanelState['start']>(
    (project, workId, session, mode, { focus = true } = {}) => {
      const planner = mode === 'launch' ? planLaunch : planResume;
      void planner(project, workId, session)
        .then((plan) => openWork(project, workId, session, plan, focus))
        .catch(onFail);
    },
    [openWork, onFail],
  );

  return {
    snapshot,
    attached,
    alive: agent.alive,
    // Живого PTY с таким ключом у харнесса нет: панель отпускает гостя и
    // показывает карточку сессии, а ввод перестаёт уходить кому бы то ни было.
    attach: (key) => {
      if (!agent.attach(key)) agent.detach();
    },
    create,
    createChild,
    start,
    remove,
    removeWork,
    close: agent.close,
    write: agent.write,
    scroll,
  };
}
