/**
 * Реестр клавиш (кусок 6.1a, спека 9.6): одна таблица для меню main, обработчика
 * рендерера (`renderer/keys/handler.ts`), палитры и пересылки из `<webview>`
 * (`main/guest-shortcuts.ts`). Лежит в `shared/`, потому что её читают и main, и
 * рендерер — как `strings.ts`.
 */
import { S } from './strings.js';

/** Системные меню; подписи — S.menu.edit/view/workspace/tab/terminal, у app — «Parley», как сейчас. */
export type MenuName = 'app' | 'edit' | 'view' | 'workspace' | 'tab' | 'terminal';
export type ActionId =
  | 'palette.open' | 'files.quickOpen' | 'files.search'
  | 'work.new' | 'session.new' | 'room.new' | 'project.capabilities'
  | 'work.goto.1' | 'work.goto.2' | 'work.goto.3' | 'work.goto.4' | 'work.goto.5'
  | 'work.goto.6' | 'work.goto.7' | 'work.goto.8' | 'work.goto.9'
  | 'work.prev' | 'work.next' | 'works.showArchived'
  | 'history.back' | 'history.forward'
  | 'sidebar.left.toggle' | 'sidebar.right.toggle' | 'sidebar.files' | 'sidebar.changes'
  | 'group.splitRight' | 'group.splitDown' | 'group.prev' | 'group.next'
  | 'tab.close' | 'tab.reopen' | 'tab.prev' | 'tab.next' | 'tab.mruNext' | 'tab.mruPrev'
  | 'tab.goto.1' | 'tab.goto.2' | 'tab.goto.3' | 'tab.goto.4' | 'tab.goto.5'
  | 'tab.goto.6' | 'tab.goto.7' | 'tab.goto.8' | 'tab.goto.9'
  | 'find' | 'voice.toggle' | 'terminal.clear' | 'chat.toggleView' | 'settings.open'
  | 'attention.next' | 'wake.toggle' | 'host.restart'
  | 'appearance.system' | 'appearance.dark' | 'appearance.light'
  | 'browser.newTab'
  | 'browser.find' | 'browser.zoomIn' | 'browser.zoomOut' | 'browser.zoomReset'; // when: 'browser', menu: null

export interface ActionDef {
  id: ActionId;
  title: string; // из S.actions: для меню и палитры
  keywords: string[]; // для палитры, английские
  keys: string | null; // accelerator Electron: 'CmdOrCtrl+J', 'Control+Tab'…
  menu: MenuName | null; // null — без пункта меню (⌃Tab, ⌃1–9, палитровые действия)
  // 'editor' из брифа убран в раунде исправлений 1: ни одно действие его не берёт (план 7 тоже),
  // сочетания Monaco гасит список MONACO_KEYS обработчика.
  when: 'always' | 'terminal' | 'browser';
  inPalette: boolean; // false — служебное: palette.open, work.goto.N, tab.goto.N, tab.mruNext/Prev
  // Удержание клавиши повторяет действие — только шаги навигации и масштаба. У прочих
  // автоповтор гасится без запуска: удержанный ⌘N иначе создал бы несколько работ.
  repeatable?: true;
}

