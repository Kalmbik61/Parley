import {
  PROVIDERS,
  runnerCommand,
  type Provider,
  type SessionIndex,
  type WorkProvider,
} from '@harnas/core';
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
}

/** Провайдер цели: его марка нужна и заголовку панели, и строке статуса. */
export const targetProvider = (target: AgentTarget): WorkProvider =>
  target.kind === 'session' ? target.session.provider : target.provider;

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
  /** Сколько агентов провайдера работает прямо сейчас: лимиты подписки у них общие. */
  liveOf(provider: WorkProvider): number;
  /** Нет бинаря или не удалось запустить. */
  error: string | undefined;
  open(target: AgentTarget, size: PtySize): void;
  /**
   * Показать уже запущенную панель по её ключу. `false` — такой панели у
   * харнесса нет: сессию запустили вне TUI, и подключаться не к чему (решение №5).
   */
  attach(key: string): boolean;
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
export interface AgentPtyOptions {
  /**
   * Процесс цели завершился. Слой координации переводит по этому событию
   * сессию работы в `exited` и фиксирует её метрики (спецификация, раздел 6).
   */
  onExit?: (target: AgentTarget, exit: PtyExit) => void;
}

export function useAgentPty({ onExit }: AgentPtyOptions = {}): AgentPtyState {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeKey, setActiveKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Живые процессы нужны в cleanup, где состояние React уже недоступно.
  const live = useRef(new Map<string, PtySession>());
  // Колбэк выхода — через ref: его новая ссылка не должна пересоздавать запуск.
  const exited = useRef(onExit);
  exited.current = onExit;
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
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  const attach = useCallback<AgentPtyState['attach']>(
    (key) => {
      if (!runs.some((run) => targetKey(run.target) === key)) return false;
      setActiveKey(key);
      return true;
    },
    [runs],
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
    liveOf: (provider) =>
      runs.filter((run) => run.exit === undefined && targetProvider(run.target) === provider)
        .length,
    error,
    open,
    attach,
    restart,
    close,
  };
}
