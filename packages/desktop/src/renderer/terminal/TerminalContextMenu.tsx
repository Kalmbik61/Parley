/**
 * Меню терминала по правой кнопке (кусок 5.3, спека 8.4): Copy (только при выделении) ·
 * Paste · Select all · Clear · Find · Split right · Split down.
 *
 * «Paste» — `app.paste()`: main зовёт `webContents.paste()`, и срабатывает то же событие
 * paste, что у ⌘V, — чистка вставки (5.1) и картинка из буфера (5.4) идут одним путём.
 * `document.execCommand('paste')` в песочнице окна не работает. «Clear» чистит только
 * экран xterm: агенту ничего не уходит, скроллбэк хоста остаётся.
 */

import { useState, type ReactNode } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu.js';

export interface TerminalContextMenuProps {
  bridge: HarnasBridge;
  terminal: Terminal | null;
  onClear(): void;
  onFind(): void;
  onSplit(direction: 'right' | 'down'): void;
  children: ReactNode;
}

export function TerminalContextMenu({ bridge, terminal, onClear, onFind, onSplit, children }: TerminalContextMenuProps): JSX.Element {
  // Выделение читается в момент открытия: пока меню открыто, вывод агента его не снимет из пунктов.
  const [hasSelection, setHasSelection] = useState(false);

  return (
    <ContextMenu onOpenChange={(open) => open && setHasSelection(terminal?.hasSelection() ?? false)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="terminal-context-menu">
        {hasSelection ? (
          <ContextMenuItem
            onSelect={() => {
              const text = terminal?.getSelection() ?? '';
              navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[harnas] clipboard', error));
            }}
          >
            {S.common.copy}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={() => {
            // Фокус до вставки: событие paste получает сфокусированный элемент — поле xterm.
            terminal?.focus();
            bridge.app.paste();
          }}
        >
          {S.terminal.paste}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => terminal?.selectAll()}>{S.terminal.selectAll}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClear}>{S.terminal.clear}</ContextMenuItem>
        <ContextMenuItem onSelect={onFind}>{S.actions.find}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onSplit('right')}>{S.actions.splitRight}</ContextMenuItem>
        <ContextMenuItem onSelect={() => onSplit('down')}>{S.actions.splitDown}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
