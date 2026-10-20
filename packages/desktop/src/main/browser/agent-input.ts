// packages/desktop/src/main/browser/agent-input.ts
/**
 * Ввод агента в страницу (этап D, задача 9). Единственное место, где агент шлёт `Input.*` гостю: клавиши, текст и мышь идут
 * через CDP, прямых `send('Input.…')` в других модулях нет.
 *
 * Фокус (путь А, решение владельца 7; спайк В1, В3, В4): CDP-клавиатура без фокуса `<webview>` уходит в поле человека, а клик
 * уводит фокус окна на `<webview>`. Поэтому перед первым шагом ввода операции — и клавиш, и мыши — зовётся `borrowFocus`
 * (окно фокусирует `<webview>`; вернёт его по концу операции само), затем один раз включается
 * `Emulation.setFocusEmulationEnabled` (без неё страница видит `blur` после возврата фокуса). «Одолжено» помнится по
 * `AbortSignal` операции. Без `borrowFocus` (тесты, будущий путь без фокуса) ничего этого не делается.
 *
 * Перед каждым шагом — `guard.check()` (Stop, пауза, выключатель, `human_busy`, тишина клавиатуры человека) и
 * `signal.throwIfAborted()`. Обрыв посреди жеста не оставляет страницу с зажатой кнопкой или клавишей: после `mousePressed`
 * уходит один `mouseReleased`, после `keyDown` — один `keyUp`, мимо `guard`.
 */
import type { WebContents } from 'electron';
import type { BrowserAgentModifier } from '@parley/protocol';
import type { Inspector } from './inspector.js';

export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export interface MouseStep {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'left' | 'none';
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

/** `check` бросает `AgentOpError` (Stop, пауза, выключатель, human_busy, человек печатает). */
export interface InputGuard {
  signal: AbortSignal;
  check(): void;
}

type Fit = { scale: number; mobile: boolean } | null;
type Point = { x: number; y: number };

/** Точка для CDP `Input.*`: без эмуляции — как есть; эмуляция — × scale; мобильная — ещё ÷ zoom (спайк В6). */
export function inputPoint(point: Point, fit: Fit, zoom: number): Point {
  if (fit === null) return { x: point.x, y: point.y };
  const divisor = fit.mobile ? zoom : 1;
  return { x: (point.x * fit.scale) / divisor, y: (point.y * fit.scale) / divisor };
}

/** Точка для окна — в пикселях элемента `<webview>`: без эмуляции × zoom; эмуляция × scale, не мобильная ещё × zoom (спайк В6). */
export function viewPoint(point: Point, fit: Fit, zoom: number): Point {
  const factor = fit === null ? zoom : fit.mobile ? fit.scale : fit.scale * zoom;
  return { x: point.x * factor, y: point.y * factor };
}

const NAMED_KEYS: Readonly<Record<string, KeySpec>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** Клавиша по имени или один печатный символ; незнакомое имя — `null`. */
export function keySpec(key: string): KeySpec | null {
  const named = NAMED_KEYS[key];
  if (named !== undefined) return { ...named };
  if ([...key].length !== 1) return null;
  const upper = key.toUpperCase();
  const keyCode = upper.charCodeAt(0);
  let code = '';
  if (/^[a-zA-Z]$/.test(key)) code = `Key${upper}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  return { key, code, keyCode, text: key };
}

const MODIFIER_BITS: Readonly<Record<BrowserAgentModifier, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(modifiers: readonly BrowserAgentModifier[]): number {
  return modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0);
}

export interface AgentInput {
  /** Обрыв после mousePressed — один mouseReleased мимо guard. */
  mouse(contents: WebContents, steps: readonly MouseStep[], modifiers: number, guard: InputGuard): Promise<void>;
  /** Обрыв после keyDown — один keyUp мимо guard. */
  key(contents: WebContents, spec: KeySpec, modifiers: number, guard: InputGuard): Promise<void>;
  text(contents: WebContents, text: string, guard: InputGuard): Promise<void>;
}

/** Control или Meta: символ не печатается, это сочетание. */
const COMMAND_MODIFIERS = 2 | 4;

export function createAgentInput(deps: {
  inspector: Pick<Inspector, 'send'>;
  /** Бросает `tab_hidden` (окно не поставило фокус) или `human_busy` (человек печатает). */
  borrowFocus?(contents: WebContents, signal: AbortSignal): Promise<void>;
}): AgentInput {
  /** Операции, которым фокус уже одолжен (ключ — signal операции). */
  const focused = new WeakSet<AbortSignal>();

  async function send(contents: WebContents, method: string, params: Record<string, unknown>): Promise<void> {
    await deps.inspector.send(contents.id, method, params);
  }

  /** Фокус — до первого шага ввода операции; кэша на гостя нет: отладчик переподключается на навигации. */
  async function ensureFocus(contents: WebContents, signal: AbortSignal): Promise<void> {
    if (deps.borrowFocus === undefined || focused.has(signal)) return;
    await deps.borrowFocus(contents, signal);
    await send(contents, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    focused.add(signal);
  }

  async function step(contents: WebContents, guard: InputGuard, method: string, params: Record<string, unknown>): Promise<void> {
    guard.check();
    guard.signal.throwIfAborted();
    await ensureFocus(contents, guard.signal);
    await send(contents, method, params);
  }

  return {
    async text(contents, text, guard) {
      await step(contents, guard, 'Input.insertText', { text });
    },

    async key(contents, spec, modifiers, guard) {
      const down: Record<string, unknown> = { type: 'keyDown', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, modifiers };
      if (spec.text !== undefined && (modifiers & COMMAND_MODIFIERS) === 0) down.text = spec.text;
      if (spec.key === 'a' && (modifiers & COMMAND_MODIFIERS) !== 0) down.commands = ['selectAll'];
      await step(contents, guard, 'Input.dispatchKeyEvent', down);
      const up = { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, modifiers };
      try {
        await step(contents, guard, 'Input.dispatchKeyEvent', up);
      } catch (error) {
        // Клавиша зажата — отпускаем мимо guard, чтобы страница не осталась с нажатой.
        await send(contents, 'Input.dispatchKeyEvent', up).catch(() => undefined);
        throw error;
      }
    },

    async mouse(contents, steps, modifiers, guard) {
      let pressed: MouseStep | null = null;
      try {
        for (const item of steps) {
          const params: Record<string, unknown> = { type: item.type, x: item.x, y: item.y, modifiers };
          if (item.button !== undefined) params.button = item.button;
          if (item.buttons !== undefined) params.buttons = item.buttons;
          if (item.clickCount !== undefined) params.clickCount = item.clickCount;
          if (item.deltaX !== undefined) params.deltaX = item.deltaX;
          if (item.deltaY !== undefined) params.deltaY = item.deltaY;
          await step(contents, guard, 'Input.dispatchMouseEvent', params);
          if (item.type === 'mousePressed') pressed = item;
          else if (item.type === 'mouseReleased') pressed = null;
        }
      } catch (error) {
        if (pressed !== null) {
          await send(contents, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: pressed.x,
            y: pressed.y,
            modifiers,
            button: pressed.button ?? 'left',
            clickCount: pressed.clickCount ?? 1,
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
