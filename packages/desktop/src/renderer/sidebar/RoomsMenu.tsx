/**
 * Меню комнат работы по `#` или `#N` карточки (кусок 3.4, спека 6.3): все комнаты работы со
 * счётчиками непрочитанного человеком (`roomUnreadForHuman`); выбор открывает вкладку
 * комнаты. Открытое меню держит порядок сайдбара, как и меню карточки.
 *
 * Если среди непрочитанного комнаты есть упоминание человека (`@human`, Parley 0.3.0), перед числом стоит `@`
 * акцентным цветом с подсказкой «Mentions you»: по комнате видно, что в ней зовут тебя, а не просто пишут.
 * Правило — `humanUnreadMentions` (`attention/derive.ts`), то же, что у «@you» в строке комнаты сайдбара и у
 * счётчика «для тебя». Архивные комнаты в меню не показываются (спека архива комнат, 5.3): они под ссылкой карточки.
 */

import { useState, type ReactNode } from 'react';
import type { WorkMap } from '@parley/core';
import { S } from '../../shared/strings.js';
import { humanUnreadMentions, roomUnreadForHuman } from '../attention/derive.js';
import { isRoomArchived } from '../lib/room-archive.js';
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
  const mentions = humanUnreadMentions(map);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64">
        {map.rooms.filter((room) => !isRoomArchived(room)).map((room) => {
          const unread = roomUnreadForHuman(map, room.id);
          const mentioned = mentions.some((message) => message.roomId === room.id);
          return (
            <DropdownMenuItem key={room.id} data-room-id={room.id} onSelect={() => onOpenRoom(room.id)}>
              <span className="min-w-0 flex-1 truncate">{room.title === '' ? S.rooms.fallbackTitle : room.title}</span>
              {unread > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 tabular-nums text-muted-foreground">
                  {mentioned ? (
                    <span
                      title={S.rooms.humanMentionTitle}
                      className="font-semibold text-accent-700"
                    >
                      @
                    </span>
                  ) : null}
                  {unread}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
