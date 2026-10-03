import { useEffect, useId, useRef, useState } from 'react';
import { capabilityMcpAdd, capabilityMcpInput } from '@parley/protocol';
import type { CapabilityActionResult, CapabilityMcpAdd, CapabilityMcpInput, CapabilityProvider, CapabilitySnapshot } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Textarea } from '../../ui/textarea.js';

interface JsonChoice { name: string | null; input: Extract<CapabilityMcpInput, { kind: 'json' }> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** User-authored README input only; no external config/body is fetched into the renderer. */
export function parseMcpReadmeJson(text: string): JsonChoice[] | null {
  if (new TextEncoder().encode(text).byteLength > 65_536) return null;
  try {
    const raw: unknown = JSON.parse(text); if (!object(raw)) return null;
    const entries: Array<[string | null, unknown]> = 'mcpServers' in raw
      ? Object.keys(raw).length === 1 && object(raw.mcpServers) ? Object.entries(raw.mcpServers) : [] : [[null, raw]];
    if (!entries.length || entries.length > 128) return null;
    const result: JsonChoice[] = [];
    for (const [name, server] of entries) {
      if (name !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(name)) return null;
      const parsed = capabilityMcpInput.safeParse({ kind: 'json', server });
      if (!parsed.success || parsed.data.kind !== 'json') return null;
      result.push({ name, input: parsed.data });
    }
    return result;
  } catch { return null; }
}
export interface McpFormProps {
  snapshot: CapabilitySnapshot;
  submit(requests: CapabilityMcpAdd[]): Promise<Array<{ provider: CapabilityProvider; result: CapabilityActionResult }>>;
  onCancel(): void;
}
export function McpForm({ snapshot, submit, onCancel }: McpFormProps): JSX.Element {
  const id = useId(); const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [name, setName] = useState(''); const [kind, setKind] = useState<'stdio' | 'http' | 'json'>('stdio');
  const [command, setCommand] = useState(''); const [args, setArgs] = useState(''); const [env, setEnv] = useState('');
  const [url, setUrl] = useState(''); const [headers, setHeaders] = useState(''); const [bearer, setBearer] = useState('');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [providers, setProviders] = useState({ claude: Object.values(snapshot.columns.claude.mcpAdd ?? {}).some(value => value.allowed), codex: snapshot.columns.codex.mcpAdd?.user.allowed === true });
  const [json, setJson] = useState(''); const [choices, setChoices] = useState<JsonChoice[] | null>(null); const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const [results, setResults] = useState<Array<{ provider: CapabilityProvider; result: CapabilityActionResult }>>([]);
  const parseJson = (): void => {
    const parsed = parseMcpReadmeJson(json); setChoices(parsed); setError(parsed === null); setChoice('');
    if (parsed?.length === 1 && parsed[0]?.name) { setName(parsed[0].name); setChoice(parsed[0].name); }
  };
  const send = (): void => {
    setError(false); setResults([]);
    try {
      const requests: CapabilityMcpAdd[] = [];
      for (const provider of ['claude', 'codex'] as const) if (providers[provider]) {
        const selectedScope = provider === 'claude' ? scope : 'user';
        if (!snapshot.columns[provider].mcpAdd?.[selectedScope].allowed) { setError(true); return; }
        let input: unknown;
        if (kind === 'stdio') input = { kind, command, args: args === '' ? [] : args.replaceAll('\r\n', '\n').split('\n'), ...(env === '' ? {} : { env: JSON.parse(env) as unknown }) };
        else if (kind === 'http') input = { kind, url, ...(headers === '' ? {} : { headers: JSON.parse(headers) as unknown }), ...(bearer === '' ? {} : { bearerTokenEnvVar: bearer }) };
        else {
          const selected = choices?.length === 1 ? choices[0] : choices?.find(item => item.name === choice);
          if (!selected) { setError(true); return; } input = selected.input;
        }
        const parsed = capabilityMcpAdd.safeParse({ projectPath: snapshot.projectPath, revision: snapshot.revision, provider, scope: selectedScope, name, input });
        if (!parsed.success) { setError(true); return; } requests.push(parsed.data);
      }
      if (requests.length === 0) { setError(true); return; }
      setBusy(true);
      void submit(requests).then(value => { if (live.current) setResults(value); }).catch(() => { if (live.current) setError(true); }).finally(() => { if (live.current) setBusy(false); });
    } catch { setError(true); }
  };
  const selectClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
  return <form aria-label={S.mcpActions.add} className="space-y-3 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); if (!busy) send(); }}>
    <h3 className="font-medium">{S.mcpActions.add}</h3>
    <fieldset disabled={busy} className="space-y-3">
      <div className="flex flex-wrap gap-4">{(['claude', 'codex'] as const).map(provider => <label key={provider} className="flex items-center gap-2">
        <input type="checkbox" checked={providers[provider]} onChange={event => setProviders(value => ({ ...value, [provider]: event.target.checked }))} />{provider === 'claude' ? 'Claude' : 'Codex'}
      </label>)}</div>
      <label className="block space-y-1" htmlFor={`${id}-name`}>{S.mcpActions.name}<Input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-1" htmlFor={`${id}-scope`}>{S.mcpActions.scope}<select id={`${id}-scope`} className={selectClass} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
        {(['user', 'project', 'local'] as const).map(value => <option key={value} value={value}>{S.projectPanel.scopes[value]}</option>)}
      </select></label>
      <label className="block space-y-1" htmlFor={`${id}-kind`}>{S.mcpActions.transport}<select id={`${id}-kind`} className={selectClass} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
        <option value="stdio">{S.mcpActions.stdio}</option><option value="http">{S.mcpActions.http}</option><option value="json">{S.mcpActions.json}</option>
      </select></label>
      {kind === 'stdio' && <>
        <label className="block space-y-1" htmlFor={`${id}-command`}>{S.mcpActions.command}<Input id={`${id}-command`} value={command} onChange={event => setCommand(event.target.value)} /></label>
        <label className="block space-y-1" htmlFor={`${id}-args`}>{S.mcpActions.args}<Textarea id={`${id}-args`} value={args} onChange={event => setArgs(event.target.value)} /></label>
        <label className="block space-y-1" htmlFor={`${id}-env`}>{S.mcpActions.env}<Textarea id={`${id}-env`} value={env} onChange={event => setEnv(event.target.value)} /></label>
      </>}
      {kind === 'http' && <>
        <label className="block space-y-1" htmlFor={`${id}-url`}>{S.mcpActions.url}<Input id={`${id}-url`} value={url} onChange={event => setUrl(event.target.value)} /></label>
        <label className="block space-y-1" htmlFor={`${id}-headers`}>{S.mcpActions.headers}<Textarea id={`${id}-headers`} value={headers} onChange={event => setHeaders(event.target.value)} /></label>
        <label className="block space-y-1" htmlFor={`${id}-bearer`}>{S.mcpActions.bearer}<Input id={`${id}-bearer`} value={bearer} onChange={event => setBearer(event.target.value)} /></label>
      </>}
      {kind === 'json' && <>
        <label className="block space-y-1" htmlFor={`${id}-json`}>{S.mcpActions.inputJson}<Textarea id={`${id}-json`} value={json} onChange={event => { setJson(event.target.value); setChoices(null); }} /></label>
        <Button type="button" variant="outline" onClick={parseJson}>{S.mcpActions.parseJson}</Button>
        {choices !== null && choices.length > 1 && <label className="block space-y-1" htmlFor={`${id}-choice`}>{S.mcpActions.chooseServer}<select id={`${id}-choice`} className={selectClass} value={choice} onChange={event => { setChoice(event.target.value); setName(event.target.value); }}>
          <option value="">{S.mcpActions.chooseServer}</option>{choices.map(item => <option key={item.name} value={item.name ?? ''}>{item.name}</option>)}
        </select></label>}
      </>}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{S.mcpActions.inputFailed}</p>}
    {busy && <p role="status" className="text-sm">{S.mcpActions.queued}</p>}
    {results.map(({ provider, result }) => <p key={provider} role="status" className="text-sm">{provider === 'claude' ? 'Claude' : 'Codex'} · {S.mcpActions.codes[result.code]}</p>)}
    <p className="text-xs text-muted-foreground">{S.mcpActions.appliesToNew}</p>
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{S.mcpActions.add}</Button><Button type="button" variant="outline" onClick={onCancel}>{S.mcpActions.cancel}</Button></div>
  </form>;
}
