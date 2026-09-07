import {
  PROVIDERS,
  runnerCommand,
  type Provider,
  type SessionIndex,
  type WorkProvider,
} from '@harnas/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  { kind: 'session'; session: SessionIndex } | { kind: 'new'; provider: Provider } | WorkTarget;

/**
 * Сессия работы: команду, аргументы, cwd и окружение считает слой координации
 * (`work-launch.ts`) по реестру провайдеров — здесь они уже готовы.
 */
export interface WorkTarget {
  kind: 'work';
  projectPath: string;
  workId: string;
  sessionId: string;
  provider: WorkProvider;
  /** Роль сессии: она же заголовок правой панели. */
  title: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Id, выданный провайдеру, который принимает его снаружи; `null` — связь с
   * логом ищется после запуска по cwd и времени (спецификация, раздел 5).
   */
  providerSessionId: string | null;
}

/**
 * Сколько ждать мягкого выхода после SIGHUP, прежде чем послать SIGKILL: удаляем
 * запись только после выхода процесса (план от 2026-09-06, раздел C).
 */
export const KILL_AFTER_MS = 3000;

/** Ключ живой панели сессии работы: по нему же идёт attach (дизайн 8). */
export const workRunKey = (projectPath: string, workId: string, sessionId: string): string =>
  `work:${projectPath} ${workId} ${sessionId}`;

/** Ключ, по которому агент считается «тем же»: одна сессия — один процесс. */
const targetKey = (target: AgentTarget): string => {
  if (target.kind === 'session') return `session:${target.session.id}`;
  if (target.kind === 'new') return `new:${target.provider}`;
  return workRunKey(target.projectPath, target.workId, target.sessionId);
};

const targetTitle = (target: AgentTarget): string => {
  if (target.kind === 'session') return target.session.title ?? target.session.id;
  if (target.kind === 'new') return `новая сессия ${PROVIDERS[target.provider].label}`;
  return target.title;
};

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
  /**
   * Живые PTY харнесса. Экран копится у каждой, а не только у подключённой:
   * агент, которого не видно, продолжает говорить (дизайн TUI v2, 2.2).
   */
  live: readonly PtySession[];
  /** Нет бинаря или не удалось запустить. */
  error: string | undefined;
  open(target: AgentTarget, size: PtySize): void;
  /**
   * Показать уже запущенную панель по её ключу. `false` — такой панели у
   * харнесса нет: сессию запустили вне TUI, и подключаться не к чему (решение №5).
   */
  attach(key: string): boolean;
  /**
   * Отпустить панель: процессы остаются жить, но экран больше не показывает
   * никого. Нужно, когда панель переключилась на сессию без своего PTY: рисовать
   * чужого гостя и слать ему ввод нельзя (дизайн TUI v2, 2.2 и 3.1).
   */
  detach(): void;
  /** Жив ли процесс панели с таким ключом: завершившийся и незнакомый — нет. */
  alive(key: string): boolean;
  /**
   * Байты подключённому гостю. Панель без живого агента их проглатывает: уйти
   * другому агенту, которого не видно на экране, они не должны (3.1).
   */
  write(data: string): void;
  /**
   * Закрыть панель по ключу (по умолчанию активную): процессу уходит SIGHUP,
   * как при закрытии терминала (дизайн TUI v2, 3.2 и макет 4.8).
   */
  close(key?: string): void;
  /**
   * Закрыть панель и дождаться выхода процесса: SIGHUP, ожидание до
   * `KILL_AFTER_MS`, затем SIGKILL. Нужно удалению сессии — её запись уходит из
   * карты только после выхода, иначе обработчик выхода и хук `SessionEnd` писали
   * бы в удалённую сессию (план от 2026-09-06, раздел C).
   */
  stop(key: string): Promise<void>;
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
export interface AgentPtyOptions {
  /**
   * Процесс цели запущен. Только по этому событию слой координации переводит
   * сессию работы в `active`: статус «процесс идёт» ставится, когда он идёт
   * на самом деле (спецификация, раздел 5). Вторым аргументом — сам PTY: из
   * него берётся `pid` для проверки живости после перезапуска (5.4).
   */
  onStart?: (target: AgentTarget, pty: PtySession) => void;
  /**
   * Процесс цели завершился. Слой координации переводит по этому событию
   * сессию работы в `exited` и фиксирует её метрики (спецификация, раздел 6).
   */
  onExit?: (target: AgentTarget, exit: PtyExit) => void;
  /** Запустить не удалось: бинаря нет в PATH или spawn отказал (раздел 8). */
  onFail?: (target: AgentTarget, reason: string) => void;
}

