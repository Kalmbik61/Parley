/**
 * Меню терминала по правой кнопке (кусок 5.3, спека 8.4): Copy (только при выделении) ·
 * Paste · Select all · Clear · Find · Split right · Split down.
 *
 * «Paste» — `app.paste()`: main зовёт `webContents.paste()`, и срабатывает то же событие
 * paste, что у ⌘V, — чистка вставки (5.1) и картинка из буфера (5.4) идут одним путём.
 * `document.execCommand('paste')` в песочнице окна не работает. «Clear» чистит только
 * экран xterm: агенту ничего не уходит, скроллбэк хоста остаётся.
 */

import { useRef, useState, type ReactNode } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu.js';

export interface TerminalContextMenuProps {
  bridge: ParleyBridge;
  terminal: Terminal | null;
  onClear(): void;
  onFind(): void;
  onSplit(direction: 'right' | 'down'): void;
  children: ReactNode;
}

export function TerminalContextMenu({ bridge, terminal, onClear, onFind, onSplit, children }: TerminalContextMenuProps): JSX.Element {
  // Выделение читается в момент открытия: пока меню открыто, вывод агента его не снимет из пунктов.
  const [hasSelection, setHasSelection] = useState(false);
  // Пункт выполняется, когда меню закроется. Пока оно открыто, FocusScope Radix держит фокус
  // внутри меню, а после размонтирования в setTimeout(0) возвращает его туда, где он был до
  // правого клика: фокус, поставленный прямо в onSelect, был бы отнят, и вставка от
  // межпроцессного app.paste() ушла бы мимо терминала. onCloseAutoFocus гасит этот возврат и
  // выполняет пункт — фокус ставит он сам. null — меню закрыто без выбора (Esc, клик мимо):
  // тогда возврат фокуса как у Radix.
  const pending = useRef<(() => void) | null>(null);
  const afterClose = (action: () => void) => () => {
    pending.current = action;
  };

  return (
    <ContextMenu onOpenChange={(open) => open && setHasSelection(terminal?.hasSelection() ?? false)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        data-testid="terminal-context-menu"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (action === null) return;
          event.preventDefault();
          action();
        }}
      >
        {hasSelection ? (
          <ContextMenuItem
            onSelect={afterClose(() => {
              const text = terminal?.getSelection() ?? '';
              navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[parley] clipboard', error));
            })}
          >
            {S.common.copy}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={afterClose(() => {
            // Фокус до вставки: событие paste получает сфокусированный элемент — поле xterm.
            terminal?.focus();
            bridge.app.paste();
          })}
        >
          {S.terminal.paste}
        </ContextMenuItem>
        <ContextMenuItem onSelect={afterClose(() => terminal?.selectAll())}>{S.terminal.selectAll}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={afterClose(onClear)}>{S.terminal.clear}</ContextMenuItem>
        {/* Find: openSearch сам ставит фокус в поле поиска. */}
        <ContextMenuItem onSelect={afterClose(onFind)}>{S.actions.find}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={afterClose(() => onSplit('right'))}>{S.actions.splitRight}</ContextMenuItem>
        <ContextMenuItem onSelect={afterClose(() => onSplit('down'))}>{S.actions.splitDown}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
