/**
 * Реестр живых поверхностей терминала (4.3, 5.3) — отдельно от `TerminalSurface.tsx`, без React
 * и xterm: его читает `attention/focus-target.ts`, а `TerminalSurface` сам зовёт переход по цели
 * («Open S02» тоста отправки). Живи реестр в `TerminalSurface.tsx`, импорты замкнулись бы в цикл.
 */

import type { SearchAddon } from '@xterm/addon-search';

/**
 * openSearch() — с 2.5, с 5.3 открывает SearchBar с фокусом в поле.
 * clear() — с 5.3: term.clear(), агенту ничего не уходит. Их зовут действия find и terminal.clear (`AppShell#run`, 6.1b).
 */
export interface TerminalSurfaceHandle {
  focus(): void;
  scrollToBottom(): void;
  search: SearchAddon | null;
  openSearch(): void;
  clear(): void;
  /** Фокус ввода внутри xterm этой поверхности — `terminal.clear` по клавише и пункту меню только сюда. */
  hasFocus(): boolean;
}

/** Реестр живых поверхностей для фокуса, прокрутки и поиска (4.3, 5.3). */
export const terminalSurfaces: Map<string /* refKey */, TerminalSurfaceHandle> = new Map();
