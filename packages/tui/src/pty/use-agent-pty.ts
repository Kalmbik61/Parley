import type { SessionIndex } from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findClaudeBinary } from './find-binary.js';
import { spawnPtySession, type PtyExit, type PtySession } from './pty-session.js';

export interface PtySize {
  cols: number;
  rows: number;
}

export interface AgentPtyState {
  /** Живой или уже завершившийся процесс; undefined — ничего не запускали. */
  session: PtySession | undefined;
  /** Что показывать вместо терминала: нет бинаря, не удалось запустить. */
  error: string | undefined;
  /** Как завершился процесс — для строки состояния в панели. */
  exit: PtyExit | undefined;
  /** Сессия, для которой запущен процесс. */
  openedFor: SessionIndex | undefined;
  open(target: SessionIndex, size: PtySize): void;
  close(): void;
}

/**
 * Запускает `claude --resume <sessionId>` в PTY для выбранной сессии.
 *
 * Бинарь ищется один раз при старте: если его нет, панель сразу объясняет проблему,
 * а не падает в момент нажатия Enter. Спавнится только немодифицированный `claude`
 * из PATH под логином пользователя — юридическая граница проекта (specs/pty.md).
 */
export function useAgentPty(): AgentPtyState {
  const [binary, setBinary] = useState<string | undefined>();
  const [session, setSession] = useState<PtySession | undefined>();
  const [openedFor, setOpenedFor] = useState<SessionIndex | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [exit, setExit] = useState<PtyExit | undefined>();

  // Текущий процесс держим в ref: он нужен в cleanup и при замене, а не при рендере.
  const current = useRef<PtySession | undefined>(undefined);
  // Enter могли нажать раньше, чем нашёлся бинарь — нажатие не теряем.
  const pending = useRef<{ target: SessionIndex; size: PtySize } | undefined>(undefined);

  const start = useCallback((file: string, target: SessionIndex, size: PtySize) => {
    // Один активный процесс: прежний гасим перед запуском нового.
    current.current?.kill();
    setExit(undefined);
    setError(undefined);

    try {
      const started = spawnPtySession({
        file,
        args: ['--resume', target.id],
        cols: size.cols,
        rows: size.rows,
        // cwd сессии: `claude --resume` должен видеть тот же проект.
        ...(target.cwd === null ? {} : { cwd: target.cwd }),
      });

      started.onExit((finished) => setExit(finished));
      current.current = started;
      setSession(started);
      setOpenedFor(target);
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

  // Выходим из TUI — гасим процесс аккуратно, как при закрытии терминала.
  useEffect(
    () => () => {
      current.current?.kill();
      current.current = undefined;
    },
    [],
  );

  const close = useCallback(() => {
    current.current?.kill();
    current.current = undefined;
    pending.current = undefined;
    setSession(undefined);
    setOpenedFor(undefined);
    setExit(undefined);
  }, []);

  const open = useCallback<AgentPtyState['open']>(
    (target, size) => {
      if (binary === undefined) {
        // Поиск бинаря ещё идёт — запустим, как только он найдётся.
        pending.current = { target, size };
        return;
      }
      start(binary, target, size);
    },
    [binary, start],
  );

  return { session, error, exit, openedFor, open, close };
}
