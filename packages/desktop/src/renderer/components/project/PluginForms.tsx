import { useId, useState } from 'react';
import type { CapabilityActionAvailability, CapabilityPluginSummary, CapabilityProvider } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';

const P = S.capabilities.plugins;
export type PluginScope = 'user' | 'project' | 'local';
export function PluginComposition({ composition }: { composition: CapabilityPluginSummary['composition'] }): JSX.Element {
  return <dl className="grid grid-cols-2 gap-x-3 text-xs">{(['skills', 'agents', 'hooks', 'mcp', 'tokenEstimate'] as const).map(key => <div key={key}>
    <dt>{key === 'tokenEstimate' ? P.tokens : P[key]}</dt><dd>{composition[key] === null ? P.unknown : composition[key]}</dd>
  </div>)}</dl>;
}
/** Explicit human input; paths stay inside the request and are never taken from a safe display name. */
export function PluginScopeForm({ provider, entry, scopes, busy, submit, onCancel }: {
  provider: CapabilityProvider; entry: CapabilityPluginSummary | null;
  scopes: Record<PluginScope, CapabilityActionAvailability>; busy: boolean;
  submit(scope: PluginScope, localPath: string): Promise<void>; onCancel(): void;
}): JSX.Element {
  const id = useId(); const [scope, setScope] = useState<PluginScope | ''>(''); const [localPath, setLocalPath] = useState('');
  const [invalid, setInvalid] = useState(false);
  return <form aria-label={entry ? P.confirmInstall : P.confirmMarketplace} className="space-y-2 rounded-md border border-border p-3" onSubmit={event => {
    event.preventDefault();
    if (!scope || !scopes[scope].allowed || provider === 'codex' && scope !== 'user' || entry === null && (!localPath.trim() || localPath.includes('\0') || localPath.length > 8192 || new TextDecoder().decode(new TextEncoder().encode(localPath)) !== localPath)) {
      setInvalid(true); return;
    }
    setInvalid(false); void submit(scope, localPath);
  }}>
    <p>{provider === 'claude' ? 'Claude' : 'Codex'}</p>
    {entry && <><p>{entry.name} · {entry.pluginId}</p>{entry.description !== null && <p className="whitespace-pre-wrap">{entry.description}</p>}<PluginComposition composition={entry.composition} /></>}
    {!entry && <><label htmlFor={`${id}-path`}>{P.localPath}</label><Input id={`${id}-path`} value={localPath} disabled={busy} onChange={event => setLocalPath(event.target.value)} /></>}
    <label htmlFor={`${id}-scope`}>{P.scope}</label>
    <select id={`${id}-scope`} value={scope} disabled={busy} onChange={event => setScope(event.target.value as PluginScope | '')}>
      <option value="">{P.chooseScope}</option>{(['user', 'project', 'local'] as const).map(value => <option key={value} value={value} disabled={!scopes[value].allowed || provider === 'codex' && value !== 'user'}>{S.projectPanel.scopes[value]}</option>)}
    </select>
    {invalid && <p role="alert">{P.inputFailed}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={busy || !scope || !scopes[scope].allowed}>{entry ? P.confirmInstall : P.confirmMarketplace}</Button><Button type="button" variant="outline" onClick={onCancel}>{P.cancel}</Button></div>
  </form>;
}
