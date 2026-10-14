/**
 * Значок расхода токенов сессии в панели Chat (спека расхода токенов, 3.4): вся жизнь сессии — `LiveMetrics.usage`, ничего
 * нового не считается. Хост без `usage` — цифры строки сайдбара (`tokensIn`/`tokensOut`). Токены, а не деньги и не лимит.
 */

import { Fragment } from 'react';
import type { LiveMetrics } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { knownTokens, usageCells, usageChipText, usageMarks } from '../lib/usage-format.js';
import { Button } from '../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';

const U = S.usage;

export function SessionUsageChip({ metrics }: { metrics: LiveMetrics }): JSX.Element {
  const usage = metrics.usage;
  const text =
    usage !== undefined
      ? usageChipText(usage)
      : metrics.tokensIn === null && metrics.tokensOut === null
        ? '—'
        : `↑${knownTokens(metrics.tokensIn ?? 0)} ↓${knownTokens(metrics.tokensOut ?? 0)}`;
  const cells = usage !== undefined ? usageCells(usage) : [knownTokens(metrics.tokensIn), knownTokens(metrics.tokensOut), '?', '?'];
  const marks = usage === undefined ? [] : usageMarks(usage);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline" data-testid="chat-usage-chip" title={U.title} className="shrink-0 font-mono tabular-nums">
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="chat-usage-popover" className="w-[min(320px,calc(100vw-32px))] p-3 text-xs">
        <p className="mb-2 font-medium">
          {U.title} · {U.sessionScope}
        </p>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
          {U.columns.map((column, index) => (
            <Fragment key={column}>
              <dt className="text-muted-foreground">{column}</dt>
              <dd className="m-0 text-right font-mono tabular-nums">{cells[index]}</dd>
            </Fragment>
          ))}
        </dl>
        {marks.length > 0 ? <p className="mt-2 text-muted-foreground">{marks.join(' · ')}</p> : null}
        <p className="mt-2 text-muted-foreground">{U.footnote}</p>
      </PopoverContent>
    </Popover>
  );
}