export function useAgentPty({ onStart, onExit, onFail }: AgentPtyOptions = {}): AgentPtyState {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeKey, showActive] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Живые процессы нужны в cleanup, где состояние React уже недоступно.
  const live = useRef(new Map<string, PtySession>());
  // Подключённая панель дублируется в ref: байты гостю приходят между сменой
  // панели и рендером, и решать по состоянию рендера — значит слать их прежнему
  // агенту (дизайн TUI v2, 3.1).
  const attached = useRef<string | undefined>(undefined);
  const setActiveKey = useCallback((key: string | undefined): void => {
    attached.current = key;
    showActive(key);
  }, []);
  // Колбэки — через ref: их новая ссылка не должна пересоздавать запуск.
  const started = useRef(onStart);
  started.current = onStart;
  const exited = useRef(onExit);
  exited.current = onExit;
  const failed = useRef(onFail);
  failed.current = onFail;
  // Путь к бинарю ищется один раз на команду и переиспользуется.
  const binaries = useRef(new Map<string, string>());

  const start = useCallback((file: string, args: string[], target: AgentTarget, size: PtySize) => {
    setError(undefined);
    const key = targetKey(target);
    // cwd есть у существующей сессии и у сессии работы: агент должен видеть
    // тот же проект — у чужой работы это не cwd харнесса (решение №9).
    const cwd =
      target.kind === 'session' ? target.session.cwd : target.kind === 'work' ? target.cwd : null;
    // Окружение сессии работы: по нему MCP-сервер узнаёт, кто звонит.
    const env = target.kind === 'work' ? { ...process.env, ...target.env } : undefined;

    try {
      const session = spawnPtySession({
        file,
        args,
        cols: size.cols,
        rows: size.rows,
        ...(cwd === null ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      });

      session.onExit((exit) => {
        live.current.delete(key);
        setRuns((prev) =>
          prev.map((run) => (targetKey(run.target) === key ? { ...run, exit } : run)),
        );
        exited.current?.(target, exit);
      });

      // Прежний процесс той же цели гасим: один активный PTY на сессию.
      live.current.get(key)?.kill();
      live.current.set(key, session);

      setRuns((prev) => [
        ...prev.filter((run) => targetKey(run.target) !== key),
        { target, title: targetTitle(target), session, exit: undefined },
      ]);
      setActiveKey(key);
      started.current?.(target, session);
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      failed.current?.(target, message);
    }
  }, []);

  /** Ищет бинарь провайдера и запускает его. Бинаря нет — объясняем, а не падаем. */
  const launch = useCallback(
    (target: AgentTarget, size: PtySize) => {
      // У сессии работы команда уже посчитана слоем координации по реестру.
      const { command, args } =
        target.kind === 'work'
          ? { command: target.command, args: target.args }
          : runnerCommand(
              target.kind === 'session' ? target.session.provider : target.provider,
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
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          failed.current?.(target, message);
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

  // Живые процессы берутся из ref, а не из `runs`: панель подключается сразу
  // после запуска, когда новый `runs` до рендера ещё не доехал.
  const attach = useCallback<AgentPtyState['attach']>((key) => {
    if (!live.current.has(key)) return false;
    setActiveKey(key);
    return true;
  }, []);

  const detach = useCallback<AgentPtyState['detach']>(() => setActiveKey(undefined), []);

  const close = useCallback<AgentPtyState['close']>(
    (key = activeKey) => {
      if (key === undefined) return;
      live.current.get(key)?.kill();
      live.current.delete(key);
      setRuns((prev) => prev.filter((run) => targetKey(run.target) !== key));
      if (attached.current === key) setActiveKey(undefined);
    },
    [activeKey],
  );

  const stop = useCallback<AgentPtyState['stop']>(
    async (key) => {
      const session = live.current.get(key);
      if (session !== undefined && session.state === 'running') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => session.kill('SIGKILL'), KILL_AFTER_MS);
          const off = session.onExit(() => {
            clearTimeout(timer);
            off();
            resolve();
          });
          session.kill();
        });
      }
      close(key);
    },
    [close],
  );

  const active = runs.find((run) => targetKey(run.target) === activeKey);
  const running = useMemo(
    () => runs.filter((run) => run.exit === undefined).map((run) => run.session),
    [runs],
  );

  return {
    ...(active === undefined ? { active: undefined } : { active }),
    live: running,
    error,
    open,
    attach,
    detach,
    alive: (key) => runs.some((run) => targetKey(run.target) === key && run.exit === undefined),
    write: (data) => {
      const key = attached.current;
      if (key !== undefined) live.current.get(key)?.write(data);
    },
    close,
    stop,
  };
}
