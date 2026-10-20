// packages/desktop/src/renderer/browser/agent-activity.ts
/**
 * Что агент делает на странице, глазами окна (этап D): значок со Stop (ярлык сессии и последние операции), точка клика и
 * одалживание фокуса. Всё идёт из событий `browser:agent-activity`, которые main шлёт окну-хозяину гостя; состояние ведётся
 * по `webContentsId` гостя. Значок живёт операцию и ещё `AGENT_LIMITS.guardTailMs` (хвост окна операции в main), точка —
 * `clickDotMs`.
 *
 * Одалживание фокуса (путь А, решение владельца 7): CDP-ввод агента доходит до гостя только при фокусе на `<webview>`.
 * Окно запоминает `document.activeElement` человека, ставит фокус на `<webview>` и отвечает main; по концу операции возвращает
 * фокус обратно. `hostWebContents.focus()` и `guest.focus()` не зовутся: они отнимают фокус ОС у человека.
 */
import { create } from 'zustand';
import { AGENT_LIMITS } from '@parley/protocol';
import type { AgentActivity } from '../../shared/browser-types.js';

export interface AgentActing {
  session: string;
  recent: string[];
}
export interface AgentView {
  acting: AgentActing | null;
  dot: { x: number; y: number } | null;
}

const EMPTY: AgentView = { acting: null, dot: null };

interface ActivityState {
  byId: Record<number, AgentView>;
}

const useActivityStore = create<ActivityState>(() => ({ byId: {} }));

/** Последние операции по гостям: переживают снятие значка, чтобы подсказка следующей операции помнила прежние. */
const history = new Map<number, string[]>();
const tailTimers = new Map<number, ReturnType<typeof setTimeout>>();
const dotTimers = new Map<number, ReturnType<typeof setTimeout>>();

function patch(id: number, next: Partial<AgentView>): void {
  useActivityStore.setState((state) => {
    const merged: AgentView = { ...(state.byId[id] ?? EMPTY), ...next };
    if (merged.acting === null && merged.dot === null) {
      const rest = { ...state.byId };
      delete rest[id];
      return { byId: rest };
    }
    return { byId: { ...state.byId, [id]: merged } };
  });
}

function clearTimer(timers: Map<number, ReturnType<typeof setTimeout>>, id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/** Событие активности своего гостя: значок, точка. Фокус и размер обрабатывает поверхность. */
export function applyAgentActivity(event: AgentActivity): void {
  const id = event.webContentsId;
  if (event.phase === 'start') {
    clearTimer(tailTimers, id);
    const recent = [...(history.get(id) ?? []), event.op].slice(-AGENT_LIMITS.badgeOps);
    history.set(id, recent);
    patch(id, { acting: { session: event.session, recent } });
    return;
  }
  if (event.phase === 'end') {
    clearTimer(tailTimers, id);
    tailTimers.set(
      id,
      setTimeout(() => {
        tailTimers.delete(id);
        patch(id, { acting: null });
      }, AGENT_LIMITS.guardTailMs),
    );
    return;
  }
  if (event.point !== undefined) {
    clearTimer(dotTimers, id);
    patch(id, { dot: event.point });
    dotTimers.set(
      id,
      setTimeout(() => {
        dotTimers.delete(id);
        patch(id, { dot: null });
      }, AGENT_LIMITS.clickDotMs),
    );
  }
}

/** Текущее состояние гостя без подписки (тесты, обработчики). */
export function agentActivityOf(webContentsId: number | null): AgentView {
  return webContentsId === null ? EMPTY : (useActivityStore.getState().byId[webContentsId] ?? EMPTY);
}

/** Значок и точка гостя; `null` — гость ещё не известен. */
export function useAgentActivity(webContentsId: number | null): AgentView {
  return useActivityStore((state) => (webContentsId === null ? EMPTY : (state.byId[webContentsId] ?? EMPTY)));
}

/** Тесты: окно начинает с чистого состояния. */
export function resetAgentActivity(): void {
  for (const timer of [...tailTimers.values(), ...dotTimers.values()]) clearTimeout(timer);
  tailTimers.clear();
  dotTimers.clear();
  history.clear();
  useActivityStore.setState({ byId: {} });
}

/** Гости, которым окно сейчас одалживает фокус: их `focus` не делает вкладку или группу активной (рецензия M1). */
const lending = new Set<number>();

export function isLendingFocus(webContentsId: number | null): boolean {
  return webContentsId !== null && lending.has(webContentsId);
}

export interface FocusLenderOptions {
  /** Живой `<webview>` страницы; `null` — его нет. */
  view(): HTMLElement | null;
  webContentsId: number;
  /** Ответ main (`agentFocusReady`): `ok` — фокус действительно на `<webview>`. */
  ready(id: string, ok: boolean): void;
}

export interface FocusLender {
  borrow(id: string): void;
  restore(): void;
  dispose(): void;
}

export function createFocusLender({ view, webContentsId, ready }: FocusLenderOptions): FocusLender {
  let previous: Element | null = null;

  const restore = (): void => {
    const node = view();
    const was = previous;
    previous = null;
    lending.delete(webContentsId);
    // Человек ушёл с `<webview>` сам — его фокус не трогаем.
    if (node !== null && document.activeElement === node && was instanceof HTMLElement && document.contains(was)) was.focus();
  };

  return {
    borrow(id) {
      const node = view();
      if (node === null) {
        ready(id, false);
        return;
      }
      // Повторная просьба в той же операции: прежний элемент человека остаётся тем, кому вернуть фокус.
      if (previous === null && document.activeElement !== node) previous = document.activeElement;
      lending.add(webContentsId);
      node.focus();
      const ok = document.activeElement === node;
      if (!ok) {
        lending.delete(webContentsId);
        previous = null;
      }
      ready(id, ok);
    },
    restore,
    dispose: restore,
  };
}
