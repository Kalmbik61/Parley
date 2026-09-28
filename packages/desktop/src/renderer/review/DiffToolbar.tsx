/**
 * Панель вкладки диффа (кусок 8.3, спека 11.3): «Inline / Side by side» (пишется в `ui.json`),
 * «Collapse all», «Expand all», «Wrap lines» и вид списка файлов — список или дерево.
 * Состояние держит `DiffTab`: панель только сообщает о нажатиях. «Send all unsent ▾» (8.4b) —
 * неотправленные неустаревшие заметки вкладки; в режиме коммита её нет.
 */

import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { Button } from '../ui/button.js';
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

// Без переноса: «Side by side» на узкой панели ломался в три строки; панель прокручивается.
const ITEM = 'h-6 whitespace-nowrap px-2 text-xs';

export function DiffToolbar(props: DiffToolbarProps): JSX.Element {
  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-2">
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={props.wrap}
        className={cn(ITEM, props.wrap && 'bg-accent text-accent-foreground')}
        onClick={() => props.onWrap(!props.wrap)}
      >
        {S.changes.wrapLines}
      </Button>
      {props.sendAll === undefined || props.sendAll === null ? null : (
        // Не сжимается: узкая панель прокручивается (`overflow-x-auto`), а не наезжает на «List».
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