type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
const DIGITS: readonly Digit[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Действие для палитры: без сочетания и меню, работает в любом контексте. */
function paletteOnly(id: ActionId, title: string, keywords: string[]): ActionDef {
  return { id, title, keywords, keys: null, menu: null, when: 'always', inPalette: true };
}

/** Таблица спеки 9.6 целиком. Порядок — порядок пунктов в меню (6.1b). */
export const ACTIONS: readonly ActionDef[] = [
  paletteOnly('project.capabilities', S.actions.capabilities, ['project', 'skills', 'mcp', 'plugins']),
  { id: 'settings.open', title: S.actions.settings, keywords: ['preferences', 'options'], keys: 'CmdOrCtrl+,', menu: 'app', when: 'always', inPalette: true },

  { id: 'find', title: S.actions.find, keywords: ['search', 'terminal'], keys: 'CmdOrCtrl+F', menu: 'edit', when: 'terminal', inPalette: true },
  // Диктовка (спека 2026-10-06-voice-input-design.md, 3.4): поле или терминал с фокусом; идёт запись — её стоп.
  { id: 'voice.toggle', title: S.actions.toggleDictation, keywords: ['voice', 'dictation', 'microphone', 'speech'], keys: 'CmdOrCtrl+Shift+M', menu: 'edit', when: 'always', inPalette: true },

  { id: 'palette.open', title: S.actions.commandPalette, keywords: ['command', 'palette'], keys: 'CmdOrCtrl+J', menu: 'view', when: 'always', inPalette: false },
  { id: 'files.quickOpen', title: S.actions.goToFile, keywords: ['open', 'file', 'quick'], keys: 'CmdOrCtrl+P', menu: 'view', when: 'always', inPalette: true },
  { id: 'files.search', title: S.actions.findInFiles, keywords: ['search', 'grep', 'files'], keys: 'CmdOrCtrl+Shift+F', menu: 'view', when: 'always', inPalette: true },
  { id: 'history.back', title: S.actions.back, keywords: ['history', 'navigate'], keys: 'CmdOrCtrl+Alt+Left', menu: 'view', when: 'always', inPalette: true },
  { id: 'history.forward', title: S.actions.forward, keywords: ['history', 'navigate'], keys: 'CmdOrCtrl+Alt+Right', menu: 'view', when: 'always', inPalette: true },
  { id: 'sidebar.left.toggle', title: S.actions.toggleWorkspaceSidebar, keywords: ['sidebar', 'workspaces', 'hide', 'show'], keys: 'CmdOrCtrl+B', menu: 'view', when: 'always', inPalette: true },
  { id: 'sidebar.right.toggle', title: S.actions.toggleRightSidebar, keywords: ['sidebar', 'right', 'hide', 'show'], keys: 'CmdOrCtrl+L', menu: 'view', when: 'always', inPalette: true },
  { id: 'sidebar.files', title: S.actions.showFiles, keywords: ['explorer', 'tree', 'files'], keys: 'CmdOrCtrl+Shift+E', menu: 'view', when: 'always', inPalette: true },
  { id: 'sidebar.changes', title: S.actions.showChanges, keywords: ['git', 'diff', 'changes'], keys: 'CmdOrCtrl+Shift+G', menu: 'view', when: 'always', inPalette: true },

  { id: 'work.new', title: S.actions.newWorkspace, keywords: ['create', 'workspace'], keys: 'CmdOrCtrl+N', menu: 'workspace', when: 'always', inPalette: true },
  { id: 'session.new', title: S.actions.newSession, keywords: ['create', 'agent', 'session', 'room'], keys: 'CmdOrCtrl+T', menu: 'workspace', when: 'always', inPalette: true },
  ...DIGITS.map(
    (n): ActionDef => ({ id: `work.goto.${n}`, title: S.actions.workspaceNumber(n), keywords: ['workspace'], keys: `CmdOrCtrl+${n}`, menu: 'workspace', when: 'always', inPalette: false }),
  ),
  { id: 'work.prev', title: S.actions.previousWorkspace, keywords: ['workspace', 'up'], keys: 'CmdOrCtrl+Shift+Up', menu: 'workspace', when: 'always', inPalette: true, repeatable: true },
  { id: 'work.next', title: S.actions.nextWorkspace, keywords: ['workspace', 'down'], keys: 'CmdOrCtrl+Shift+Down', menu: 'workspace', when: 'always', inPalette: true, repeatable: true },

  { id: 'group.splitRight', title: S.actions.splitRight, keywords: ['split', 'group', 'pane'], keys: 'CmdOrCtrl+D', menu: 'tab', when: 'always', inPalette: true },
  { id: 'group.splitDown', title: S.actions.splitDown, keywords: ['split', 'group', 'pane'], keys: 'CmdOrCtrl+Shift+D', menu: 'tab', when: 'always', inPalette: true },
  { id: 'tab.close', title: S.actions.closeTab, keywords: ['close', 'tab'], keys: 'CmdOrCtrl+W', menu: 'tab', when: 'always', inPalette: true },
  { id: 'tab.reopen', title: S.actions.reopenClosedTab, keywords: ['reopen', 'restore', 'tab'], keys: 'CmdOrCtrl+Shift+T', menu: 'tab', when: 'always', inPalette: true },
  { id: 'tab.prev', title: S.actions.previousTab, keywords: ['tab', 'left'], keys: 'CmdOrCtrl+Shift+[', menu: 'tab', when: 'always', inPalette: true, repeatable: true },
  { id: 'tab.next', title: S.actions.nextTab, keywords: ['tab', 'right'], keys: 'CmdOrCtrl+Shift+]', menu: 'tab', when: 'always', inPalette: true, repeatable: true },
  { id: 'group.prev', title: S.actions.previousGroup, keywords: ['group', 'pane'], keys: 'CmdOrCtrl+[', menu: 'tab', when: 'always', inPalette: true, repeatable: true },
  { id: 'group.next', title: S.actions.nextGroup, keywords: ['group', 'pane'], keys: 'CmdOrCtrl+]', menu: 'tab', when: 'always', inPalette: true, repeatable: true },
  { id: 'tab.mruNext', title: S.actions.nextRecentTab, keywords: ['recent', 'tab'], keys: 'Control+Tab', menu: null, when: 'always', inPalette: false },
  { id: 'tab.mruPrev', title: S.actions.previousRecentTab, keywords: ['recent', 'tab'], keys: 'Control+Shift+Tab', menu: null, when: 'always', inPalette: false },
  ...DIGITS.map(
    (n): ActionDef => ({ id: `tab.goto.${n}`, title: S.actions.tabNumber(n), keywords: ['tab'], keys: `Control+${n}`, menu: null, when: 'always', inPalette: false }),
  ),

  { id: 'terminal.clear', title: S.actions.clearTerminal, keywords: ['clear', 'reset', 'terminal'], keys: 'CmdOrCtrl+K', menu: 'terminal', when: 'terminal', inPalette: true },
  // Вид вкладки сессии (план 2026-10-01, решение 6): та же команда, что сегмент тулбара; без клавиши и меню.
  { id: 'chat.toggleView', title: S.actions.toggleChatTerminal, keywords: ['chat', 'terminal', 'view', 'switch'], keys: null, menu: null, when: 'terminal', inPalette: true },

  paletteOnly('room.new', S.actions.newRoom, ['create', 'room']),
  paletteOnly('works.showArchived', S.actions.showArchivedWorkspaces, ['archive', 'archived', 'workspaces']),
  paletteOnly('attention.next', S.actions.nextNeedsYou, ['attention', 'blocked', 'needs you']),
  paletteOnly('wake.toggle', S.actions.pauseAutoWake, ['auto-wake', 'pause', 'resume', 'wake']),
  paletteOnly('host.restart', S.actions.restartHost, ['host', 'restart', 'reload']),
  paletteOnly('appearance.system', S.actions.themeSystem, ['theme', 'appearance', 'system']),
  paletteOnly('appearance.dark', S.actions.themeDark, ['theme', 'appearance', 'dark']),
  paletteOnly('appearance.light', S.actions.themeLight, ['theme', 'appearance', 'light']),
  paletteOnly('browser.newTab', S.actions.newBrowserTab, ['browser', 'web', 'url']),

  // Фокус в странице — клавиши у гостя: их пересылает main (`main/guest-shortcuts.ts`), рендерер не ловит.
  { id: 'browser.find', title: S.actions.findInPage, keywords: ['browser', 'search', 'page'], keys: 'CmdOrCtrl+F', menu: null, when: 'browser', inPalette: true },
  { id: 'browser.zoomIn', title: S.actions.zoomIn, keywords: ['browser', 'zoom', 'bigger'], keys: 'CmdOrCtrl+Plus', menu: null, when: 'browser', inPalette: true, repeatable: true },
  { id: 'browser.zoomOut', title: S.actions.zoomOut, keywords: ['browser', 'zoom', 'smaller'], keys: 'CmdOrCtrl+-', menu: null, when: 'browser', inPalette: true, repeatable: true },
  { id: 'browser.zoomReset', title: S.actions.actualSize, keywords: ['browser', 'zoom', 'reset'], keys: 'CmdOrCtrl+0', menu: null, when: 'browser', inPalette: true },
];

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean; // набор IME: такое нажатие окну не достаётся
}

