import type { SessionIndex } from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findClaudeBinary } from './find-binary.js';
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
 * Спавнится только немодифицированный `claude` из PATH под логином пользователя —
 * юридическая граница проекта. Бинарь ищется один раз при старте: если его нет,
 * панель объясняет причину, а не падает в момент нажатия Enter (specs/pty.md).
 */
export function useAgentPty(): AgentPtyState {
  const [binary, setBinary] = useState<string | undefined>();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Живые процессы нужны в cleanup, где состояние React уже недоступно.
  const live = useRef(new Map<string, PtySession>());
  // Enter могли нажать раньше, чем нашёлся бинарь — нажатие не теряем.
  const pending = useRef<{ target: SessionIndex; size: PtySize } | undefined>(undefined);

  const start = useCallback((file: string, target: SessionIndex, size: PtySize) => {
    setError(undefined);

    try {
      const session = spawnPtySession({
        file,
        args: ['--resume', target.id],
        cols: size.cols,
        rows: size.rows,
        // cwd сессии: `claude --resume` должен видеть тот же проект.
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

  useEffect(() => {
    let cancelled = false;

    findClaudeBinary()
      .then((found) => {
        if (cancelled) return;
        setBinary(found);

        const queued = pending.current;
        pending.current = undefined;
        if (queued !== undefined) start(found, queued.target, queued.size);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        pending.current = undefined;
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [start]);

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
      if (binary === undefined) {
        // Поиск бинаря ещё идёт — запустим, как только он найдётся.
        pending.current = { target, size };
        return;
      }

      // У сессии уже есть живой агент — показываем его, а не плодим второго.
      if (live.current.has(target.id)) {
        setActiveId(target.id);
        return;
      }

      start(binary, target, size);
    },
    [binary, start],
  );

  const restart = useCallback<AgentPtyState['restart']>(
    (size) => {
      const target = runs.find((run) => run.target.id === activeId)?.target;
      if (binary === undefined || target === undefined) return;
      start(binary, target, size);
    },
    [binary, runs, activeId, start],
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
