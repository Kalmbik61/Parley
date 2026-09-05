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
import { createNewSession, finishExited, planNew, startSession } from './work-launch.js';

export interface PanelOptions {
  projectPath: string;
  roots: MetricsRoots;
  cols: number;
  rows: number;
  /** Ошибка запуска или записи в карту уходит в строку статуса (раздел 6). */
  onFail: (reason: unknown) => void;
}

export interface PanelState {
  /** Экран агента, к которому подключена панель. */
  snapshot: TerminalSnapshot | undefined;
  /** Ключ живой панели (`workRunKey`); `null` — панели нет или агент вышел. */
  attached: string | null;
  alive: (key: string) => boolean;
  attach: (key: string) => void;
  /**
   * Быстрая сессия `new`: работа берётся выбранная или заводится «без
   * названия», процесс стартует сразу (5.1). Колбэк получает id новой сессии.
   */
  create: (workId: string | null, created: (sessionId: string) => void) => void;
  /** SIGHUP процессу панели (макет 4.8). */
  close: (key: string) => void;
  /** Байты гостю: пока живого агента нет, они просто пропадают. */
  write: (data: string) => void;
}

/** Ключ живой панели цели; у не-работ панели с ключом нет. */
const keyOf = (target: AgentTarget | undefined): string | null =>
  target === undefined || target.kind !== 'work'
    ? null
    : workRunKey(target.projectPath, target.workId, target.sessionId);

export function usePanel({ projectPath, roots, cols, rows, onFail }: PanelOptions): PanelState {
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
  const snapshot = usePtyTerminal(agent.active?.session, { cols, rows });
  usePtyResize(agent.active?.session, cols, rows);

  const attached = agent.active?.exit === undefined ? keyOf(agent.active?.target) : null;
  // Мышь и вставка в скобках: включаем у себя ровно то, что запросил гость.
  useHostTerminalModes(
    attached !== null,
    snapshot?.mouseTracking ?? 'none',
    snapshot?.bracketedPaste ?? false,
  );

  const create = useCallback<PanelState['create']>(
    (workId, created) => {
      void createNewSession(projectPath, workId)
        .then(async (session) => {
          const plan = await planNew(projectPath, session.workId, session.session);
          agent.open(
            {
              kind: 'work',
              projectPath,
              workId: session.workId,
              sessionId: session.session.id,
              provider: session.session.provider,
              title: session.session.label,
              command: plan.command,
              args: plan.args,
              cwd: plan.cwd,
              env: plan.env,
              providerSessionId: plan.providerSessionId,
            },
            { cols, rows },
          );
          created(session.session.id);
        })
        .catch(onFail);
    },
    [projectPath, agent, cols, rows, onFail],
  );

  return {
    snapshot,
    attached,
    alive: agent.alive,
    attach: (key) => void agent.attach(key),
    create,
    close: agent.close,
    write: (data) => agent.active?.session.write(data),
  };
}