/**
 * Клавиша accelerator → допустимые `key` и `code`. `key` с Shift и в чужой раскладке
 * другой (⌘⇧[ даёт `{`, в русской — `Х`), поэтому `code` — запасной путь.
 */
const NAMED_KEYS: Record<string, { keys: readonly string[]; code: string }> = {
  Up: { keys: ['ArrowUp'], code: 'ArrowUp' },
  Down: { keys: ['ArrowDown'], code: 'ArrowDown' },
  Left: { keys: ['ArrowLeft'], code: 'ArrowLeft' },
  Right: { keys: ['ArrowRight'], code: 'ArrowRight' },
  Tab: { keys: ['Tab'], code: 'Tab' },
  Plus: { keys: ['+', '='], code: 'Equal' },
  '-': { keys: ['-', '_'], code: 'Minus' },
  '=': { keys: ['=', '+'], code: 'Equal' },
  ',': { keys: [',', '<'], code: 'Comma' },
  '/': { keys: ['/', '?'], code: 'Slash' },
  '[': { keys: ['[', '{'], code: 'BracketLeft' },
  ']': { keys: [']', '}'], code: 'BracketRight' },
};

function keyMatches(name: string, event: KeyLike): boolean {
  const named = NAMED_KEYS[name];
  if (named !== undefined) return named.keys.includes(event.key) || event.code === named.code;
  if (/^[A-Z]$/.test(name)) return event.key.toUpperCase() === name || event.code === `Key${name}`;
  if (/^\d$/.test(name)) return event.key === name || event.code === `Digit${name}`;
  return event.key === name;
}

