/**
 * Меню цели «To» в строке вкладки браузера (спека браузера 4.1, 4.5): куда ложатся «Add to chat», Select и аннотации.
 * Разделы «Sessions» (ярлык, значок провайдера, вид chat или terminal) и «Rooms». Длинные имена режутся многоточием и
 * целиком видны в подсказке; в узкой строке кнопка сжимается до «To: S0…». Меню ничего не шлёт: выбор только меняет
 * цель вкладки в раскладке. У сессии без процесса (`sleeping`, `pending`) вместо вида стоит пометка «not running», как в
 * `SendMenu`; выбрать такую сессию можно — вложение дождётся её в поле.
 */

import { Check, ChevronDown } from 'lucide-react';
import type { WorkEntry } from '@parley/core';
import type { BrowserTarget } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { AgentIcon } from '../../components/AgentIcon.js';
import { cn } from '../../lib/cn.js';
import { useFeedAvailability } from '../../lib/feed-view.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu.js';
import { targetKey, targetName, targetOptions, type TargetOption } from './targets.js';

export interface TargetMenuProps {
  entry: WorkEntry;
  /** Цель вкладки (из раскладки или умолчание); `null` — целиться некуда. */
  target: BrowserTarget | null;
  onChange(target: BrowserTarget): void;
}

/** Подпись справа в пункте: «not running» у сессии без процесса, иначе вид доставки (chat или terminal); комнате — нет. */
function noteOf(entry: WorkEntry, option: TargetOption): string | null {
  const picked = option.target;
  if (picked.kind === 'session') {
    const lifecycle = entry.map.sessions.find((session) => session.id === picked.sessionId)?.lifecycle;
    if (lifecycle === 'sleeping' || lifecycle === 'pending') return S.notes.notRunning;
  }
  if (option.mode === null) return null;
  return option.mode === 'chat' ? S.browser.target.chat : S.browser.target.terminal;
}

export function TargetMenu({ entry, target, onChange }: TargetMenuProps): JSX.Element {
  const availability = useFeedAvailability();
  const { sessions, rooms } = targetOptions(entry, availability);
  const current = target === null ? null : targetKey(target);
  const label = target === null ? S.browser.target.noTarget : S.browser.target.button(targetName(entry, target));

  const item = (option: TargetOption): JSX.Element => {
    const note = noteOf(entry, option);
    return (
      <DropdownMenuItem
        key={option.key}
        data-target-key={option.key}
        {...(option.key === current ? { 'data-current': '' } : {})}
        title={option.title}
        onSelect={() => onChange(option.target)}
        className="gap-2 text-xs"
      >
        <Check className={cn('size-3 shrink-0', option.key === current ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
        {option.provider === null ? null : <AgentIcon provider={option.provider} />}
        <span className="min-w-0 flex-1 truncate">{option.title}</span>
        {note === null ? null : <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={S.browser.target.choose}
          disabled={sessions.length === 0 && rooms.length === 0}
          className="flex h-6 min-w-[2.75rem] max-w-40 shrink items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <span data-target-label="" className="min-w-0 truncate">
            {label}
          </span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 max-w-[calc(100vw-32px)] overflow-y-auto">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
