/**
 * Сегмент «Agents» правой группы строки статуса (спека сна агентов и ёмкости, 4.5): «Agents 17/18 · 3 queued · memory warn».
 * Полный текст виден от 1280 px, от 960 до 1280 — короткая форма «17/18», уже 960 — одна иконка (имена провайдеров
 * в строке статуса важнее); полный текст всегда в `title` и `aria-label`. Тон
 * `accent-700` (он лежит на кнопке и красит иконку) — давление `warn`/`critical`, непустая очередь или живых больше потолка. Снимка нет (хост прежней сборки
 * или связь не поднялась) — сегмента нет. По клику — поповер: числа, память, порог сна и очередь запусков по порядку снимка.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { queuedWord } from '@parley/core/session-state';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { projectName } from '../lib/project-name.js';
import { sessionLabelFor } from '../lib/participant.js';
import { useCapacityStore } from '../store/capacity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { SEGMENT_BUTTON } from './segment.js';

export function CapacitySegment(): JSX.Element | null {
  const snapshot = useCapacityStore((state) => state.snapshot);
  const entries = useWorksStore((state) => state.entries);
  const [open, setOpen] = useState(false);
  if (snapshot === null) return null;

  const { machine, queue } = snapshot;
  const text = S.capacity.segment(machine);
  const warning = machine.pressure === 'warn' || machine.pressure === 'critical' || machine.queued > 0 ||
    (machine.limit !== null && machine.live > machine.limit);
  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-capacity-segment title={text} aria-label={text}
          className={cn(SEGMENT_BUTTON, 'flex items-center gap-[7px]', warning && 'text-accent-700')}>
          <Bot aria-hidden size={14} />
          <span className="hidden min-[1280px]:inline">{text}</span>
          <span className="hidden min-[960px]:inline min-[1280px]:hidden">{S.capacity.segmentShort(machine)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={S.capacity.title} side="top" align="end" className="flex w-[min(360px,calc(100vw-24px))] flex-col gap-1 p-3">
        <p className="text-xs font-medium text-foreground">{S.capacity.title}</p>
        <p className="text-xs text-foreground">{S.capacity.live(machine)}</p>
        <p className="text-xs text-foreground">{S.capacity.memory(machine)}</p>
        <p className="text-xs text-foreground">{S.capacity.sleep(machine.sleepMinutes)}</p>
        {queue.length === 0 ? (
          <p className="pt-1 text-[11px] text-neutral-700">{S.capacity.noQueue}</p>
        ) : (
          <>
            <p className="pt-1 text-xs font-medium text-foreground">{S.capacity.waiting(queue.length)}</p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {queue.map(({ ref, queued }) => (
                <li key={`${ref.projectPath}\0${ref.workId}\0${ref.sessionId}`} className="flex flex-col text-[11px] leading-snug">
                  <span className="truncate text-foreground">
                    {sessionLabelFor(entries, ref) ?? ref.sessionId}
                    <span className="text-neutral-700"> · {projectName(ref.projectPath)}</span>
                  </span>
                  <span className="truncate text-neutral-700">
                    {queuedWord(queued)} · {S.capacity.waited(now - Date.parse(queued.at))}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <button type="button"
          className="mt-1 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/8"
          onClick={() => {
            setOpen(false);
            useUiStore.getState().openSettingsDialog('agents');
          }}>
          {S.capacity.openLimits}
        </button>
      </PopoverContent>
    </Popover>
  );
}
