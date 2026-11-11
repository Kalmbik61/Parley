/**
 * Установка CLI из карточки провайдера (спека 2026-11-11, §4.2, §4.4): [Install…] → подтверждение с точной командой,
 * адресом источника и словами о доверии → `providers.install` → ход, ошибка (хвост вывода и команда для ручного запуска)
 * или итог (версия, `pathNote`). Хост не полагается на подтверждение: argv константный. Кнопка видна, только пока CLI
 * отсутствует (`missing`), а ход и итог остаются на месте и после того, как список перечитан.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Result } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { INSTALL_CONFIRM, type InstallableId } from './provider-install.js';

type Done = Extract<Result<'providers.install'>, { state: 'done' }>;
type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'busy' } | { kind: 'done'; result: Done } | { kind: 'error'; message: string };

export function ProviderInstall({
  id,
  name,
  missing,
  disabled = false,
  onReload,
}: {
  id: InstallableId;
  name: string;
  /** CLI не найден: только тогда рисуется кнопка. */
  missing: boolean;
  disabled?: boolean;
  onReload: () => Promise<void>;
}): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const plan = INSTALL_CONFIRM[id];
  const L = S.providerCard;
  const C = L.installConfirm;
  const running = phase.kind === 'running';

  const install = async (): Promise<void> => {
    setPhase({ kind: 'running' });
    try {
      const result = await window.parley.call('providers.install', { provider: id });
      setPhase(result.state === 'busy' ? { kind: 'busy' } : { kind: 'done', result });
      void onReload().catch(() => {});
    } catch (error: unknown) {
      // Только код: текст ошибки может содержать локальный путь.
      setPhase({ kind: 'error', message: errorText(decodeIpcError(error).code, S.errors.actions.installProvider) });
    }
  };

  if (!missing && phase.kind === 'idle') return null;
  const result = phase.kind === 'done' ? phase.result : null;
  return (
    <div data-provider-install={id} className="space-y-2">
      {missing && !running ? (
        <Button type="button" size="xs" disabled={disabled} onClick={() => setConfirming(true)}>
          {L.installAction}
        </Button>
      ) : null}
      {running ? (
        <p role="status" data-install-running className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 aria-hidden size={13} className="animate-spin motion-reduce:animate-none" />
          {L.installing(name)}
        </p>
      ) : null}
      {phase.kind === 'busy' ? <p role="status" className="text-xs text-muted-foreground">{L.installBusy}</p> : null}
      {phase.kind === 'error' ? <p role="alert" className="text-xs text-destructive">{phase.message}</p> : null}
      {result !== null ? (
        <div role="status" className="space-y-1.5 text-xs">
          <p data-install-result={result.ok ? 'ok' : 'failed'}>{result.ok ? L.installed(name, result.version) : result.error ?? L.installFailed}</p>
          {result.ok && result.pathNote !== undefined ? <p data-install-path-note className="text-muted-foreground">{result.pathNote}</p> : null}
          {result.smoke !== undefined && !result.smoke.ok ? <p role="alert">{L.installSmokeFailed}</p> : null}
          {!result.ok && result.output !== '' ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 font-mono text-[11px]">{result.output}</pre>
          ) : null}
          {!result.ok && result.manualCommand !== undefined ? (
            <p>
              {L.installManual} <code className="select-all font-mono text-[12px]">{result.manualCommand}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="w-[30rem] max-w-[calc(100vw-2rem)]">
          <DialogTitle>{C.title(name)}</DialogTitle>
          <DialogDescription>{C.trust}</DialogDescription>
          <div className="space-y-2 text-xs">
            <p className="text-muted-foreground">{C.command}</p>
            <code data-install-command className="block break-all rounded-lg bg-muted p-2">{plan.command}</code>
            <p className="text-muted-foreground">{C.source}</p>
            <code data-install-source className="block break-all rounded-lg bg-muted p-2">{plan.source}</code>
            {plan.profile ? <p data-install-profile>{C.profile}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                {S.common.cancel}
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                setConfirming(false);
                void install();
              }}
            >
              {C.accept}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