/**
 * Нажатие совпадает с accelerator Electron. Модификаторы — точно: ⌘⇧D не ⌘D. `CmdOrCtrl` — ⌘:
 * окно собирается только под macOS. Буква сравнивается по `key` или по `code` — в русской раскладке
 * ⌘J даёт `key: 'о'` при `code: 'KeyJ'`. У `Plus` Shift не проверяется: `+` на американской
 * раскладке — это Shift+`=`.
 */
export function matchesAccelerator(accelerator: string, event: KeyLike): boolean {
  const parsed = parseAccelerator(accelerator);
  if (event.metaKey !== parsed.meta) return false;
  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.altKey !== parsed.alt) return false;
  if (parsed.name !== 'Plus' && event.shiftKey !== parsed.shift) return false;
  return keyMatches(parsed.name, event);
}

interface ParsedAccelerator {
  name: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Разбор по строке сочетания — один раз: matchesAccelerator зовётся десятки раз на каждое нажатие. */
const PARSED = new Map<string, ParsedAccelerator>();

function parseAccelerator(accelerator: string): ParsedAccelerator {
  const cached = PARSED.get(accelerator);
  if (cached !== undefined) return cached;
  const parts = accelerator.split('+');
  const mods = new Set(parts.slice(0, -1));
  const parsed: ParsedAccelerator = {
    name: parts[parts.length - 1] ?? '',
    meta: mods.has('CmdOrCtrl') || mods.has('CommandOrControl') || mods.has('Cmd') || mods.has('Command'),
    ctrl: mods.has('Control') || mods.has('Ctrl'),
    alt: mods.has('Alt') || mods.has('Option'),
    shift: mods.has('Shift'),
  };
  PARSED.set(accelerator, parsed);
  return parsed;
}
