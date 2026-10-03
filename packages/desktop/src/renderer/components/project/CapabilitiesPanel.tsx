import { Lock } from 'lucide-react';
import type { CapabilityPresence, CapabilityProvider, CapabilitySnapshot } from '@parley/protocol';
import { S } from '../../../shared/strings.js';

const PROVIDERS: readonly CapabilityProvider[] = ['claude', 'codex'];
const NAMES = { claude: 'Claude', codex: 'Codex' };

function Presence({ presence }: { presence: CapabilityPresence }): JSX.Element {
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs break-words">
      <div className="flex flex-wrap items-center gap-1">
        {presence.scope === 'builtin' && <Lock className="size-3 shrink-0" aria-label={S.projectPanel.builtin} />}
        <span>{presence.scope === null ? S.projectPanel.unknownScope : S.projectPanel.scopes[presence.scope]}</span>
        <span>· {presence.installed ? S.projectPanel.installed : S.projectPanel.notInstalled}</span>
      </div>
      <div>{presence.enabled === null ? S.projectPanel.unknownPolicy : presence.enabled ? S.projectPanel.enabled : S.projectPanel.disabled}</div>
      <div>{S.projectPanel.statuses[presence.status]}</div>
      {presence.modelAvailable !== null && <div>{presence.modelAvailable ? S.projectPanel.available : S.projectPanel.hidden}</div>}
      {presence.unavailableReason !== null && <p>{S.projectPanel.reasons[presence.unavailableReason]}</p>}
      {presence.description !== null && <p className="whitespace-pre-wrap">{presence.description}</p>}
      {presence.summary !== null && <p>{presence.summary}</p>}
      {presence.source !== null && <p className="break-all text-muted-foreground">{presence.source}</p>}
      {presence.documentPath !== null && presence.documentPath !== presence.source && <p className="break-all text-muted-foreground">{presence.documentPath}</p>}
      {presence.sharedFrom !== undefined && <p>{S.projectPanel.shared(NAMES[presence.sharedFrom])}</p>}
    </div>
  );
}

/** Render the complete safe inventory; this view never applies the model search filter. */
export function CapabilitiesPanel({ snapshot }: { snapshot: CapabilitySnapshot | null }): JSX.Element {
  return (
    <div className="space-y-4">
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
                {row[provider].map(presence => <Presence key={presence.id} presence={presence} />)}
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
