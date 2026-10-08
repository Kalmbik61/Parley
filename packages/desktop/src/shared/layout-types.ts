/**
 * Модель раскладки работы (спека 5.2, кусок 2.1 плана каркаса): дерево сплитов
 * из групп вкладок. Тип на диске и в памяти один — раскладка живёт в
 * `layouts.json` (`main/layout-store.ts`, кусок 2.2) и в рендерере одновременно.
 *
 * Id вкладок здесь — просто `string`, а не шаблонные типы спеки
 * (`` `terminal:${string}` `` и т. д.): строит их `renderer/layout/ids.ts`, а
 * здесь достаточно формы данных. Два места для одного и того же шаблона id
 * означали бы, что при правке формата их можно поправить порознь.
 */

import type { ViewportSpec } from './browser-devtools.js';

export type LayoutNode = GroupNode | SplitNode;

export interface GroupNode {
  type: 'group';
  id: string;
  /** Порядок = порядок в строке вкладок. */
  tabs: TabSpec[];
  /** `null` — только у пустой корневой группы. */
  activeTabId: string | null;
}

export interface SplitNode {
  type: 'split';
  id: string;
  /** `row` — рядом, `column` — друг под другом. */
  direction: 'row' | 'column';
  /** Доля первого ребёнка, 0.1…0.9. */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export type FileRootSpec = { kind: 'project' } | { kind: 'worktree'; sessionId: string };

/** Вид вкладки сессии (план 2026-10-01, решение 6): лента «Chat» или терминал. */
export type TerminalView = 'chat' | 'terminal';

export type TabSpec =
  // view: нет поля — умолчание по сессии (`renderer/lib/feed-view.ts`); есть — выбор человека переключателем.
  | { kind: 'terminal'; id: string; sessionId: string; view?: TerminalView }
  | { kind: 'mail'; id: 'mail' }
  | { kind: 'room'; id: string; roomId: string }
  // commit: null — все изменения ветки, иначе один коммит.
  | { kind: 'diff'; id: string; sessionId: string; commit: string | null }
  // path — относительный.
  | { kind: 'file'; id: string; root: FileRootSpec; path: string }
  // viewport: нет поля — Fit (спека 2026-10-07-browser-devtools-agent-design.md, 4.2); размер переживает перезапуск.
  | { kind: 'browser'; id: string; url: string; viewport?: ViewportSpec };

export interface WorkLayout {
  root: LayoutNode;
  activeGroupId: string;
  /** Стек для ⌘⇧T, не больше 10 (см. `LIMITS.closedTabs` в `layout/tree.ts`). */
  closedTabs: TabSpec[];
}
