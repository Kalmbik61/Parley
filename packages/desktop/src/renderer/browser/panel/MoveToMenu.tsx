/**
 * «Move to browser of…» в «⋯» вкладки браузера человека (спека браузера 3.10): подменю сессий и комнат работы — те же списки,
 * что в меню «To» (закрытая сессия и архивная комната не хозяева). Выбор переносит страницу вкладки в панель хозяина
 * (`actions.ts#moveTabToPanel`); меню само ничего не переносит. У страницы панели пункта нет: она уже в чьём-то браузере.
 */

import type { WindowWorkEntry } from '@parley/core';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { AgentIcon } from '../../components/AgentIcon.js';
import { useFeedAvailability } from '../../lib/feed-view.js';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../../ui/dropdown-menu.js';
import { targetOptions, type TargetOption } from '../context/targets.js';

export interface MoveToMenuProps {
  entry: WindowWorkEntry;
  onMove(owner: BrowserOwner): void;
}

export function MoveToMenu({ entry, onMove }: MoveToMenuProps): JSX.Element {
  const { sessions, rooms } = targetOptions(entry, useFeedAvailability());
  const item = (option: TargetOption): JSX.Element => (
    <DropdownMenuItem key={option.key} data-owner-key={option.key} title={option.title} onSelect={() => onMove(option.target)} className="gap-2 text-xs">
      {option.provider === null ? null : <AgentIcon provider={option.provider} />}
      <span className="min-w-0 flex-1 truncate">{option.title}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={sessions.length === 0 && rooms.length === 0} data-testid="browser-move-to" className="text-xs">
        {S.browser.panel.moveTo}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-h-80 w-72 max-w-[calc(100vw-32px)] overflow-y-auto">
          {sessions.length === 0 ? null : (
            <>
              <DropdownMenuLabel className="text-xs">{S.browser.target.sessions}</DropdownMenuLabel>
              {sessions.map(item)}
            </>
          )}
          {sessions.length > 0 && rooms.length > 0 ? <DropdownMenuSeparator /> : null}
          {rooms.length === 0 ? null : (
            <>
              <DropdownMenuLabel className="text-xs">{S.browser.target.rooms}</DropdownMenuLabel>
              {rooms.map(item)}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
