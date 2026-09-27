/**
 * Единый обработчик клавиш окна (кусок 6.1a, спека 9.6). `resolveAction` — чистое решение
 * «кому нажатие»: полю или окну; `installKeyHandler` вешает его на `window`. С 6.1b его
 * ставит `AppShell` — единственный владелец сочетаний окна: прежние обработчики `LayoutView`,
 * `AppShell` и `use-terminal` ушли, а пункт меню — только запасной путь для клика мышью.
 */
import { ACTIONS, matchesAccelerator } from '../../shared/keybindings.js';
import type { ActionDef, ActionId, KeyLike } from '../../shared/keybindings.js';
import type { FocusContext } from './focus-context.js';

export type ResolvedKey = ActionId | { kind: 'palette.row'; index: number }; // index 0–8 — ⌘1–9

/**
 * Действия с исполнителем — ветки `runAction` (`palette/actions.ts`, 6.3); этапы 7–9 дописывают
 * свои. Прочие действия реестра нажатие не гасит, а клик пункта меню ничего не делает.
 */
export const IMPLEMENTED_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  'palette.open',
  'work.new',
  'session.new',
  'settings.open',
  'sidebar.left.toggle',
  ...ACTIONS.filter((action) => action.id.startsWith('work.goto.') || action.id.startsWith('tab.goto.')).map((action) => action.id),
  'work.prev',
  'work.next',
  'history.back',
  'history.forward',
  'group.splitRight',
  'group.splitDown',
  'group.prev',
  'group.next',
  'tab.close',
  'tab.reopen',
  'tab.prev',
  'tab.next',
  'tab.mruNext',
  'tab.mruPrev',
  'find',
  'terminal.clear',
  'works.showArchived',
  'attention.next',
  'wake.toggle',
  'host.restart',
  'appearance.system',
  'appearance.dark',
  'appearance.light',
  'room.new',
]);

/** Действию нужны методы хоста: без них оно недоступно, даже когда реализовано. */
const REQUIRED_HOST_METHODS: Partial<Record<ActionId, readonly string[]>> = {
  'wake.toggle': ['wake.pause', 'wake.resume'],
};

/**
 * Реализовано и поддержано хостом. methods — hostMethods(useHostStore.getState().status) в момент
 * нажатия: хук useHostSupports обработчику клавиш не годится. Действию, которому нужен метод хоста,
 * — ещё и methods.has(метод): wake.toggle — wake.pause и wake.resume.
 */
export function isActionAvailable(id: ActionId, methods: ReadonlySet<string>): boolean {
  if (!IMPLEMENTED_ACTIONS.has(id)) return false;
  return (REQUIRED_HOST_METHODS[id] ?? []).every((method) => methods.has(method));
}

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
/** Сочетание самой палитры из реестра — ⌘J. */
const PALETTE_KEYS: readonly string[] = ACTIONS.flatMap((action) => (action.id === 'palette.open' && action.keys !== null ? [action.keys] : []));

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
    // За открытой палитрой сочетания окна не действуют (кусок 6.2): ⌘W не закрывает вкладку под
    // ней, ⌘D не открывает второй выбор. Стрелки, Enter и Esc — полю палитры; ⌘J — закрыть.
    return PALETTE_KEYS.some((accelerator) => matchesAccelerator(accelerator, event)) ? 'palette.open' : null;
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
  const { paletteOpen } = input;
  const onKeyDown = (event: KeyboardEvent): void => {
    const resolved = resolveAction(event, input.context(), paletteOpen());
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
