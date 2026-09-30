/**
 * Панель вкладки диффа (кусок 8.3, спека 11.3): «Inline / Side by side» (пишется в `ui.json`),
 * «Collapse all», «Expand all», «Wrap lines» и вид списка файлов — список или дерево.
 * Состояние держит `DiffTab`: панель только сообщает о нажатиях. «Send all unsent ▾» (8.4b) —
 * неотправленные неустаревшие заметки вкладки; в режиме коммита её нет.
 */

import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { Toggle } from '../ui/toggle.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';
import { SendMenu } from './notes/SendMenu.js';

export type DiffListMode = 'list' | 'tree';

export interface DiffToolbarProps {
  view: 'inline' | 'split';
  onView(view: 'inline' | 'split'): void;
  wrap: boolean;
  onWrap(wrap: boolean): void;
  onCollapseAll(): void;
  onExpandAll(): void;
  listMode: DiffListMode;
  onListMode(mode: DiffListMode): void;
  /** «Send all unsent» (8.4b); null — режим коммита, кнопки нет. */
  sendAll?: { entry: WorkEntry; defaultSessionId: string; disabled: boolean; onSend(sessionId: string): void } | null;
}

// Без переноса внутри кнопки: «Side by side» на узкой панели ломался в три строки. Переносится
// панель целиком — кнопками на вторую строку.
const ITEM = 'h-6 whitespace-nowrap px-2 text-xs';

export function DiffToolbar(props: DiffToolbarProps): JSX.Element {
  return (
    // Раунд fix-live, D3: на 800 px панель прокручивалась, и «Send all unsent ▾» и List / Tree
    // прятались за краем без признака. Теперь кнопки переносятся на вторую строку, высота — от
    // содержимого; List / Tree остаются справа (`ml-auto`) и там.
    <div className="flex min-h-9 min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1">
      <ToggleGroup
        type="single"
        size="sm"
        value={props.view}
        // Повторный клик по выбранному снял бы выбор: пустое значение пропускаем.
        onValueChange={(value) => (value === 'inline' || value === 'split' ? props.onView(value) : undefined)}
      >
        <ToggleGroupItem value="inline" className={ITEM}>
          {S.changes.inline}
        </ToggleGroupItem>
        <ToggleGroupItem value="split" className={ITEM}>
          {S.changes.sideBySide}
        </ToggleGroupItem>
      </ToggleGroup>
      <Button type="button" variant="ghost" size="sm" className={ITEM} onClick={props.onCollapseAll}>
        {S.changes.collapseAll}
      </Button>
      <Button type="button" variant="ghost" size="sm" className={ITEM} onClick={props.onExpandAll}>
        {S.changes.expandAll}
      </Button>
      {/* Тумблер `ui/toggle` (раунд fix-live, D4): включённый несёт тот же признак, что выбранный
          пункт группы, — заливку `--primary`, к фону не ниже 3:1 (`styles/tokens.test.ts`). */}
      <Toggle size="sm" pressed={props.wrap} onPressedChange={props.onWrap} className={ITEM}>
        {S.changes.wrapLines}
      </Toggle>
      {props.sendAll === undefined || props.sendAll === null ? null : (
        // Не сжимается: на узкой панели кнопка уезжает на следующую строку целиком, а не обрезается.
        <div className="shrink-0">
          <SendMenu
            entry={props.sendAll.entry}
            defaultSessionId={props.sendAll.defaultSessionId}
            label={S.notes.sendAllUnsent}
            disabled={props.sendAll.disabled}
            onSend={props.sendAll.onSend}
          />
        </div>
      )}
      <ToggleGroup
        type="single"
        size="sm"
        className="ml-auto"
        value={props.listMode}
        onValueChange={(value) => (value === 'list' || value === 'tree' ? props.onListMode(value) : undefined)}
      >
        <ToggleGroupItem value="list" className={ITEM}>
          {S.changes.list}
        </ToggleGroupItem>
        <ToggleGroupItem value="tree" className={ITEM}>
          {S.changes.tree}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
