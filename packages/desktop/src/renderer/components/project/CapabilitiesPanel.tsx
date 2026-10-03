import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { CapabilityPresence, CapabilityProvider, CapabilitySnapshot } from '@parley/protocol';
import { Button } from '../../ui/button.js';
import { S } from '../../../shared/strings.js';

const PROVIDERS: readonly CapabilityProvider[] = ['claude', 'codex'];
const NAMES = { claude: 'Claude', codex: 'Codex' };

export interface McpPanelActions {
  supports: { remove: boolean; check: boolean }; busy: boolean;
  remove(provider: CapabilityProvider, presence: CapabilityPresence, revision: number): void;
  check(provider: CapabilityProvider, presence: CapabilityPresence, revision: number): void;
}
function Presence({ presence, provider, actions, onRemove, revision }: { presence: CapabilityPresence; provider: CapabilityProvider;
  actions?: McpPanelActions; onRemove(): void; revision: number }): JSX.Element {
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs break-words">
      <div className="flex flex-wrap items-center gap-1">
        {presence.scope === 'builtin' && <Lock className="size-3 shrink-0" aria-label={S.projectPanel.builtin} />}
        <span>{presence.scope === null ? S.projectPanel.unknownScope : S.projectPanel.scopes[presence.scope]}</span>
        <span>· {presence.installed ? S.projectPanel.installed : S.projectPanel.notInstalled}</span>
      </div>
      <div>{presence.enabled === null ? S.projectPanel.unknownPolicy : presence.enabled ? S.projectPanel.enabled : S.projectPanel.disabled}</div>
      <div>{presence.mcpActions && presence.status === 'ok' ? S.mcpActions.connected : S.projectPanel.statuses[presence.status]}</div>
      {presence.modelAvailable !== null && <div>{presence.modelAvailable ? S.projectPanel.available : S.projectPanel.hidden}</div>}
      {presence.unavailableReason !== null && <p>{S.projectPanel.reasons[presence.unavailableReason]}</p>}
      {presence.description !== null && <p className="whitespace-pre-wrap">{presence.description}</p>}
      {presence.summary !== null && <p>{presence.summary}</p>}
      {presence.source !== null && <p className="break-all text-muted-foreground">{presence.source}</p>}
      {presence.documentPath !== null && presence.documentPath !== presence.source && <p className="break-all text-muted-foreground">{presence.documentPath}</p>}
      {presence.sharedFrom !== undefined && <p>{S.projectPanel.shared(NAMES[presence.sharedFrom])}</p>}
      {actions && <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={actions.busy || !actions.supports.remove || presence.mcpActions?.remove.allowed !== true}
          title={presence.mcpActions?.remove.reason ? S.mcpActions.codes[presence.mcpActions.remove.reason] : undefined} onClick={onRemove}>{S.mcpActions.remove}</Button>
        <Button type="button" variant="outline" disabled={actions.busy || !actions.supports.check || presence.mcpActions?.check.allowed !== true}
          title={presence.mcpActions?.check.reason ? S.mcpActions.codes[presence.mcpActions.check.reason] : undefined}
          onClick={() => actions.check(provider, presence, revision)}>{S.mcpActions.check}</Button>
      </div>}
      {actions && presence.mcpActions?.check.reason === 'native-only' && <p>{S.mcpActions.nativeRecovery}</p>}
    </div>
  );
}

/** Render the complete safe inventory; this view never applies the model search filter. */
export function CapabilitiesPanel({ snapshot, actions }: { snapshot: CapabilitySnapshot | null; actions?: McpPanelActions }): JSX.Element {
  const [pending, setPending] = useState<{ provider: CapabilityProvider; presence: CapabilityPresence; revision: number; projectPath: string } | null>(null);
  return (
    <div className="space-y-4">
      {pending && snapshot?.projectPath === pending.projectPath && actions && <div role="group" aria-label={S.mcpActions.removePrompt} className="space-y-2 rounded-md border border-border p-3">
        <p>{S.mcpActions.removePrompt}</p><p className="text-xs">{NAMES[pending.provider]} · {pending.presence.scope === null ? S.projectPanel.unknownScope : S.projectPanel.scopes[pending.presence.scope]}</p>
        {pending.revision !== snapshot.revision && <p role="status">{S.mcpActions.codes.stale}</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={actions.busy || pending.revision !== snapshot.revision} onClick={() => {
          actions.remove(pending.provider, pending.presence, pending.revision); setPending(null);
        }}>{S.mcpActions.confirmRemove}</Button><Button type="button" variant="outline" onClick={() => setPending(null)}>{S.mcpActions.cancel}</Button></div>
      </div>}
      <div className="grid grid-cols-2 gap-3">
        {PROVIDERS.map(provider => {
          const column = snapshot?.columns[provider];
          const phase = column?.phase ?? 'loading';
          const text = phase === 'loading' ? S.projectPanel.loading : phase === 'ready' ? S.projectPanel.ready
            : phase === 'partial' ? S.projectPanel.partial : phase === 'error' ? S.projectPanel.error : S.projectPanel.notConfirmed;
          return <section key={provider} aria-label={NAMES[provider]} className="min-w-0 space-y-1">
            <h3 className="font-medium">{NAMES[provider]}</h3>
            <p role="status" className="text-xs text-muted-foreground">{text}</p>
            {column?.diagnostics.map((diagnostic, index) => <p key={index} className="text-xs break-words">
              {S.projectPanel.diagnostics[diagnostic.code]}{diagnostic.count === undefined ? '' : ` (${diagnostic.count})`}
            </p>)}
          </section>;
        })}
      </div>
      {(['skill', 'mcp', 'plugin'] as const).map(kind => {
        const rows = snapshot?.rows.filter(row => row.kind === kind) ?? [];
        if (rows.length === 0) return null;
        return <section key={kind} className="space-y-2">
          <h3 className="font-medium">{S.projectPanel.kinds[kind]}</h3>
          <table className="w-full table-fixed border-separate border-spacing-1 text-left text-sm">
            <thead><tr><th className="w-1/4">{S.projectPanel.kinds[kind]}</th>{PROVIDERS.map(provider => <th key={provider}>{NAMES[provider]}</th>)}</tr></thead>
            <tbody>{rows.map(row => <tr key={row.id}>
              <th scope="row" className="align-top font-medium break-all">
                {row.name}{row.separateCopies && <p className="mt-1 text-xs font-normal">{S.projectPanel.separateCopies}</p>}
              </th>
              {PROVIDERS.map(provider => <td key={provider} className="space-y-2 align-top">
                {row[provider].map(presence => <Presence key={presence.id} presence={presence} provider={provider} revision={snapshot!.revision}
                  {...(row.kind === 'mcp' && actions ? { actions } : {})}
                  onRemove={() => setPending({ provider, presence, revision: snapshot!.revision, projectPath: snapshot!.projectPath })} />)}
                {row[provider].length === 0 && <span className="text-xs text-muted-foreground">{
                  snapshot?.columns[provider].phase === 'loading' ? S.projectPanel.loading
                    : snapshot?.columns[provider].phase === 'ready' ? S.projectPanel.notFound : S.projectPanel.notConfirmed
                }</span>}
              </td>)}
            </tr>)}</tbody>
          </table>
        </section>;
      })}
      {snapshot?.rows.length === 0 && PROVIDERS.every(provider => snapshot.columns[provider].phase === 'ready') && <p>{S.projectPanel.empty}</p>}
    </div>
  );
}
