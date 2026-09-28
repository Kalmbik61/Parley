/**
 * Баннер отказа `works.list` (раунд lane-r5): хост не отдал снимок работ — например, первое чтение
 * работ на его старте упало на битом `works-index.json` (причина `works-unreadable`). Без баннера
 * человек видел бы пустой сайдбар без объяснений. Текст — по причине и коду, не текст хоста
 * (тот русский и идёт только в консоль, `store/works.ts`). Прячется сам, когда ошибки нет.
 */

import { HOST_ERROR_REASONS } from '@harnas/protocol';
import { S, errorText } from '../../shared/strings.js';
import { useWorksStore } from '../store/works.js';

export function WorksErrorBanner(): JSX.Element | null {
  const error = useWorksStore((state) => state.error);
  if (error === null) return null;
  const text = error.reason === HOST_ERROR_REASONS.worksUnreadable ? S.works.unreadable : errorText(error.code, S.errors.actions.loadWorkspaces);
  return (
    <div role="alert" className="border-b border-border bg-card px-3 py-2 text-sm text-destructive">
      {text}
    </div>
  );
}
