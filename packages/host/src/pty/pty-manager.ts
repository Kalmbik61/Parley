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
import { DraftTracker } from './draft.js';
import { OutputBatcher } from './output-batcher.js';
import { spawnPty } from './pty-process.js';
import type { ExitInfo, PtyLaunch, PtyProcess } from './pty-process.js';
import { createScreen } from './screen.js';
import type { Screen } from './screen.js';

export interface PtyHandle {
  ref: SessionRef;
  pid: number;
  cols: number;
  rows: number;
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
  on(event: 'draft', listener: (ref: SessionRef, hasDraft: boolean) => void): () => void;
  /** Черновик хоста поставлен или снят. Слушает будильник (пересчёт сессии); typeAndSubmit — нет. */
  on(event: 'host-draft', listener: (ref: SessionRef, hasHostDraft: boolean) => void): () => void;
}

const DEFAULT_SIZE = { cols: 120, rows: 40 };
/** Через сколько после SIGHUP хост добивает процесс SIGKILL (спека 4.1). */
const DEFAULT_GRACE_MS = 3000;
const BATCH_INTERVAL_MS = 16;

interface Session {
  ref: SessionRef;
  process: PtyProcess;
  screen: Screen;
  draft: DraftTracker;
  batcher: OutputBatcher;
  cols: number;
  rows: number;
  /** Ждущие завершения процесса вызовы `stop()` — резолвятся общим обработчиком `onExit`. */
  stopWaiters: Array<(exit: ExitInfo) => void>;
}

function toHandle(session: Session): PtyHandle {
  return {
    ref: session.ref,
    pid: session.process.pid,
    cols: session.cols,
    rows: session.rows,
    hasDraft: () => session.draft.hasDraft || session.draft.hasHostDraft,
    bracketedPaste: () => session.screen.bracketedPaste(),
  };
}

type OutputListener = (ref: SessionRef, data: string) => void;
type ExitListener = (ref: SessionRef, exit: ExitInfo) => void;
type DraftListener = (ref: SessionRef, hasDraft: boolean) => void;
type HostDraftListener = (ref: SessionRef, hasHostDraft: boolean) => void;
type PtyListener = OutputListener | ExitListener | DraftListener | HostDraftListener;

export function createPtyManager(host: HostContext): PtyManager {
  const sessions = new Map<string, Session>();
  const outputListeners = new Set<OutputListener>();
  const exitListeners = new Set<ExitListener>();
  const draftListeners = new Set<DraftListener>();
  const hostDraftListeners = new Set<HostDraftListener>();

  function requireSession(ref: SessionRef): Session {
    const session = sessions.get(refKey(ref));
    if (session === undefined) {
      throw new Error(`нет живого PTY для сессии ${ref.sessionId}`);
    }
    return session;
  }

  function start(ref: SessionRef, launch: PtyLaunch, size = DEFAULT_SIZE): PtyHandle {
    const key = refKey(ref);
    // Не `process`: имя затенило бы глобальный `process` до конца функции.
    const ptyProcess = spawnPty(launch, size);
    const screen = createScreen(size.cols, size.rows);
    const batcher = new OutputBatcher((data) => {
      for (const listener of outputListeners) listener(ref, data);
    }, BATCH_INTERVAL_MS);

    const session: Session = {
      ref,
      process: ptyProcess,
      screen,
      draft: new DraftTracker(),
      batcher,
      cols: size.cols,
      rows: size.rows,
      stopWaiters: [],
    };
    sessions.set(key, session);
    // Живой PTY занимает таймер простоя хоста (сквозные ограничения плана).
    host.busy(key, true);

    ptyProcess.onData((data) => {
      session.screen.write(data);
      session.batcher.push(data);
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
  function on(event: 'draft', listener: DraftListener): () => void;
  function on(event: 'host-draft', listener: HostDraftListener): () => void;
  function on(event: 'output' | 'exit' | 'draft' | 'host-draft', listener: PtyListener): () => void {
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
    if (event === 'host-draft') {
      const typed = listener as HostDraftListener;
      hostDraftListeners.add(typed);
      return () => hostDraftListeners.delete(typed);
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
