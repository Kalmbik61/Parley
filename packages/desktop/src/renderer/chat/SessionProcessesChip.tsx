/**
 * Чип «N shell» в тулбаре сессии и список процессов её PTY (план shell-processes, этап C). Рядом с «N agents
 * running»: нет данных, хост без `processes.subscribe`, `available: false` или ноль процессов — чипа нет.
 * Пока список раскрыт, чип остаётся (иначе фокус клавиатуры потерялся бы вместе с кнопкой), а список
 * показывает загрузку, пустое или недоступное состояние. В строке — только безопасное имя (`ucomm`), время
 * работы и метрики; ни `title`, ни подсказок с чем-либо ещё. У Codex список помечен приблизительным.
 */

import { useState } from 'react';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { useSessionProcesses } from '../terminal/use-session-processes.js';

export interface SessionProcessesChipProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  /** Вкладка на экране и сессия живая — только тогда есть подписка. */
  active: boolean;
}

export function SessionProcessesChip({ bridge, sessionRef, active }: SessionProcessesChipProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { phase, snapshot } = useSessionProcesses(bridge, sessionRef, active);
  const count = snapshot?.available === true ? snapshot.processes.length : 0;
  if (!open && count === 0) return null;

  const rows = snapshot?.available === true ? snapshot.processes : [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline" data-testid="chat-processes" aria-label={S.chat.processes.chipLabel(count)} className="shrink-0">
          {S.chat.processes.chip(count)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="processes-popover" aria-label={S.chat.processes.title} className="w-72 p-2">
        {phase === 'loading' ? (
          <p data-testid="processes-loading" className="px-1 py-1 text-xs text-muted-foreground">{S.chat.processes.loading}</p>
        ) : phase !== 'ready' || snapshot?.available !== true ? (
          <p data-testid="processes-unavailable" className="px-1 py-1 text-xs text-muted-foreground">{S.chat.processes.unavailable}</p>
        ) : rows.length === 0 ? (
          <p data-testid="processes-empty" className="px-1 py-1 text-xs text-muted-foreground">{S.chat.processes.empty}</p>
        ) : (
          <ul aria-label={S.chat.processes.list} data-testid="processes-list" className="max-h-64 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.pid} data-testid="processes-row" className="flex min-w-0 items-baseline gap-2 px-1 py-0.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{row.name}</span>
                <span className="shrink-0 text-muted-foreground">{row.elapsed}</span>
                {row.cpuPct === null ? null : <span className="shrink-0 text-muted-foreground">{S.chat.processes.cpu(row.cpuPct)}</span>}
                {row.rssKb === null ? null : <span className="shrink-0 text-muted-foreground">{S.chat.processes.memory(row.rssKb)}</span>}
              </li>
            ))}
          </ul>
        )}
        {snapshot?.approximate === true ? (
          <p data-testid="processes-approximate" className="mt-1 border-t border-border px-1 pt-1 text-xs text-muted-foreground">
            {S.chat.processes.approximate}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
