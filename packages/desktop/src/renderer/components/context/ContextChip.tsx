/**
 * Чип заполненности контекста одной сессии (спека 2026-10-15, 3.2 и 3.4): процент с цветом по порогу, состояние
 * сжатия, по клику — поповер с числами и формой сжатия. Спящая сессия и хост без поля `context` — чипа нет; хост без
 * `sessions.compact` — поповер без формы. Используется на карточке участника комнаты и в тулбаре Chat.
 */

import type { ContextFill } from '@parley/core';
import type { CompactionPhase, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { cn } from '../../lib/cn.js';
import { contextChipText, contextLevel, contextNumbers, contextTooltip, LEVEL_CLASS } from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { cancelCompaction, compactSession } from './compact-actions.js';
import { CompactForm } from './CompactForm.js';

export interface ContextChipProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  provider: string;
  /** Подпись в поповере и тостах: `S01 backend`. */
  label: string;
  /** Процесс запущен (`lifecycle === 'active'`). */
  running: boolean;
  /** `undefined` — хост не сообщает заполненность (старее). */
  context: ContextFill | null | undefined;
  compaction: CompactionPhase | null | undefined;
  defaultInstructions: string;
  testId: string;
  className?: string;
}

export function ContextChip({
  bridge,
  sessionRef,
  provider,
  label,
  running,
  context,
  compaction,
  defaultInstructions,
  testId,
  className,
}: ContextChipProps): JSX.Element | null {
  const supported = useHostSupports('sessions.compact');
  if (!running || (context === undefined && compaction === undefined)) return null;
  const fill = context ?? null;
  const phase = compaction ?? null;
  const level = fill === null || phase !== null ? 'normal' : contextLevel(fill.usedPercent);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid={testId}
          data-level={level}
          title={contextTooltip(fill, phase)}
          className={cn('shrink-0 font-mono tabular-nums', LEVEL_CLASS[level], className)}
        >
          {contextChipText(fill, phase)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid={`${testId}-popover`} className="w-[min(360px,calc(100vw-32px))] p-3 text-xs">
        <p className="m-0 mb-1 truncate font-medium" title={label}>
          {S.context.title(label)}
        </p>
        <p className="m-0 mb-2 text-muted-foreground">{contextNumbers(fill)}</p>
        {supported ? (
          <CompactForm
            provider={provider}
            defaultText={defaultInstructions}
            phase={phase}
            onCompact={(instructions) => void compactSession(bridge, sessionRef, label, instructions)}
            onCancel={() => void cancelCompaction(bridge, sessionRef)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
