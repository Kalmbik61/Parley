/**
 * Держит живые PTY сессий: процесс, экран, флаг черновика и склейку вывода —
 * состояние из раздела 4.1 спеки, план, кусок 1.6.
 *
 * Знает только про `SessionRef` и байты — ничего про клиентов и сокеты. Кому
 * из подключённых клиентов реально уходит `pty.output`, решает
 * `methods/pty.ts`: там же живёт подписка `pty.attach`/`pty.detach` на
 * конкретную сессию (иначе вывод каждого PTY шёл бы всем клиентам хоста сразу).
 */

import { refKey } from '@harnas/protocol';
import type { SessionRef } from '@harnas/protocol';
import type { HostContext } from '../context.js';
import { createCodexTerminalParser } from './codex-terminal.js';
import type { CodexSignal, CodexTerminalParser } from './codex-terminal.js';
import { DraftTracker } from './draft.js';
import { OutputBatcher } from './output-batcher.js';
import { spawnPty } from './pty-process.js';
import type { ExitInfo, PtyLaunch, PtyProcess } from './pty-process.js';
import { createScreen } from './screen.js';
import type { Screen } from './screen.js';

export interface PtyHandle {
  ref: SessionRef;
  pid: number;
  /**
   * Когда хост запустил этот процесс (мс, до spawn). События хуков раньше него — прошлого
   * процесса: без единого нового pty.send и будильник не печатают (fix-final-b).
   */
  startedAt: number;
  cols: number;
  rows: number;
  /** Провайдер из `PtyLaunch.provider`; `null` — не задан. */
  provider: string | null;
  /** Черновик человека или черновик хоста — поверх любого будильник не печатает. */
  hasDraft(): boolean;
  /** Режим bracketed paste headless-экрана сессии. */
  bracketedPaste(): boolean;
}

export interface PtyManager {
  start(ref: SessionRef, launch: PtyLaunch, size?: { cols: number; rows: number }): PtyHandle;
  get(ref: SessionRef): PtyHandle | undefined;
  list(): PtyHandle[];
  /** Печать хоста (например, текст указателя) — черновик человека не трогает. */
  write(ref: SessionRef, data: string): void;
  /** Ввод человека — идёт через `DraftTracker`. */
  input(ref: SessionRef, data: string): void;
  resize(ref: SessionRef, cols: number, rows: number): void;
  snapshot(ref: SessionRef): { snapshot: string; cols: number; rows: number };
  /** Черновик хоста: текст, вставленный печатью хоста без Enter. Событие draft не шлёт; смена значения — host-draft. */
  setHostDraft(ref: SessionRef, value: boolean): void;
  stop(ref: SessionRef, options?: { graceMs?: number }): Promise<ExitInfo>;
  on(event: 'output', listener: (ref: SessionRef, data: string) => void): () => void;
  on(event: 'exit', listener: (ref: SessionRef, exit: ExitInfo) => void): () => void;
  /** Новый PTY на ref — и первый старт, и `sessions.resume` после выхода; ручка уже в `get()`. */
  on(event: 'start', listener: (ref: SessionRef) => void): () => void;
  on(event: 'draft', listener: (ref: SessionRef, hasDraft: boolean) => void): () => void;
  /** Черновик хоста поставлен или снят. Слушает будильник (пересчёт сессии); typeAndSubmit — нет. */
  on(event: 'host-draft', listener: (ref: SessionRef, hasHostDraft: boolean) => void): () => void;
  /**
   * Сигнал терминала Codex (заголовок окна, уведомление OSC 9): только у сессий `provider: 'codex'`,
   * в порядке появления в потоке. Состояние из него выводит сервис активности.
   */
  on(event: 'signal', listener: (ref: SessionRef, signal: CodexSignal) => void): () => void;
}

const DEFAULT_SIZE = { cols: 120, rows: 40 };
/** Через сколько после SIGHUP хост добивает процесс SIGKILL (спека 4.1). */
const DEFAULT_GRACE_MS = 3000;
const BATCH_INTERVAL_MS = 16;

