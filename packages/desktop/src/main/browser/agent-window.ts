// packages/desktop/src/main/browser/agent-window.ts
/**
 * Окно операции агента (спека 5.2): пока идёт операция и ещё `guardTailMs` после неё события гостя (скачивание,
 * выбор файла, новое окно) принадлежат агенту, а не человеку. Здесь только учёт окна и заметок; решения принимают
 * вызывающие (`guard.ts`, `agent-ops.ts`).
 */
import { AGENT_LIMITS } from '@parley/protocol';

export interface AgentWindowOwner { pageKey: string; webContentsId: number; workKey: string; sessionId: string; agentId: string }

export interface AgentWindow {
  /** Конец операции → хвост guardTailMs. */
  begin(owner: AgentWindowOwner): () => void;
  activeFor(webContentsId: number): AgentWindowOwner | null;
  /** События в окне: скачивание, выбор файла, новое окно. Вне окна — отбрасываются. */
  note(webContentsId: number, note: string): void;
  /** Заметки с начала последнего begin; забирает. */
  take(pageKey: string): string[];
  /** Окно и хвост кончились. */
  onIdle(listener: (webContentsId: number) => void): () => void;
}

interface Entry { owner: AgentWindowOwner; open: number; cancelTail: (() => void) | null }

export function createAgentWindow(deps: { tailMs?: number; setTimer?(fn: () => void, ms: number): () => void } = {}): AgentWindow {
  const tailMs = deps.tailMs ?? AGENT_LIMITS.guardTailMs;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  const entries = new Map<number, Entry>();
  const notes = new Map<string, string[]>();
  const listeners = new Set<(webContentsId: number) => void>();

  return {
    begin(owner) {
      const id = owner.webContentsId;
      let entry = entries.get(id);
      if (!entry) { entry = { owner, open: 0, cancelTail: null }; entries.set(id, entry); }
      entry.owner = owner;
      entry.open += 1;
      entry.cancelTail?.();
      entry.cancelTail = null;
      notes.set(owner.pageKey, []);
      const current = entry;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        current.open -= 1;
        if (current.open > 0) return;
        current.cancelTail = setTimer(() => {
          if (entries.get(id) !== current) return;
          entries.delete(id);
          for (const listener of [...listeners]) listener(id);
        }, tailMs);
      };
    },
    activeFor: (webContentsId) => entries.get(webContentsId)?.owner ?? null,
    note(webContentsId, note) {
      const entry = entries.get(webContentsId);
      if (!entry) return;
      const list = notes.get(entry.owner.pageKey) ?? [];
      list.push(note);
      notes.set(entry.owner.pageKey, list);
    },
    take(pageKey) {
      const list = notes.get(pageKey) ?? [];
      notes.delete(pageKey);
      return list;
    },
    onIdle(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
