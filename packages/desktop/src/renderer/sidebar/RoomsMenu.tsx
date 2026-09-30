/**
 * Меню комнат работы по `#` или `#N` карточки (кусок 3.4, спека 6.3): все комнаты работы со
 * счётчиками непрочитанного человеком (`roomUnreadForHuman`); выбор открывает вкладку
 * комнаты. Открытое меню держит порядок сайдбара, как и меню карточки.
 */

import { useState, type ReactNode } from 'react';
import type { WorkMap } from '@parley/core';
import { S } from '../../shared/strings.js';
import { roomUnreadForHuman } from '../attention/derive.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { useSidebarHold } from './use-sidebar-hold.js';

export interface RoomsMenuProps {
  map: WorkMap;
  onOpenRoom(roomId: string): void;
  /** Кнопка `#`/`#N` — триггер меню. */
  children: ReactNode;
}

export function RoomsMenu({ map, onOpenRoom, children }: RoomsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  useSidebarHold(`rooms-menu ${map.work.id}`, open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64">
        {map.rooms.map((room) => {
          const unread = roomUnreadForHuman(map, room.id);
          return (
            <DropdownMenuItem key={room.id} data-room-id={room.id} onSelect={() => onOpenRoom(room.id)}>
              <span className="min-w-0 flex-1 truncate">{room.title === '' ? S.rooms.fallbackTitle : room.title}</span>
              {unread > 0 ? <span className="shrink-0 tabular-nums text-muted-foreground">{unread}</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
