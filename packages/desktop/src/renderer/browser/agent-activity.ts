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
 *
 * Из гостя в гостя (фокус человека в `<webview>` его вкладки браузера) Chromium переводит фокус ввода во вложенную страницу,
 * только когда фокус у самого окна: `node.focus()` поверх другого гостя меняет `document.activeElement`, а клавиши идут
 * в прежнего гостя (E2E 22a, тест 3). Поэтому прежний `<webview>` сначала теряет фокус (`blur()` отдаёт его окну), и лишь
 * затем фокус встаёт на `<webview>` агента; на возврате — так же через окно.
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

/**
 * Гости, которым окно сейчас одалживает фокус → их `<webview>` и элемент человека, которому фокус вернуть. `focus` такого
 * гостя не делает вкладку или группу активной (рецензия M1); одалживание поверх чужого берёт элемент человека (B1).
 */
const lending = new Map<number, { node: Element; previous: Element | null }>();

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

/** `<webview>` другой страницы: фокус в нём — фокус ввода вложенной страницы, а не окна. */
const isGuestView = (element: Element): boolean => element.tagName === 'WEBVIEW';

export function createFocusLender({ view, webContentsId, ready }: FocusLenderOptions): FocusLender {
  /** Чей фокус вернуть по концу операции; `undefined` — в этой операции фокус не одалживали, `node` — человек сам был в странице агента. */
  let previous: Element | null | undefined;

  const restore = (): void => {
    const node = view();
    const was = previous;
    previous = undefined;
    lending.delete(webContentsId);
    // Не одалживали, человек сам был в этой странице или ушёл с `<webview>` сам — его фокус не трогаем.
    if (was === undefined || node === null || document.activeElement !== node || was === node) return;
    if (was instanceof HTMLElement && document.contains(was)) {
      // Возврат в гостя человека — через окно, как и одалживание.
      if (isGuestView(was)) node.blur();
      was.focus();
    }
    // Вернуть некуда: `body`, элемент удалён или фокус не взял (финальная рецензия M1). Фокус уходит окну, а не остаётся
    // в странице агента, где одолжения уже нет.
    if (document.activeElement === node) node.blur();
  };

  return {
    borrow(id) {
      const node = view();
      if (node === null) {
        ready(id, false);
        return;
      }
      const active = document.activeElement;
      // Повторная просьба в той же операции: прежний элемент человека остаётся тем, кому вернуть фокус. Фокус одолжен
      // другой странице (страховка к аренде клавиатуры main, финальная рецензия B1): вернуть его — человеку, а не в чужой `<webview>`.
      if (previous === undefined) {
        const lent = [...lending.values()].find((entry) => entry.node === active);
        previous = lent === undefined ? active : lent.previous;
      }
      lending.set(webContentsId, { node, previous });
      // Фокус в другом госте: сначала отдать его окну, иначе ввод агента уйдёт в того гостя.
      const other = active !== node && active instanceof HTMLElement && isGuestView(active) ? active : null;
      other?.blur();
      node.focus();
      const ok = document.activeElement === node;
      if (!ok) {
        lending.delete(webContentsId);
        previous = undefined;
        // Фокус не встал: гость человека получает его обратно.
        other?.focus();
      }
      ready(id, ok);
    },
    restore,
    dispose: restore,
  };
}
