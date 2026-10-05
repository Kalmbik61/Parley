import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { HISTORY_SEARCH_DEFAULT_LIMIT, historySearchResult } from '@parley/protocol';
import type { HistoryHitView, HistorySearchView } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';

/** Куда ведёт находка: файл проекта на строке, комната или сессия работы. */
export type SearchTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'room'; workId: string; roomId: string }
  | { kind: 'session'; workId: string; sessionId: string };

export interface ProjectSearchProps {
  bridge: Pick<ParleyBridge, 'call'>;
  projectPath: string | null;
  /** Хост знает `history.search`. */
  supported: boolean;
  /** Номер подключения к хосту: новое подключение — чистый поиск, старые ответы отбрасываются. */
  connection: number;
  /** Открывает цель; `false` — работы, комнаты или сессии уже нет. */
  onOpen(target: SearchTarget): boolean;
}

type Scope = keyof typeof S.projectSearch.scopes;
const SCOPES = Object.keys(S.projectSearch.scopes) as Scope[];
const ORDER: HistoryHitView['source'][] = ['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions'];

/** Поиск по прошлому проекта (спека памяти и журнала, 6.3): результаты по источникам, клик открывает место находки. */
export function ProjectSearch({ bridge, projectPath, supported, connection, onOpen }: ProjectSearchProps): JSX.Element {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [result, setResult] = useState<HistorySearchView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<'open-failed' | 'gone' | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    ++generation.current;
    setText(''); setScope('all'); setResult(null); setBusy(false); setError(false); setNotice(null);
  }, [projectPath, connection]);

  const search = (event: FormEvent): void => {
    event.preventDefault();
    const query = text.trim();
    if (!supported || projectPath === null || query === '' || busy) return;
    const current = ++generation.current;
    setBusy(true); setError(false); setNotice(null);
    void bridge.call('history.search', { projectPath, query, ...(scope === 'all' ? {} : { scope }), limit: HISTORY_SEARCH_DEFAULT_LIMIT }).then(value => {
      if (generation.current !== current) return;
      const parsed = historySearchResult.safeParse(value);
      if (parsed.success) setResult(parsed.data); else { setResult(null); setError(true); }
    }).catch(() => {
      if (generation.current === current) { setResult(null); setError(true); }
    }).finally(() => { if (generation.current === current) setBusy(false); });
  };

  const open = (target: SearchTarget): void => {
    setNotice(null);
    try { if (!onOpen(target)) setNotice('gone'); } catch { setNotice('open-failed'); }
  };

  if (!supported) return <p role="status" className="text-sm">{S.projectSearch.unavailable}</p>;
  if (projectPath === null) return <p role="status" className="text-sm">{S.projectSearch.disconnected}</p>;
  const groups = ORDER.map(source => ({ source, hits: result?.hits.filter(hit => hit.source === source) ?? [] })).filter(group => group.hits.length > 0);
  const actions = (hit: HistoryHitView): JSX.Element[] => {
    const out: JSX.Element[] = [];
    if (hit.file !== undefined) out.push(<Button key="file" size="xs" variant="outline" aria-label={`${S.projectSearch.openFile}: ${hit.title}`}
      onClick={() => open({ kind: 'file', path: hit.file!, ...(hit.line === undefined ? {} : { line: hit.line }) })}>{S.projectSearch.openFile}</Button>);
    if (hit.workId !== undefined && hit.roomId !== undefined) out.push(<Button key="room" size="xs" variant="outline" aria-label={`${S.projectSearch.openRoom}: ${hit.title}`}
      onClick={() => open({ kind: 'room', workId: hit.workId!, roomId: hit.roomId! })}>{S.projectSearch.openRoom}</Button>);
    if (hit.workId !== undefined && hit.sessionId !== undefined) out.push(<Button key="session" size="xs" variant="outline" aria-label={`${S.projectSearch.openSession}: ${hit.title}`}
      onClick={() => open({ kind: 'session', workId: hit.workId!, sessionId: hit.sessionId! })}>{S.projectSearch.openSession}</Button>);
    return out;
  };
  return <div className="space-y-3 text-sm">
    <form onSubmit={search} className="flex flex-wrap items-center gap-2" role="search">
      <Input aria-label={S.projectSearch.field} placeholder={S.projectSearch.placeholder} value={text} maxLength={1000} className="min-w-48 flex-1"
        onChange={event => setText(event.target.value)} />
      <select aria-label={S.projectSearch.scope} value={scope} disabled={busy}
        onChange={event => { const value = event.target.value as Scope; if (SCOPES.includes(value)) setScope(value); }}>
        {SCOPES.map(value => <option key={value} value={value}>{S.projectSearch.scopes[value]}</option>)}
      </select>
      <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>{S.projectSearch.search}</Button>
    </form>
    <p className="text-xs text-muted-foreground">{S.projectSearch.hint}</p>
    {busy && <p role="status" className="text-xs">{S.projectSearch.searching}</p>}
    {error && <p role="alert" className="text-destructive">{S.projectSearch.failed}</p>}
    {notice === 'open-failed' && <p role="alert" className="text-destructive">{S.projectSearch.openFailed}</p>}
    {notice === 'gone' && <p role="alert" className="text-destructive">{S.projectSearch.gone}</p>}
    {result && result.unavailable.length > 0 && <p role="status" className="text-xs text-muted-foreground">{S.projectSearch.partial(result.unavailable.map(source => S.projectSearch.sources[source]))}</p>}
    {result && result.hits.length === 0 && !busy && <p className="text-muted-foreground">{S.projectSearch.empty}</p>}
    {groups.map(group => <section key={group.source} aria-label={S.projectSearch.sources[group.source]} className="space-y-2">
      <h3 className="font-medium">{S.projectSearch.sources[group.source]}</h3>
      <ul className="space-y-2">
        {group.hits.map((hit, index) => <li key={`${hit.file ?? ''}:${hit.line ?? ''}:${hit.id ?? ''}:${hit.sessionId ?? ''}:${index}`} className="space-y-1 rounded-md border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 break-words font-medium">{hit.title === '' ? hit.id ?? hit.source : hit.title}</p>
            <div className="flex shrink-0 gap-2">{actions(hit)}</div>
          </div>
          <p className="whitespace-pre-wrap break-words text-xs">{hit.excerpt}</p>
          <p className="break-all text-xs text-muted-foreground">
            {[hit.id ?? '', hit.workId ?? '', hit.roomId ?? '', hit.sessionId ?? '', hit.date ? hit.date.slice(0, 10) : '',
              hit.file === undefined ? '' : `${hit.file}${hit.line === undefined ? '' : `:${hit.line}`}`,
              hit.shared ? S.projectSearch.shared : hit.alsoShared ? S.projectSearch.alsoShared : '', hit.complete ? '' : S.projectSearch.incomplete].filter(Boolean).join(' · ')}
          </p>
        </li>)}
      </ul>
    </section>)}
    {result && result.total > result.hits.length && <p className="text-xs text-muted-foreground">{S.projectSearch.showing(result.hits.length, result.total)}</p>}
  </div>;
}
