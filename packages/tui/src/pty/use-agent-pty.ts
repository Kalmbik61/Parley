import { PROVIDERS, runnerCommand, type Provider, type SessionIndex } from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findRunnerBinary } from './find-binary.js';
import { spawnPtySession, type PtyExit, type PtySession } from './pty-session.js';

export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * Что открыто в панели: существующая сессия или новый запуск агента.
 *
 * Новый запуск нужен провайдерам без истории (GLM) и просто чтобы начать работу
 * с чистого листа — у такой цели нет ни id сессии, ни её каталога.
 */
export type AgentTarget =
  { kind: 'session'; session: SessionIndex } | { kind: 'new'; provider: Provider };

/** Провайдер цели: его марка нужна и заголовку панели, и строке статуса. */
export const targetProvider = (target: AgentTarget): Provider =>
  target.kind === 'session' ? target.session.provider : target.provider;

/** Ключ, по которому агент считается «тем же»: одна сессия — один процесс. */
const targetKey = (target: AgentTarget): string =>
  target.kind === 'session' ? `session:${target.session.id}` : `new:${target.provider}`;

const targetTitle = (target: AgentTarget): string =>
  target.kind === 'session'
    ? (target.session.title ?? target.session.id)
    : `новая сессия ${PROVIDERS[target.provider].label}`;

/** Один запущенный агент. На цель их не больше одного (specs/pty.md). */
export interface AgentRun {
  target: AgentTarget;
  /** Подпись для заголовка панели. */
  title: string;
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
  open(target: AgentTarget, size: PtySize): void;
  /** Перезапустить агента активной панели после его завершения. */
  restart(size: PtySize): void;
  close(): void;
}

/**
 * Управляет агентами в правой панели.
 *
 * Команда и аргументы берутся из реестра провайдеров (specs/runners.md): для
 * Claude Code это `claude --resume <id>`, для Codex — `codex resume <id>`,
 * для нового запуска — команда без аргументов. Отдельной терминальной логики
 * на провайдера нет: PTY-менеджер один.
 *
 * Спавнится только немодифицированный бинарь из PATH под логином пользователя —
 * юридическая граница проекта.
 */
export function useAgentPty(): AgentPtyState {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeKey, setActiveKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Живые процессы нужны в cleanup, где состояние React уже недоступно.
  const live = useRef(new Map<string, PtySession>());
  // Путь к бинарю ищется один раз на команду и переиспользуется.
  const binaries = useRef(new Map<string, string>());

  const start = useCallback((file: string, args: string[], target: AgentTarget, size: PtySize) => {
    setError(undefined);
    const key = targetKey(target);
    // cwd есть только у существующей сессии: агент должен видеть тот же проект.
    const cwd = target.kind === 'session' ? target.session.cwd : null;

    try {
      const session = spawnPtySession({
        file,
        args,
        cols: size.cols,
        rows: size.rows,
        ...(cwd === null ? {} : { cwd }),
      });

      session.onExit((exit) => {
        live.current.delete(key);
        setRuns((prev) =>
          prev.map((run) => (targetKey(run.target) === key ? { ...run, exit } : run)),
        );
      });

      // Прежний процесс той же цели гасим: один активный PTY на сессию.
      live.current.get(key)?.kill();
      live.current.set(key, session);

      setRuns((prev) => [
        ...prev.filter((run) => targetKey(run.target) !== key),
        { target, title: targetTitle(target), session, exit: undefined },
      ]);
      setActiveKey(key);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  /** Ищет бинарь провайдера и запускает его. Бинаря нет — объясняем, а не падаем. */
  const launch = useCallback(
    (target: AgentTarget, size: PtySize) => {
      const { command, args } = runnerCommand(
        targetProvider(target),
        target.kind === 'session' ? target.session.id : undefined,
      );
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
      const key = targetKey(target);
      // У цели уже есть живой агент — показываем его, а не плодим второго.
      if (live.current.has(key)) {
        setActiveKey(key);
        return;
      }
      launch(target, size);
    },
    [launch],
  );

  const restart = useCallback<AgentPtyState['restart']>(
    (size) => {
      const target = runs.find((run) => targetKey(run.target) === activeKey)?.target;
      if (target !== undefined) launch(target, size);
    },
    [runs, activeKey, launch],
  );

  const close = useCallback(() => {
    if (activeKey === undefined) return;
    live.current.get(activeKey)?.kill();
    live.current.delete(activeKey);
    setRuns((prev) => prev.filter((run) => targetKey(run.target) !== activeKey));
    setActiveKey(undefined);
  }, [activeKey]);

  const active = runs.find((run) => targetKey(run.target) === activeKey);

  return {
    ...(active === undefined ? { active: undefined } : { active }),
    liveCount: runs.filter((run) => run.exit === undefined).length,
    error,
    open,
    restart,
    close,
  };
}
