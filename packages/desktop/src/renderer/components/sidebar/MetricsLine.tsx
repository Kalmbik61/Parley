/** Строка метрик под выбранной сессией (`lib/metrics-line.ts`). */

import type { LiveMetrics } from '@harnas/protocol';
import { formatMetricsLine } from '../../lib/metrics-line.js';

export interface MetricsLineProps {
  metrics: LiveMetrics | null;
}

export function MetricsLine({ metrics }: MetricsLineProps): JSX.Element | null {
  if (metrics === null) return null;
  return <div className="truncate pl-6 text-[11px] text-muted-foreground">{formatMetricsLine(metrics)}</div>;
}
