/**
 * Панель харнесса со стороны процесса: PTY агента, его размер и жизненный цикл
 * сессии в карте (дизайн TUI v2, 2.2, 5.1 и 5.4).
 *
 * Спавнится только немодифицированный бинарь провайдера из PATH — команду и
 * аргументы считает `work-launch.ts` по реестру. Здесь лишь связывание: процесс
 * поднялся — сессия `active` с `pid`, процесс вышел — `exited` с кодом.
 */

import { processStartedAt, type MetricsRoots } from '@harnas/core';
import { useCallback } from 'react';
import type { TerminalSnapshot } from './pty/terminal-buffer.js';
import type { PtyExit, PtySession } from './pty/pty-session.js';
import { useAgentPty, workRunKey, type AgentTarget } from './pty/use-agent-pty.js';
import { useHostTerminalModes } from './pty/use-host-modes.js';
import { usePtyResize } from './pty/use-pty-resize.js';
import { usePtyTerminal } from './pty/use-pty-terminal.js';
import {
  createNewSession,
  finishExited,
  planLaunch,
  planNew,
  planResume,
  startSession,
  type LaunchPlan,
} from './work-launch.js';
import type { WorkSession } from '@harnas/core';

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

export interface PanelState {
  /** Экран агента, к которому подключена панель. */
  snapshot: TerminalSnapshot | undefined;
  /** Ключ живой панели (`workRunKey`); `null` — панели нет или агент вышел. */
  attached: string | null;
  alive: (key: string) => boolean;
  /** Подключить панель к сессии; своего PTY у неё нет — панель отпускает гостя. */
  attach: (key: string) => void;
  /**
   * Быстрая сессия `new`: работа берётся выбранная или заводится «без
   * названия», процесс стартует сразу (5.1). Колбэк получает id новой сессии.
   */
  create: (workId: string | null, created: (sessionId: string) => void) => void;
  /**
   * Запуск `pending` по брифу или возобновление вышедшей через `resumeArgs`
   * (оверлеи 4.5 и 4.6). Проект берётся у работы: она может быть чужой.
   */
  start: (
    projectPath: string,
    workId: string,
    session: WorkSession,
    mode: 'launch' | 'resume',
  ) => void;
  /** SIGHUP процессу панели (макет 4.8). */
  close: (key: string) => void;
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

  const onExit = useCallback(
    (target: AgentTarget, exited: PtyExit) => {
      if (target.kind !== 'work') return;
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
    (project: string, workId: string, session: WorkSession, plan: LaunchPlan) => {
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
      );
    },
    [agent, cols, rows],
  );

  const create = useCallback<PanelState['create']>(
    (workId, created) => {
      void createNewSession(projectPath, workId)
        .then(async ({ workId: id, session }) => {
          openWork(projectPath, id, session, await planNew(projectPath, id, session));
          created(session.id);
        })
        .catch(onFail);
    },
    [projectPath, openWork, onFail],
  );

  const start = useCallback<PanelState['start']>(
    (project, workId, session, mode) => {
      const planner = mode === 'launch' ? planLaunch : planResume;
      void planner(project, workId, session)
        .then((plan) => openWork(project, workId, session, plan))
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
    start,
    close: agent.close,
    write: agent.write,
    scroll,
  };
}
