import { runnerCommand, type SessionIndex } from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findRunnerBinary } from './find-binary.js';
import { spawnPtySession, type PtyExit, type PtySession } from './pty-session.js';

export interface PtySize {
  cols: number;
  rows: number;
}

/** Один запущенный агент. На сессию их не больше одного (specs/pty.md). */
export interface AgentRun {
  target: SessionIndex;
  session: PtySession;
  /** Заполняется, когда процесс завершился — сам или аварийно. */
  exit: PtyExit | undefined;
}

export interface AgentPtyState {
  /** Что показывает правая панель. */
  active: AgentRun | undefined;
  /** Сколько агентов работает прямо сейчас. */
  liveCount: number;
  /** Нет бинаря или не удалось запустить. */
  error: string | undefined;
  open(target: SessionIndex, size: PtySize): void;
  /** Перезапустить агента активной панели после его завершения. */
  restart(size: PtySize): void;
  close(): void;
}

/**
 * Управляет агентами в правой панели.
 *
 * Команда и аргументы берутся из реестра провайдеров (specs/runners.md): для
 * Claude Code это `claude --resume <id>`, для Codex — `codex resume <id>`.
 * Отдельной терминальной логики на провайдера нет — PTY-менеджер один.
 *
 * Спавнится только немодифицированный бинарь из PATH под логином пользователя —
 * юридическая граница проекта.
 */
export function useAgentPty(): AgentPtyState {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Живые процессы нужны в cleanup, где состояние React уже недоступно.
  const live = useRef(new Map<string, PtySession>());
  // Путь к бинарю ищется один раз на команду и переиспользуется.
  const binaries = useRef(new Map<string, string>());

  const start = useCallback((file: string, args: string[], target: SessionIndex, size: PtySize) => {
    setError(undefined);

    try {
      const session = spawnPtySession({
        file,
        args,
        cols: size.cols,
        rows: size.rows,
        // cwd сессии: агент должен видеть тот же проект.
        ...(target.cwd === null ? {} : { cwd: target.cwd }),
      });

      session.onExit((exit) => {
        live.current.delete(target.id);
        setRuns((prev) =>
          prev.map((run) => (run.target.id === target.id ? { ...run, exit } : run)),
        );
      });

      // Прежний процесс той же сессии гасим: один активный PTY на сессию.
      live.current.get(target.id)?.kill();
      live.current.set(target.id, session);

      setRuns((prev) => [
        ...prev.filter((run) => run.target.id !== target.id),
        { target, session, exit: undefined },
      ]);
      setActiveId(target.id);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  /** Ищет бинарь провайдера и запускает его. Бинаря нет — объясняем, а не падаем. */
  const launch = useCallback(
    (target: SessionIndex, size: PtySize) => {
      const { command, args } = runnerCommand(target.provider, target.id);
      const known = binaries.current.get(command);

      if (known !== undefined) {
        start(known, args, target, size);
        return;
      }

      void findRunnerBinary(command)
        .then((file) => {
          binaries.current.set(command, file);
          start(file, args, target, size);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [start],
  );

  // Выходим из TUI — гасим всех аккуратно, как при закрытии терминала.
  useEffect(() => {
    const running = live.current;
    return () => {
      for (const session of running.values()) session.kill();
      running.clear();
    };
  }, []);

  const open = useCallback<AgentPtyState['open']>(
    (target, size) => {
      // У сессии уже есть живой агент — показываем его, а не плодим второго.
      if (live.current.has(target.id)) {
        setActiveId(target.id);
        return;
      }
      launch(target, size);
    },
    [launch],
  );

  const restart = useCallback<AgentPtyState['restart']>(
    (size) => {
      const target = runs.find((run) => run.target.id === activeId)?.target;
      if (target !== undefined) launch(target, size);
    },
    [runs, activeId, launch],
  );

  const close = useCallback(() => {
    if (activeId === undefined) return;
    live.current.get(activeId)?.kill();
    live.current.delete(activeId);
    setRuns((prev) => prev.filter((run) => run.target.id !== activeId));
    setActiveId(undefined);
  }, [activeId]);

  const active = runs.find((run) => run.target.id === activeId);

  return {
    ...(active === undefined ? { active: undefined } : { active }),
    liveCount: runs.filter((run) => run.exit === undefined).length,
    error,
    open,
    restart,
    close,
  };
}
