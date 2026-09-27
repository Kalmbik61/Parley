/**
 * Единый обработчик клавиш окна (кусок 6.1a, спека 9.6). `resolveAction` — чистое решение
 * «кому нажатие»: полю или окну; `installKeyHandler` вешает его на `window`. Подключает
 * 6.1b — до этого старые обработчики `LayoutView`/`AppShell`/`use-terminal` на месте.
 */
import { ACTIONS, matchesAccelerator } from '../../shared/keybindings.js';
import type { ActionDef, ActionId, KeyLike } from '../../shared/keybindings.js';
import type { FocusContext } from './focus-context.js';

export type ResolvedKey = ActionId | { kind: 'palette.row'; index: number }; // index 0–8 — ⌘1–9

/** Сочетания Monaco: в реестре те же заняты `group.*`, `sidebar.right.toggle`, `work.*` — в редакторе они уступают. */
const MONACO_KEYS: readonly string[] = [
  'CmdOrCtrl+D',
  'CmdOrCtrl+K',
  'CmdOrCtrl+F',
  'CmdOrCtrl+S',
  'CmdOrCtrl+/',
  'CmdOrCtrl+[',
  'CmdOrCtrl+]',
  'CmdOrCtrl+L',
  'CmdOrCtrl+Shift+Up',
  'CmdOrCtrl+Shift+Down',
];

/** Правка текста в поле ввода. */
const INPUT_KEYS: readonly string[] = [
  'CmdOrCtrl+A',
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+X',
  'CmdOrCtrl+Z',
  'CmdOrCtrl+Shift+Z',
  'CmdOrCtrl+Left',
  'CmdOrCtrl+Right',
  'CmdOrCtrl+Shift+Up',
  'CmdOrCtrl+Shift+Down',
];

/** ⌃Tab, ⌃⇧Tab, ⌃1–9: окну везде, кроме поля и диалога — агенты их не используют. */
const CTRL_ONLY_IDS = new Set<ActionId>(['tab.mruNext', 'tab.mruPrev']);
for (let n = 1; n <= 9; n += 1) CTRL_ONLY_IDS.add(`tab.goto.${n}` as ActionId);

const PALETTE_ROW_KEYS: readonly string[] = Array.from({ length: 9 }, (_, index) => `CmdOrCtrl+${index + 1}`);

function matchesAny(accelerators: readonly string[], event: KeyLike): boolean {
  return accelerators.some((accelerator) => matchesAccelerator(accelerator, event));
}

/** Действия, которые удержание клавиши повторяет (шаги навигации). */
const REPEATABLE = new Set<ActionId>(ACTIONS.filter((action) => action.repeatable === true).map((action) => action.id));

/** `when` действия допускает контекст. `browser` рендерер не ловит: клавиши у гостя. */
function whenAllows(when: ActionDef['when'], context: FocusContext): boolean {
  if (when === 'always') return true;
  if (when === 'terminal') return context === 'terminal';
  return false;
}

/** Что отдаётся полю, а что окну — таблица «Контекст фокуса» спеки 9.6. null — не окну. */
export function resolveAction(event: KeyLike, context: FocusContext, paletteOpen: boolean): ResolvedKey | null {
  // Набор IME и модальный диалог — всё полю: за формой ⌘W не закрывает вкладку.
  if (event.isComposing || context === 'dialog') return null;
  if (paletteOpen) {
    const row = PALETTE_ROW_KEYS.findIndex((accelerator) => matchesAccelerator(accelerator, event));
    if (row !== -1) return { kind: 'palette.row', index: row };
  }
  if (context === 'monaco' && matchesAny(MONACO_KEYS, event)) return null;
  if (context === 'input' && matchesAny(INPUT_KEYS, event)) return null;
  const action = ACTIONS.find(
    (candidate) =>
      candidate.keys !== null && whenAllows(candidate.when, context) && matchesAccelerator(candidate.keys, event),
  );
  if (action === undefined) return null;
  if (context === 'input' && CTRL_ONLY_IDS.has(action.id)) return null;
  return action.id;
}

/** keydown на window в capture-фазе, keyup и blur. Отдаёт отписку. */
export function installKeyHandler(input: {
  run(id: ActionId): void;
  pickPaletteRow(index: number): void; // ⌘1–9 при открытой палитре
  context(): FocusContext;
  paletteOpen(): boolean;
  available(id: ActionId): boolean; // действие реализовано и поддержано хостом (6.1b)
  endMruCycle(): void; // keyup Control и blur окна — конец цикла ⌃Tab
}): () => void {
  // Сбой одного действия — в консоль, а не неперехваченной ошибкой окна; следующие нажатия работают.
  const guarded = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      console.error('[harnas] key action failed', error);
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const resolved = resolveAction(event, input.context(), input.paletteOpen());
    if (resolved === null) return;
    if (typeof resolved !== 'string') {
      event.preventDefault();
      event.stopPropagation();
      guarded(() => input.pickPaletteRow(resolved.index));
      return;
    }
    if (!input.available(resolved)) return;
    // Гасится всё выполненное: на macOS пункт меню получает только необработанное
    // страницей ⌘-сочетание — непогашенное сработало бы второй раз пунктом меню.
    // Capture на window раньше xterm и Monaco: ⌘K не уходит агенту.
    event.preventDefault();
    event.stopPropagation();
    // Автоповтор погашен выше, но запускает только шаг навигации: удержанный ⌘N — одна работа.
    if (event.repeat && !REPEATABLE.has(resolved)) return;
    guarded(() => input.run(resolved));
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Control') input.endMruCycle();
  };
  // blur без capture: так ловится только уход фокуса из окна, а не blur каждого поля.
  const onBlur = (): void => input.endMruCycle();

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
  };
}
