import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { capabilityPluginCatalogResponse, capabilityPluginDetailsResponse, capabilityPluginResult } from '@parley/protocol';
import type { CapabilityActionAvailability, CapabilityPluginCatalogResponse, CapabilityPluginSummary, CapabilityPresence, CapabilityProvider, CapabilitySnapshot, CapabilityPluginResult } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { PluginComposition, PluginScopeForm } from './PluginForms.js';
import type { PluginScope } from './PluginForms.js';

const P = S.capabilities.plugins;
const PROVIDERS = ['claude', 'codex'] as const;
const NAMES = { claude: 'Claude', codex: 'Codex' };
const denied: CapabilityActionAvailability = { allowed: false, reason: 'unverified' };
const CODES: Record<CapabilityPluginResult['code'], string> = { ...S.mcpActions.codes, ...P.codes };
const codeText = (code: CapabilityPluginResult['code']): string => CODES[code];
type Form = { provider: CapabilityProvider; entry: CapabilityPluginSummary | null };
/** Catalog and opaque action requests use the same bridge/context as the parent snapshot. */
export function PluginPanel({ snapshot, bridge, renderPresence }: {
  snapshot: CapabilitySnapshot; bridge: ParleyBridge;
  renderPresence(presence: CapabilityPresence, provider: CapabilityProvider): ReactNode;
}): JSX.Element {
  const status = useHostStore(state => state.status); const connection = useHostStore(state => state.connections);
  const methods = hostMethods(status);
  const [catalogs, setCatalogs] = useState<Partial<Record<CapabilityProvider, CapabilityPluginCatalogResponse>>>({});
  const [details, setDetails] = useState<CapabilityPluginSummary | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pending, setPending] = useState<{ provider: CapabilityProvider; presence: CapabilityPresence; name: string } | null>(null);
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null); const [attempted, setAttempted] = useState(false);
  const generation = useRef(0);
  const identity = `${snapshot.projectPath}\0${snapshot.revision}\0${connection}\0${status.state}\0${[...methods].sort().join(',')}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  useEffect(() => {
    ++generation.current; setCatalogs({}); setDetails(null); setForm(null); setPending(null); setBusy(false); setResult(null);
    return () => { ++generation.current; };
  }, [identity, bridge]);
  useEffect(() => { setAttempted(false); }, [snapshot.projectPath, connection, bridge]);
  const active = (captured: string, token: number): boolean => currentIdentity.current === captured && generation.current === token;
  const run = async (request: () => Promise<unknown>): Promise<void> => {
    if (busy) return; const captured = identity; const token = generation.current;
    setBusy(true); setAttempted(true); setResult(null);
    try {
      const parsed = capabilityPluginResult.safeParse(await request());
      if (active(captured, token)) { setResult(codeText(parsed.success ? parsed.data.code : 'invalid-output')); if (parsed.success && parsed.data.outcome === 'ok') { setForm(null); setPending(null); setDetails(null); setCatalogs({}); } }
    } catch { if (active(captured, token)) setResult(codeText('cli-error')); }
    finally { if (active(captured, token)) setBusy(false); }
  };
  const loadCatalog = async (provider: CapabilityProvider): Promise<void> => {
    if (busy || !methods.has('capabilities.plugins.available') || snapshot.columns[provider].pluginCatalog?.allowed !== true) return;
    const captured = identity; const token = generation.current; setBusy(true); setResult(null);
    try {
      const parsed = capabilityPluginCatalogResponse.safeParse(await bridge.call('capabilities.plugins.available', { projectPath: snapshot.projectPath, revision: snapshot.revision, provider }));
      if (!active(captured, token)) return;
      if (!parsed.success || parsed.data.provider !== provider || parsed.data.revision !== snapshot.revision) { setResult(codeText('invalid-output')); return; }
      setCatalogs(previous => ({ ...previous, [provider]: parsed.data }));
      if (parsed.data.reason) setResult(codeText(parsed.data.reason));
    } catch { if (active(captured, token)) setResult(codeText('cli-error')); }
    finally { if (active(captured, token)) setBusy(false); }
  };
  const loadDetails = async (provider: CapabilityProvider, presence: CapabilityPresence): Promise<void> => {
    if (busy || !methods.has('capabilities.plugins.details') || presence.pluginActions?.details.allowed !== true) return;
    const captured = identity; const token = generation.current; setBusy(true); setResult(null); setDetails(null);
    try {
      const parsed = capabilityPluginDetailsResponse.safeParse(await bridge.call('capabilities.plugins.details', { projectPath: snapshot.projectPath, revision: snapshot.revision, provider, target: { kind: 'installed', presenceId: presence.id } }));
      if (!active(captured, token)) return;
      if (!parsed.success || parsed.data.revision !== snapshot.revision || parsed.data.entry && (parsed.data.entry.id !== presence.id || parsed.data.entry.provider !== provider || parsed.data.entry.kind !== 'installed')) { setResult(codeText('invalid-output')); return; }
      setDetails(parsed.data.entry); if (parsed.data.reason) setResult(codeText(parsed.data.reason));
    } catch { if (active(captured, token)) setResult(codeText('cli-error')); }
    finally { if (active(captured, token)) setBusy(false); }
  };
  const installedAction = (provider: CapabilityProvider, presence: CapabilityPresence, kind: 'enable' | 'disable'): void => {
    if (busy || presence.pluginActions?.[kind].allowed !== true || !methods.has(`capabilities.plugins.${kind}`)) return;
    void run(() => bridge.call(kind === 'enable' ? 'capabilities.plugins.enable' : 'capabilities.plugins.disable', { projectPath: snapshot.projectPath, revision: snapshot.revision, provider, presenceId: presence.id }));
  };
  const submit = async (scope: PluginScope, localPath: string): Promise<void> => {
    if (!form || busy) return;
    const base = { projectPath: snapshot.projectPath, revision: snapshot.revision, provider: form.provider };
    if (form.entry) {
      if (!methods.has('capabilities.plugins.install') || !form.entry.actions.install.allowed) return;
      await run(() => bridge.call('capabilities.plugins.install', { ...base, catalogId: form.entry!.id, scope }));
    } else {
      if (!methods.has('capabilities.plugins.addMarketplace') || snapshot.columns[form.provider].pluginMarketplaceAdd?.[scope].allowed !== true) return;
      await run(() => bridge.call('capabilities.plugins.addMarketplace', { ...base, scope, source: { kind: 'local', path: localPath } }));
    }
  };
  return <section className="space-y-3" aria-label={P.title}>
    <h3 className="font-medium">{P.title}</h3>
    {busy && <p role="status">{P.queued}</p>}{result && <p role="status">{result}</p>}
    {attempted && <p className="text-xs text-muted-foreground">{P.appliesToNew}</p>}
    {details && <section aria-label={P.details} className="rounded-md border border-border p-3"><p>{details.name} · {details.pluginId}</p>{details.description !== null && <p className="whitespace-pre-wrap">{details.description}</p>}<PluginComposition composition={details.composition} /></section>}
    {form && <PluginScopeForm key={`${identity}:${form.provider}:${form.entry?.id ?? 'marketplace'}`} provider={form.provider} entry={form.entry} busy={busy} scopes={form.entry ? {
      user: form.entry.actions.install, project: form.provider === 'claude' ? form.entry.actions.install : denied, local: form.provider === 'claude' ? form.entry.actions.install : denied,
    } : snapshot.columns[form.provider].pluginMarketplaceAdd ?? { user: denied, project: denied, local: denied }} submit={submit} onCancel={() => setForm(null)} />}
    {pending && <section role="group" aria-label={P.confirmUninstall} className="space-y-2 rounded-md border border-border p-3">
      <p>{P.dataLoss}</p><p>{pending.name}</p><p>{NAMES[pending.provider]} · {pending.presence.scope === null ? S.projectPanel.unknownScope : S.projectPanel.scopes[pending.presence.scope]}</p>
      <Button type="button" disabled={busy} onClick={() => {
        if (!methods.has('capabilities.plugins.uninstall') || pending.presence.pluginActions?.uninstall.allowed !== true) return;
        const selected=pending; void run(() => bridge.call('capabilities.plugins.uninstall', { projectPath:snapshot.projectPath,provider:selected.provider,revision:snapshot.revision,presenceId:selected.presence.id,confirmDataLoss:true }));
      }}>{P.confirmUninstall}</Button><Button type="button" variant="outline" onClick={() => setPending(null)}>{P.cancel}</Button>
    </section>}
    <div className="grid grid-cols-2 gap-3">{PROVIDERS.map(provider => {
      const column=snapshot.columns[provider];const catalog=catalogs[provider];const canMarket=Object.values(column.pluginMarketplaceAdd ?? {}).some(value => value.allowed);
      return <section key={provider} aria-label={`${NAMES[provider]} ${P.title}`} className="min-w-0 space-y-2">
        <h4 className="font-medium">{NAMES[provider]}</h4>
        <Button type="button" variant="outline" disabled={busy || !methods.has('capabilities.plugins.available') || column.pluginCatalog?.allowed !== true} title={column.pluginCatalog?.allowed ? undefined : codeText(column.pluginCatalog?.reason ?? 'unverified')} onClick={() => { void loadCatalog(provider); }}>{P.loadCatalog}</Button>
        <Button type="button" variant="outline" disabled={busy || !methods.has('capabilities.plugins.addMarketplace') || !canMarket} title={!canMarket ? codeText(Object.values(column.pluginMarketplaceAdd ?? {})[0]?.reason ?? 'unverified') : undefined} onClick={() => { setForm({provider,entry:null});setPending(null); }}>{P.addMarketplace}</Button>
        {!methods.has('capabilities.plugins.available') && <p>{P.unsupportedHost}</p>}
        {column.pluginCatalog?.allowed === false && <p>{codeText(column.pluginCatalog.reason ?? 'unverified')}</p>}
        <p className="text-xs">{provider === 'claude' ? P.claudeRecovery : P.codexRecovery}</p>
        {snapshot.rows.filter(row=>row.kind==='plugin').flatMap(row=>row[provider].map(presence=><div key={presence.id} className="space-y-2">
          <p>{row.name}{row.separateCopies && <span> · {S.projectPanel.separateCopies}</span>}</p>{renderPresence(presence,provider)}
          <div className="flex flex-wrap gap-2">{(['details','enable','disable','uninstall'] as const).map(kind=><Button key={kind} type="button" variant="outline" disabled={busy || !methods.has(`capabilities.plugins.${kind}`) || presence.pluginActions?.[kind].allowed !== true} title={presence.pluginActions?.[kind].allowed ? undefined : codeText(presence.pluginActions?.[kind].reason ?? 'unverified')} onClick={()=>{
            if(kind==='details')void loadDetails(provider,presence);else if(kind==='uninstall'){setPending({provider,presence,name:row.name});setForm(null);}else installedAction(provider,presence,kind);
          }}>{P[kind]}</Button>)}</div>
        </div>))}
        {catalog && <section aria-label={`${NAMES[provider]} ${P.available}`} className="space-y-2">
          <h4>{P.available}</h4>{catalog.partial && <p>{P.partial}</p>}
          <Input aria-label={P.search} value={query} onChange={event=>setQuery(event.target.value)} />
          {catalog.phase==='ready' && !catalog.partial && catalog.entries.filter(entry=>entry.kind==='available').length===0 && <p>{P.empty}</p>}
          {catalog.entries.filter(entry=>entry.kind==='available' && `${entry.name}\n${entry.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(entry=><article key={entry.id} className="space-y-1 rounded-md border border-border p-2">
            <p>{entry.name} · {entry.pluginId}</p>{entry.description!==null && <p className="whitespace-pre-wrap">{entry.description}</p>}<PluginComposition composition={entry.composition} />
            <Button type="button" disabled={busy || !methods.has('capabilities.plugins.install') || !entry.actions.install.allowed} title={entry.actions.install.allowed ? undefined : codeText(entry.actions.install.reason ?? 'unverified')} onClick={()=>{setForm({provider,entry});setPending(null);}}>{P.install}</Button>
            {!entry.actions.install.allowed && <p>{codeText(entry.actions.install.reason ?? 'unverified')}</p>}
          </article>)}
        </section>}
      </section>;
    })}</div>
  </section>;
}
