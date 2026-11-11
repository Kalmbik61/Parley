/**
 * Строка состояния CLI в Settings → Providers (спека 2026-11-02, раздел 6, P1; спека 2026-11-11, §4.4): всегда видна у
 * установленного CLI — «Up to date · checked 14:05», «0.162.0 → 0.166.0 · [Update] · Skip this version», «skipped ·
 * [Update anyway]», «Could not check (offline)», у ручного способа — команда и Copy. У каждого состояния [Check now]
 * (`providers.checkUpdates`). Данные — `providers.list` (`cli`, у старого хоста — `update`), действия —
 * `providers.update`, `providers.skipUpdate`; новый снимок приходит событием `providers.changed`. Работающие сессии хост
 * не трогает: итог несёт `runningSessions`. Отсутствующий CLI рисует карточка (`ProviderCard`), не эта строка.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Result } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import type { ProviderInfo } from '../../store/providers.js';
import { manualUpdateCommand } from './provider-install.js';

type Done = Extract<Result<'providers.update'>, { state: 'done' }>;
type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'busy' } | { kind: 'done'; result: Done } | { kind: 'error'; message: string };

const BUTTON = 'inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 hover:bg-foreground/7 disabled:opacity-50';

/** «14:05» в местном времени; пусто, если время не разобрать. */
function clock(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ProviderUpdateRow({ provider, onReload }: { provider: ProviderInfo; onReload: () => Promise<void> }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cli = provider.cli ?? null;
  const update = provider.update ?? null;
  const state = cli?.state ?? (update !== null ? 'available' : null);
  const installed = provider.version ?? cli?.installed ?? null;
  // Без снимка `cli` (прежний хост) строка живёт по `update`; отсутствующий CLI — дело карточки.
  const shown = state !== null && state !== 'missing' && (cli === null || installed !== null || update !== null);
  if (!shown && phase.kind === 'idle') return null;
  const name = providerName(provider.id, provider.label);
  const running = phase.kind === 'running';
  const latest = cli?.latest ?? update?.latest ?? null;
  const method = cli?.method ?? update?.method ?? null;
  const manual = manualUpdateCommand(provider.id, method);

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
  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    try {
      await window.parley.call('providers.checkUpdates', { provider: provider.id });
      await onReload();
    } catch (error: unknown) {
      setCheckError(errorText(decodeIpcError(error).code, S.errors.actions.checkProviderUpdates));
    } finally {
      setChecking(false);
    }
  };
  const copy = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // Буфер недоступен: команда остаётся на экране, её можно выделить.
    }
  };

  const L = S.providerUpdate;
  const result = phase.kind === 'done' ? phase.result : null;
  const at = clock(cli?.checkedAt ?? update?.checkedAt);
  // The last check failed: the cached version is not verified now, so the failure shows whatever the state is.
  const failed = cli !== null && cli.lastError != null;
  const lastSuccess = clock(cli?.lastSuccessAt);
  const versionText = <span className="font-mono text-[12px]">{installed ?? '?'}</span>;
  return (
    <div data-provider-update={provider.id} data-cli-state={state ?? undefined} className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px]">
      {shown && result === null ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {state === 'available' || state === 'skipped' ? (
            <span>
              {name} {versionText} {L.arrow} <span className="font-mono text-[12px]">{latest ?? '?'}</span>
            </span>
          ) : (
            <span>
              {name} {versionText}
            </span>
          )}
          {state === 'up-to-date' && !failed ? <span className="text-neutral-600">· {L.upToDate}</span> : null}
          {state === 'unknown' || failed ? <span data-check-failed className="text-neutral-600">· {L.couldNotCheck(cli?.lastError ?? null)}</span> : null}
          {failed && lastSuccess !== null ? <span className="text-neutral-600">· {L.lastSuccess(lastSuccess)}</span> : null}
          {state === 'skipped' ? <span className="text-neutral-600">· {L.skipped}</span> : null}
          {state === 'available' && method !== null && method !== 'unknown' ? <span className="text-neutral-600">· {method}</span> : null}
          {(state === 'available' || state === 'skipped') && manual !== null ? (
            <>
              <span className="text-neutral-600">· {L.manualUpdate}</span>
              <code data-update-manual className="select-all font-mono text-[12px]">{manual}</code>
              <button type="button" data-update-copy className={BUTTON} onClick={() => void copy(manual)}>
                {copied ? L.copied : L.copy}
              </button>
            </>
          ) : null}
          {(state === 'available' || state === 'skipped') && manual === null ? (
            <button type="button" data-update-action disabled={running || checking} onClick={() => void run()} className={BUTTON}>
              {running ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
              {running ? L.updating : state === 'skipped' ? L.updateAnyway : L.update}
            </button>
          ) : null}
          {state === 'available' && manual === null ? (
            <button type="button" data-update-skip disabled={running} onClick={() => void skip()} className="text-neutral-600 underline-offset-2 hover:underline disabled:opacity-50">
              {L.skip}
            </button>
          ) : null}
          {at !== null && ((state === 'up-to-date' && !failed) || state === 'unknown') ? <span className="text-neutral-600">· {L.checked(at)}</span> : null}
          {cli !== null ? (
            <button type="button" data-check-now aria-busy={checking} disabled={running || checking} onClick={() => void checkNow()} className={BUTTON}>
              {checking ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
              {checking ? L.checking : L.checkNow}
            </button>
          ) : null}
        </div>
      ) : null}
      {checkError !== null ? <p role="alert">{checkError}</p> : null}
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