interface Session {
  ref: SessionRef;
  process: PtyProcess;
  startedAt: number;
  screen: Screen;
  draft: DraftTracker;
  batcher: OutputBatcher;
  cols: number;
  rows: number;
  provider: string | null;
  /** Разбор потока терминала — только у codex: у остальных состояние приходит хуками. */
  terminal: CodexTerminalParser | null;
  /** Ждущие завершения процесса вызовы `stop()` — резолвятся общим обработчиком `onExit`. */
  stopWaiters: Array<(exit: ExitInfo) => void>;
}

function toHandle(session: Session): PtyHandle {
  return {
    ref: session.ref,
    pid: session.process.pid,
    startedAt: session.startedAt,
    cols: session.cols,
    rows: session.rows,
    provider: session.provider,
    hasDraft: () => session.draft.hasDraft || session.draft.hasHostDraft,
    bracketedPaste: () => session.screen.bracketedPaste(),
  };
}

type OutputListener = (ref: SessionRef, data: string) => void;
type ExitListener = (ref: SessionRef, exit: ExitInfo) => void;
type StartListener = (ref: SessionRef) => void;
type DraftListener = (ref: SessionRef, hasDraft: boolean) => void;
type HostDraftListener = (ref: SessionRef, hasHostDraft: boolean) => void;
type SignalListener = (ref: SessionRef, signal: CodexSignal) => void;
type PtyListener =
  | OutputListener
  | ExitListener
  | StartListener
  | DraftListener
  | HostDraftListener
  | SignalListener;

