/**
 * Переименование работы на месте (кусок 3.4, спека 6.4): поле встаёт вместо заголовка
 * карточки, название выделено целиком. Enter или потеря фокуса с изменённым названием —
 * `works.rename`; Esc или потеря фокуса без изменений — отмена. Ошибка хоста — тост, поле
 * закрывается, и карточка снова показывает прежнее название из снимка.
 *
 * Пока поле открыто, порядок сайдбара держится: пересортировка сдвинула бы карточку, а
 * виртуализация перемонтировала бы поле.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { workKey } from '../lib/tree-order.js';
import { useSidebarHold } from './use-sidebar-hold.js';

export interface InlineRenameProps {
  entry: WorkEntry;
  bridge: HarnasBridge;
  /** Поле закрывается: сохранено, отменено или хост отказал. */
  onDone(): void;
}

export function InlineRename({ entry, bridge, onDone }: InlineRenameProps): JSX.Element {
  const { projectPath, map } = entry;
  const title = map.work.title;
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(title);
  // Один исход на поле: Enter и следом потеря фокуса не шлют второй вызов.
  const settled = useRef(false);
  useSidebarHold(`rename ${workKey(projectPath, map.work.id)}`, true);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (!save || value === title || value.trim() === '') {
      onDone();
      return;
    }
    bridge
      .call('works.rename', { projectPath, workId: map.work.id, title: value })
      .then(onDone, (error: unknown) => {
        console.warn('[harnas] works.rename', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.renameWorkspace));
        onDone();
      });
  };

  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={S.sidebar.renameField}
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
      className="h-5 min-w-0 flex-1 rounded-sm border border-work-sidebar-border bg-background px-1 text-[13px] leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-work-sidebar-ring"
    />
  );
}
