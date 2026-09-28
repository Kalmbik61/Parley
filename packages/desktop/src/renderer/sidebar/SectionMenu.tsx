/**
 * Меню «⋯» заголовка секции сайдбара (кусок 3.4, спека 6.1): переключатель «Show done» —
 * `ui.json.showDoneWorks`. Открытое меню держит порядок сайдбара.
 */

import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useUiStore } from '../store/ui.js';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { useSidebarHold } from './use-sidebar-hold.js';

export interface SectionMenuProps {
  /** Ключ секции — `pinned` или `projectPath`: у каждого меню свой держатель порядка. */
  sectionKey: string;
}

export function SectionMenu({ sectionKey }: SectionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  useSidebarHold(`section-menu ${sectionKey}`, open);
  const showDone = useUiStore((state) => state.ui.showDoneWorks);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={S.sidebar.sectionMenu}
          title={S.sidebar.sectionMenu}
          // Клик по «⋯» — не клик по заголовку: группа не должна свернуться.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded text-work-sidebar-muted-foreground',
            'hover:bg-work-sidebar-accent hover:text-work-sidebar-foreground',
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={showDone}
          onCheckedChange={(checked) => useUiStore.getState().patchUi({ showDoneWorks: checked })}
        >
          {S.sidebar.showDone}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
