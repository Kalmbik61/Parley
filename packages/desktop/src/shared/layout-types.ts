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

export type TabSpec =
  | { kind: 'terminal'; id: string; sessionId: string }
  | { kind: 'mail'; id: 'mail' }
  | { kind: 'room'; id: string; roomId: string }
  // commit: null — все изменения ветки, иначе один коммит.
  | { kind: 'diff'; id: string; sessionId: string; commit: string | null }
  // path — относительный.
  | { kind: 'file'; id: string; root: FileRootSpec; path: string }
  | { kind: 'browser'; id: string; url: string };

export interface WorkLayout {
  root: LayoutNode;
  activeGroupId: string;
  /** Стек для ⌘⇧T, не больше 10 (см. `LIMITS.closedTabs` в `layout/tree.ts`). */
  closedTabs: TabSpec[];
}
