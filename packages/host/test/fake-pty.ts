import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { PtyHandle, PtyManager } from '../src/pty/pty-manager.js';

/**
 * `PtyManager` без процесса для тестов печати хоста (`typeAndSubmit`, `pty.send`,
 * кусок 5.1): журнал записей, черновики человека и хоста, режим вставки и pid
 * задаются из теста, событие `draft` тест шлёт сам — как ввод человека.
 */
export interface FakePty {
  manager: PtyManager;
  writes: string[];
  hostDraftCalls: boolean[];
  pid: number;
  /** Метка запуска процесса (`PtyHandle.startedAt`), мс. */
  startedAt: number;
  live: boolean;
  /** Провайдер процесса (`PtyHandle.provider`): `codex` включает ввод Codex; по умолчанию не задан. */
  provider: string | null;
  humanDraft: boolean;
  hostDraft: boolean;
  paste: boolean;
  emitDraft(ref: SessionRef): void;
}

export function fakePty(): FakePty {
  const draftListeners = new Set<(ref: SessionRef, hasDraft: boolean) => void>();
  const state: FakePty = {
    writes: [],
    hostDraftCalls: [],
    pid: 100,
    startedAt: 0,
    live: true,
    provider: null,
    humanDraft: false,
    hostDraft: false,
    paste: false,
    emitDraft(ref) {
      for (const listener of draftListeners) listener(ref, state.humanDraft || state.hostDraft);
    },
    manager: undefined as unknown as PtyManager,
  };

  const handle = (ref: SessionRef): PtyHandle => ({
    ref,
    pid: state.pid,
    startedAt: state.startedAt,
    cols: 80,
    rows: 24,
    provider: state.provider,
    hasDraft: () => state.humanDraft || state.hostDraft,
    bracketedPaste: () => state.paste,
  });

  state.manager = {
    start: () => {
      throw new Error('в этом наборе тестов не используется');
    },
    get: (ref) => (state.live ? handle(ref) : undefined),
    list: () => [],
    write: (ref, data) => {
      if (!state.live) throw new Error(`нет живого PTY для сессии ${refKey(ref)}`);
      state.writes.push(data);
    },
    input: () => {},
    resize: () => {},
    snapshot: () => ({ snapshot: '', cols: 80, rows: 24 }),
    stop: async () => ({ exitCode: 0, signal: null }),
    setHostDraft: (_ref, value) => {
      state.hostDraftCalls.push(value);
      state.hostDraft = value;
    },
    on(event: string, listener: never): () => void {
      if (event !== 'draft') return () => {};
      const typed = listener as (ref: SessionRef, hasDraft: boolean) => void;
      draftListeners.add(typed);
      return () => draftListeners.delete(typed);
    },
  } as PtyManager;

  return state;
}
