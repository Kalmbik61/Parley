/**
 * Переименование работы на месте (кусок 3.4, спека 6.4): поле встаёт вместо заголовка
 * карточки, название выделено целиком. Enter или потеря фокуса с изменённым названием —
 * `works.rename`; Esc или потеря фокуса без изменений — отмена. Ошибка хоста — тост, поле
 * закрывается, и карточка снова показывает прежнее название из снимка.
 *
 * То же поле переименовывает комнату в её строке (`RoomInlineRename`, «Rename» меню строки комнаты) —
 * `rooms.rename`. Пустое название не уходит хосту ни там, ни там: остаётся прежнее.
 *
 * Пока поле открыто, порядок сайдбара держится: пересортировка сдвинула бы карточку, а
 * виртуализация перемонтировала бы поле.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Room, WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { workTitleText } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { useSidebarHold } from './use-sidebar-hold.js';

export interface InlineRenameProps {
  entry: WorkEntry;
  bridge: ParleyBridge;
  /** Поле закрывается: сохранено, отменено или хост отказал. */
  onDone(): void;
}

export function InlineRename({ entry, bridge, onDone }: InlineRenameProps): JSX.Element {
  const { projectPath, map } = entry;
  return (
    <RenameField
      // Поле открывается на том, что видно на карточке: безымянная работа — «Untitled workspace».
      title={workTitleText(map.work.title)}
      hold={`rename ${workKey(projectPath, map.work.id)}`}
      label={S.sidebar.renameField}
      method="works.rename"
      action={S.errors.actions.renameWorkspace}
      save={(title) => bridge.call('works.rename', { projectPath, workId: map.work.id, title })}
      className="h-5 text-[13px] leading-5"
      onDone={onDone}
    />
  );
}

export interface RoomInlineRenameProps {
  projectPath: string;
  workId: string;
  room: Room;
  bridge: ParleyBridge;
  onDone(): void;
}

/** Поле на месте названия в строке комнаты (`RoomRow`): шапка строки — 18px и 12px, поле той же высоты. */
export function RoomInlineRename({ projectPath, workId, room, bridge, onDone }: RoomInlineRenameProps): JSX.Element {
  return (
    <RenameField
      title={room.title === '' ? S.rooms.fallbackTitle : room.title}
      hold={`rename ${workKey(projectPath, workId)} ${room.id}`}
      label={S.sidebar.roomRenameField}
      method="rooms.rename"
      action={S.errors.actions.renameRoom}
      save={(title) => bridge.call('rooms.rename', { projectPath, workId, roomId: room.id, title })}
      className="h-[18px] text-xs leading-[18px]"
      onDone={onDone}
    />
  );
}

interface RenameFieldProps {
  /** Что видно на месте поля — с ним поле и открывается. */
  title: string;
  /** Ключ удержания порядка сайдбара (`useSidebarHold`). */
  hold: string;
  label: string;
  /** Метод хоста — для строки консоли при отказе. */
  method: string;
  /** Действие тоста «Couldn't <action>: …». */
  action: string;
  save(title: string): Promise<unknown>;
  /** Высота и шрифт — по месту: заголовок карточки или шапка строки комнаты. */
  className: string;
  onDone(): void;
}

function RenameField({ title, hold, label, method, action, save, className, onDone }: RenameFieldProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(title);
  // Один исход на поле: Enter и следом потеря фокуса не шлют второй вызов.
  const settled = useRef(false);
  useSidebarHold(hold, true);

  useLayoutEffect(() => {
    const take = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    take();
    // Поле открывает пункт контекстного меню, и монтируется оно, пока меню ещё открыто: его ловушка фокуса (Radix
    // FocusScope, `focusout`) возвращает фокус пункту, тот уходит вместе с меню, и фокус оказывается на `body` — поле
    // без фокуса не закрывалось ни Esc, ни уходом (снято в живом окне 2026-10-07). Ловушку снимает очистка эффектов
    // меню в том же такте, поэтому второй заход — следующей задачей.
    const retry = setTimeout(() => {
      if (document.activeElement !== inputRef.current) take();
    }, 0);
    return () => clearTimeout(retry);
  }, []);

  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (!commit || value === title || value.trim() === '') {
      onDone();
      return;
    }
    save(value).then(onDone, (error: unknown) => {
      console.warn(`[parley] ${method}`, error);
      toast(errorText(decodeIpcError(error).code, action));
      onDone();
    });
  };

  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={label}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // Клавиши поля — его: ни стрелки сайдбара, ни Enter карточки их не получают.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        'min-w-0 flex-1 rounded-sm border border-work-sidebar-border bg-background px-1 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-work-sidebar-ring',
        className,
      )}
    />
  );
}
