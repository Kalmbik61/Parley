/**
 * Строка обновления CLI в Settings → Providers (спека 2026-11-02, раздел 6, P1):
 * «Codex 0.162.0 → 0.166.0 · standalone · [Update] · Skip this version». Данные — `providers.list` (`update`, `version`),
 * действия — `providers.update` и `providers.skipUpdate`; новый снимок приходит событием `providers.changed`. Работающие
 * сессии хост не трогает: итог несёт `runningSessions`, и строка об этом предупреждает. Без `update` и без итога
 * ничего не рисуется.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Result } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import type { ProviderInfo } from '../../store/providers.js';

type Done = Extract<Result<'providers.update'>, { state: 'done' }>;
type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'busy' } | { kind: 'done'; result: Done } | { kind: 'error'; message: string };

export function ProviderUpdateRow({ provider, onReload }: { provider: ProviderInfo; onReload: () => Promise<void> }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const update = provider.update ?? null;
  if (update === null && phase.kind === 'idle') return null;
  const name = providerName(provider.id, provider.label);
  const running = phase.kind === 'running';

  const reload = (): void => {
    void onReload().catch(() => {});
  };
  const run = async (): Promise<void> => {
    setPhase({ kind: 'running' });
    try {
      const result = await window.parley.call('providers.update', { provider: provider.id });
      setPhase(result.state === 'busy' ? { kind: 'busy' } : { kind: 'done', result });
      reload();
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: errorText(decodeIpcError(error).code, S.errors.actions.updateProvider) });
    }
  };
  const skip = async (): Promise<void> => {
    try {
      await window.parley.call('providers.skipUpdate', { provider: provider.id });
      setPhase({ kind: 'idle' });
      reload();
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: errorText(decodeIpcError(error).code, S.errors.actions.skipProviderUpdate) });
    }
  };

  const L = S.providerUpdate;
  const result = phase.kind === 'done' ? phase.result : null;
  return (
    <div data-provider-update={provider.id} className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px]">
      {update !== null && result === null ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span>
            {name} <span className="font-mono text-[12px]">{provider.version ?? '?'}</span> {L.arrow}{' '}
            <span className="font-mono text-[12px]">{update.latest}</span>
          </span>
          {update.method !== 'unknown' ? <span className="text-neutral-600">· {update.method}</span> : null}
          <button
            type="button"
            data-update-action
            disabled={running}
            onClick={() => void run()}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 hover:bg-foreground/7 disabled:opacity-50"
          >
            {running ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
            {running ? L.updating : L.update}
          </button>
          <button type="button" data-update-skip disabled={running} onClick={() => void skip()} className="text-neutral-600 underline-offset-2 hover:underline disabled:opacity-50">
            {L.skip}
          </button>
        </div>
      ) : null}
      {phase.kind === 'busy' ? <p role="status">{L.busy}</p> : null}
      {phase.kind === 'error' ? <p role="alert">{phase.message}</p> : null}
      {result !== null ? (
        <div role="status" className="flex flex-col gap-1.5">
          <p data-update-result={result.ok ? 'ok' : 'failed'}>{result.ok ? L.updated(result.to ?? '') : L.failed}</p>
          {result.smoke !== undefined && !result.smoke.ok ? <p role="alert">{L.smokeFailed}</p> : null}
          {!result.ok && result.output !== '' ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 font-mono text-[11px]">{result.output}</pre>
          ) : null}
          {!result.ok && result.manualCommand !== undefined ? (
            <p>
              {L.manual} <code className="select-all font-mono text-[12px]">{result.manualCommand}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {result !== null && result.runningSessions > 0 ? <p className="text-neutral-600">{L.sessions(result.runningSessions, name, result.from)}</p> : null}
    </div>
  );
}
