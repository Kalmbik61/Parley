import type { KimiControl } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';

export function KimiTerminalControl({ control, error, onChange }: {
  control: KimiControl | undefined;
  error: string | null;
  onChange(target: 'terminal' | 'chat'): void;
}): JSX.Element {
  const copy = S.chat.kimiNative;
  const owner = control?.owner;
  const running = owner === 'terminal';
  const canReturn = owner === 'exited' || owner === 'stopped';
  return (
    <section aria-label={copy.title} className="mx-6 mt-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium" role="status">{owner === 'switching' ? copy.switching : running ? copy.inControl : canReturn ? copy.exited : copy.title}</div>
        <p className="m-0 text-xs text-muted-foreground">{running ? copy.exitFirst : canReturn ? copy.restore : copy.takeoverHelp}</p>
        {owner === 'stopped' && control?.detail !== undefined ? <p className="m-0 text-xs">{control.detail}</p> : null}
        {error === null ? null : <p role="alert" className="m-0 mt-1 text-xs text-[var(--status-warning-text)]">{error}</p>}
      </div>
      {canReturn ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onChange('terminal')}>{copy.reopen}</Button>
          <Button size="sm" onClick={() => onChange('chat')}>{copy.return}</Button>
        </div>
      ) : owner === 'chat' ? (
        <Button size="sm" disabled={!(control?.owner === 'chat' && control.canTakeover)} onClick={() => onChange('terminal')}>{copy.takeover}</Button>
      ) : null}
    </section>
  );
}