export function createPtyManager(host: HostContext): PtyManager {
  const sessions = new Map<string, Session>();
  const outputListeners = new Set<OutputListener>();
  const exitListeners = new Set<ExitListener>();
  const startListeners = new Set<StartListener>();
  const draftListeners = new Set<DraftListener>();
  const hostDraftListeners = new Set<HostDraftListener>();
  const signalListeners = new Set<SignalListener>();

  function requireSession(ref: SessionRef): Session {
    const session = sessions.get(refKey(ref));
    if (session === undefined) {
      throw new Error(`нет живого PTY для сессии ${ref.sessionId}`);
    }
    return session;
  }

  function start(ref: SessionRef, launch: PtyLaunch, size = DEFAULT_SIZE): PtyHandle {
    const key = refKey(ref);
    // До spawn: хук процесса пишется в журнал только после, и его mtime не раньше этой метки.
    const startedAt = Date.now();
    // Не `process`: имя затенило бы глобальный `process` до конца функции.
    const ptyProcess = spawnPty(launch, size);
    const screen = createScreen(size.cols, size.rows);
    const batcher = new OutputBatcher((data) => {
      for (const listener of outputListeners) listener(ref, data);
    }, BATCH_INTERVAL_MS);

    const session: Session = {
      ref,
      process: ptyProcess,
      startedAt,
      screen,
      draft: new DraftTracker(),
      batcher,
      cols: size.cols,
      rows: size.rows,
      provider: launch.provider ?? null,
      terminal: launch.provider === 'codex' ? createCodexTerminalParser() : null,
      stopWaiters: [],
    };
    sessions.set(key, session);
    // Живой PTY занимает таймер простоя хоста (сквозные ограничения плана).
    host.busy(key, true);

    ptyProcess.onData((data) => {
      session.screen.write(data);
      session.batcher.push(data);
      if (session.terminal === null) return;
      for (const signal of session.terminal.feed(data)) {
        for (const listener of Array.from(signalListeners)) {
          // Слушатель бросил — поток терминала не должен упасть вместе с ним: это событие node-pty.
          try {
            listener(ref, signal);
          } catch (error) {
            host.log.error('слушатель сигнала терминала упал', { ref, error: String(error) });
          }
        }
      }
    });

    ptyProcess.onExit((exit) => {
      sessions.delete(key);
      host.busy(key, false);
      session.batcher.dispose();
      session.screen.dispose();
      host.broadcast('pty.exit', { ref, exitCode: exit.exitCode, signal: exit.signal });
      for (const listener of exitListeners) listener(ref, exit);
      for (const resolve of session.stopWaiters) resolve(exit);
    });

    // Последним: слушатель (methods/pty.ts) шлёт окнам pty.resync, и их pty.attach должен
    // уже застать ручку и обработчики процесса.
    for (const listener of Array.from(startListeners)) listener(ref);

    return toHandle(session);
  }

  function get(ref: SessionRef): PtyHandle | undefined {
    const session = sessions.get(refKey(ref));
    return session === undefined ? undefined : toHandle(session);
  }

  /**
   * `draft` — только ввод человека: смена его черновика или снятие черновика хоста его
   * Enter, ⌃C, ⌃U. Печать хоста его не шлёт — иначе ожидание Enter приняло бы
   * собственную вставку за ввод человека.
   */
  function forwardDraftChange(session: Session, before: boolean, hostBefore: boolean): void {
    if (session.draft.hasDraft === before && session.draft.hasHostDraft === hostBefore) return;
    const hasDraft = session.draft.hasDraft || session.draft.hasHostDraft;
    // По снимку подписчиков: будильник на этом же событии печатает указатель, и его
    // `typeAndSubmit` подписывается на draft посреди рассылки — живой `Set` отдал бы
    // ему то же событие, и собственный Enter отменился бы вводом, которого не было.
    for (const listener of Array.from(draftListeners)) listener(session.ref, hasDraft);
  }

  // Настоящие перегрузки функции, а не одна сигнатура с объединением: у
  // объекта-литерала для одного метода нельзя объявить несколько сигнатур
  // вызова, а `on('output', ...)` должен разрешать `listener` именно по
  // значению `event`, а не принимать все три формы сразу.
  function on(event: 'output', listener: OutputListener): () => void;
  function on(event: 'exit', listener: ExitListener): () => void;
  function on(event: 'start', listener: StartListener): () => void;
  function on(event: 'draft', listener: DraftListener): () => void;
  function on(event: 'host-draft', listener: HostDraftListener): () => void;
  function on(event: 'signal', listener: SignalListener): () => void;
  function on(
    event: 'output' | 'exit' | 'start' | 'draft' | 'host-draft' | 'signal',
    listener: PtyListener,
  ): () => void {
    if (event === 'output') {
      const typed = listener as OutputListener;
      outputListeners.add(typed);
      return () => outputListeners.delete(typed);
    }
    if (event === 'exit') {
      const typed = listener as ExitListener;
      exitListeners.add(typed);
      return () => exitListeners.delete(typed);
    }
    if (event === 'start') {
      const typed = listener as StartListener;
      startListeners.add(typed);
      return () => startListeners.delete(typed);
    }
    if (event === 'host-draft') {
      const typed = listener as HostDraftListener;
      hostDraftListeners.add(typed);
      return () => hostDraftListeners.delete(typed);
    }
    if (event === 'signal') {
      const typed = listener as SignalListener;
      signalListeners.add(typed);
      return () => signalListeners.delete(typed);
    }
    const typed = listener as DraftListener;
    draftListeners.add(typed);
    return () => draftListeners.delete(typed);
  }

  return {
    start,
    get,
    list: () => Array.from(sessions.values()).map(toHandle),

    write(ref, data) {
      requireSession(ref).process.write(data);
    },

    input(ref, data) {
      const session = requireSession(ref);
      const before = session.draft.hasDraft;
      const hostBefore = session.draft.hasHostDraft;
      session.draft.input(data);
      session.process.write(data);
      forwardDraftChange(session, before, hostBefore);
    },

    setHostDraft(ref, value) {
      // Процесса уже нет — снимать нечего: у нового процесса сессии черновик свой, пустой.
      const session = sessions.get(refKey(ref));
      if (session === undefined || session.draft.hasHostDraft === value) return;
      if (value) session.draft.markHost();
      else session.draft.clearHost();
      for (const listener of Array.from(hostDraftListeners)) listener(ref, value);
    },

    resize(ref, cols, rows) {
      const session = requireSession(ref);
      session.cols = cols;
      session.rows = rows;
      session.process.resize(cols, rows);
      session.screen.resize(cols, rows);
    },

    snapshot(ref) {
      const session = requireSession(ref);
      return { snapshot: session.screen.snapshot(), cols: session.cols, rows: session.rows };
    },

    async stop(ref, options = {}) {
      const session = requireSession(ref);
      const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

      const exit = new Promise<ExitInfo>((resolve) => session.stopWaiters.push(resolve));
      session.process.kill('SIGHUP');
      const timer = setTimeout(() => session.process.kill('SIGKILL'), graceMs);
      try {
        return await exit;
      } finally {
        clearTimeout(timer);
      }
    },

    on,
  };
}
