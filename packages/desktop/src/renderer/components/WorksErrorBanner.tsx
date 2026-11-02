/**
 * Баннер отказа `works.list` (раунд lane-r5): хост не отдал снимок работ — например, первое чтение
 * работ на его старте упало на битом `works-index.json` (причина `works-unreadable`). Без баннера
 * человек видел бы пустой сайдбар без объяснений. Текст — по причине и коду, не текст хоста
 * (тот идёт только в консоль, `store/works.ts`). Прячется сам, когда ошибки нет.
 */

import { HOST_ERROR_REASONS } from '@parley/protocol';
import { S, errorText } from '../../shared/strings.js';
import { useWorksStore } from '../store/works.js';

export function WorksErrorBanner(): JSX.Element | null {
  const error = useWorksStore((state) => state.error);
  const sync = useWorksStore((state) => state.syncStatus);
  const pending = useWorksStore((state) => state.mailRepairPending);
  const mailFailed = useWorksStore((state) => state.mailRepairFailed);
  const retry = useWorksStore((state) => state.retrySync);
  if (sync !== null && (sync.state !== 'current' || pending > 0)) {
    const failed = sync.state === 'stale' || sync.state === 'error' || (pending > 0 && mailFailed);
    const text = sync.state === 'loading' ? S.works.syncLoading(sync.rows)
      : sync.state === 'catching-up' ? S.works.syncUpdating
      : sync.state === 'stale' ? S.works.syncStale
      : sync.state === 'error' ? S.works.syncError : mailFailed ? S.works.mailRepairFailed : S.works.mailRepair;
    return <div role={failed ? 'alert' : 'status'} className="border-b border-border bg-card px-3 py-2 text-sm">
      {text}
      {failed && (sync.state !== 'error' || sync.retryable) ? <button type="button" className="ml-2 underline" onClick={retry}>{S.common.retry}</button> : null}
    </div>;
  }
  if (error === null) return null;
  const text =
    error.reason === HOST_ERROR_REASONS.worksUnreadable
      ? S.works.unreadable
      : error.reason === HOST_ERROR_REASONS.snapshotTooLarge
        ? S.works.tooLarge
        : errorText(error.code, S.errors.actions.loadWorkspaces);
  return (
    <div role="alert" className="border-b border-border bg-card px-3 py-2 text-sm text-destructive">
      {text}
    </div>
  );
}
