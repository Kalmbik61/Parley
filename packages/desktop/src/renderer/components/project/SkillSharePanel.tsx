import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { capabilitySkillResult } from '@parley/protocol';
import type { CapabilityPresence, CapabilityProvider, CapabilitySkillResult, CapabilitySnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';

const P = S.capabilities.skillShare;
const PROVIDERS = ['claude', 'codex'] as const;
const NAMES = { claude: 'Claude', codex: 'Codex' };
const codeText = (code: CapabilitySkillResult['code']): string => P.codes[code];
/** Explicit manual sharing uses only the current host-owned presence binding. Inventory rendering never writes. */
export function SkillSharePanel({ snapshot, bridge, renderPresence }: {
  snapshot: CapabilitySnapshot; bridge: ParleyBridge;
  renderPresence(presence: CapabilityPresence, provider: CapabilityProvider): ReactNode;
}): JSX.Element {
  const status = useHostStore(state => state.status); const connection = useHostStore(state => state.connections);
  const methods = hostMethods(status);
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const generation = useRef(0);
  const identity = `${snapshot.projectPath}\0${snapshot.revision}\0${connection}\0${status.state}\0${[...methods].sort().join(',')}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  useEffect(() => { ++generation.current; setBusy(false); setResult(null); return () => { ++generation.current; }; }, [identity, bridge]);
  useEffect(() => { setAttempted(false); }, [snapshot.projectPath, connection, bridge]);
  const active = (captured: string, token: number): boolean => currentIdentity.current === captured && generation.current === token;
  const run = async (kind: 'share' | 'unshare', provider: CapabilityProvider, presence: CapabilityPresence): Promise<void> => {
    const method = kind === 'share' ? 'capabilities.skills.share' : 'capabilities.skills.unshare';
    if (busy || !methods.has(method) || presence.skillActions?.[kind].allowed !== true || !['user', 'project'].includes(presence.scope ?? '')) return;
    const captured = identity; const token = generation.current; setBusy(true); setResult(null); setAttempted(true);
    try {
      const parsed = capabilitySkillResult.safeParse(await bridge.call(method, { projectPath: snapshot.projectPath, provider, revision: snapshot.revision, presenceId: presence.id }));
      if (active(captured, token)) setResult(codeText(parsed.success ? parsed.data.code : 'unverified'));
    } catch { if (active(captured, token)) setResult(codeText('io-error')); }
    finally { if (active(captured, token)) setBusy(false); }
  };
  const rows = snapshot.rows.filter(row => row.kind === 'skill');
  if (!rows.length) return <></>;
  return <section className="space-y-2" aria-label={P.title}>
    <h3 className="font-medium">{P.title}</h3>
    {!methods.has('capabilities.skills.share') && !methods.has('capabilities.skills.unshare') && <p role="status">{P.unsupportedHost}</p>}
    {busy && <p role="status">{P.queued}</p>}{result && <p role="status">{result}</p>}
    {attempted && <p className="text-xs text-muted-foreground">{P.appliesToNew}</p>}
    <table className="w-full table-fixed border-separate border-spacing-1 text-left text-sm">
      <thead><tr><th className="w-1/4">{P.title}</th>{PROVIDERS.map(provider => <th key={provider}>{NAMES[provider]}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <th scope="row" className="align-top font-medium break-all">{row.name}{row.separateCopies && <p className="mt-1 text-xs font-normal">{S.projectPanel.separateCopies}</p>}</th>
        {PROVIDERS.map(provider => <td key={provider} className="space-y-2 align-top">{row[provider].map(presence => {
          const other = provider === 'claude' ? 'codex' : 'claude';
          const ordinary = !row.separateCopies && ['user', 'project'].includes(presence.scope ?? '');
          return <div key={presence.id} className="space-y-1">{renderPresence(presence, provider)}
            <div className="flex flex-wrap gap-2">{(['share', 'unshare'] as const).map(kind => <Button key={kind} type="button" variant="outline"
              disabled={busy || !ordinary || !methods.has(`capabilities.skills.${kind}`) || presence.skillActions?.[kind].allowed !== true}
              title={kind === 'unshare' && presence.skillActions?.unshare.allowed ? P.cleanup : presence.skillActions?.[kind].reason ? S.mcpActions.codes[presence.skillActions[kind].reason!] : undefined}
              onClick={() => { void run(kind, provider, presence); }}>{kind === 'share' ? P.share(NAMES[other]) : P.unshare(NAMES[other])}</Button>)}</div>
          </div>;
        })}{row[provider].length === 0 && <span className="text-xs text-muted-foreground">{snapshot.columns[provider].phase === 'loading' ? S.projectPanel.loading : snapshot.columns[provider].phase === 'ready' ? S.projectPanel.notFound : S.projectPanel.notConfirmed}</span>}</td>)}
      </tr>)}</tbody>
    </table>
    {rows.some(row => PROVIDERS.some(provider => row[provider].some(presence => presence.scope === 'project'))) && <p className="text-xs text-muted-foreground">{P.projectHint}</p>}
    {rows.some(row => PROVIDERS.some(provider => row[provider].some(presence => presence.scope === 'user'))) && <p className="text-xs text-muted-foreground">{P.userHint}</p>}
  </section>;
}
