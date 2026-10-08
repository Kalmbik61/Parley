import { useEffect, useRef, useState } from 'react';
import { DECISIONS_LIST_DEFAULT_LIMIT, decisionsListResult } from '@parley/protocol';
import type { DecisionRef, DecisionsListResult } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';

export interface DecisionsPanelProps {
  bridge: Pick<ParleyBridge, 'call'>;
  projectPath: string | null;
  /** Хост знает `decisions.list`. */
  supported: boolean;
  /** Номер подключения к хосту: новое подключение — новый запрос, старые ответы отбрасываются. */
  connection: number;
  /** Открывает файл ИМЕННО этой принятой ревизии (имя файла журнала, не путь). */
  onOpen(projectPath: string, file: string): Promise<void>;
}

const FILTER_DELAY_MS = 250;

/** Журнал принятых решений проекта (спека памяти и журнала, 3.4): новые сверху, фильтр по тексту, открытие файла. */
export function DecisionsPanel({ bridge, projectPath, supported, connection, onOpen }: DecisionsPanelProps): JSX.Element {
  const [result, setResult] = useState<DecisionsListResult | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);
  const [openFailed, setOpenFailed] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(filter.trim()), FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filter]);
  useEffect(() => { setFilter(''); setQuery(''); }, [projectPath, connection]);

  useEffect(() => {
    const current = ++generation.current;
    setOpenFailed(null);
    if (!supported || projectPath === null) { setResult(null); setError(false); setBusy(false); return; }
    setBusy(true); setError(false);
    void bridge.call('decisions.list', { projectPath, ...(query === '' ? {} : { query }), limit: DECISIONS_LIST_DEFAULT_LIMIT }).then(value => {
      if (generation.current !== current) return;
      const parsed = decisionsListResult.safeParse(value);
      if (parsed.success) setResult(parsed.data); else { setResult(null); setError(true); }
    }).catch(() => {
      if (generation.current === current) { setResult(null); setError(true); }
    }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { ++generation.current; };
  }, [bridge, projectPath, supported, connection, query, reload]);

  const open = (row: DecisionRef): void => {
    if (projectPath === null) return;
    const current = generation.current;
    setOpenFailed(null);
    void onOpen(projectPath, row.file).catch(() => { if (generation.current === current) setOpenFailed(row.file); });
  };

  if (!supported) return <p role="status" className="text-sm">{S.decisions.unavailable}</p>;
  return <div className="space-y-3">
    <div className="flex items-center gap-2">
      <Input aria-label={S.decisions.filter} placeholder={S.decisions.filterPlaceholder} value={filter} maxLength={200}
        onChange={event => setFilter(event.target.value)} />
      <Button type="button" variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>{S.decisions.refresh}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{S.decisions.loadFailed}</p>}
    {result?.partial && <p role="status" className="text-sm">{S.decisions.partial}</p>}
    {result?.errors.map(row => <p key={row.code} role="status" className="text-xs text-muted-foreground">{S.decisions.errors[row.code](row.count)}</p>)}
    {busy && result === null && <p role="status" className="text-xs">{S.decisions.loading}</p>}
    {result !== null && result.decisions.length === 0 && !busy && <p className="text-sm text-muted-foreground">{query === '' ? S.decisions.empty : S.decisions.emptyFiltered}</p>}
    {result !== null && result.decisions.length > 0 && <ul className="space-y-2" aria-label={S.decisions.title}>
      {result.decisions.map(row => <li key={row.file} className="space-y-1 rounded-md border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words font-medium">{row.title === '' ? row.proposalId : row.title}{row.kind === 'completion' ? ` · ${S.decisions.completion}` : ''}</p>
            <p className="text-xs text-muted-foreground">{S.decisions.states[row.state]}</p>
            <p className="break-all text-xs text-muted-foreground">
              {[row.workId, row.roomId, row.proposalId, S.decisions.revision(row.rev), (row.acceptedAt ?? row.file.slice(0, 10)).slice(0, 10)].join(' · ')}
            </p>
          </div>
          {row.openable && <Button type="button" variant="outline" aria-label={`${S.decisions.open}: ${row.title === '' ? row.proposalId : row.title}`}
            onClick={() => open(row)}>{S.decisions.open}</Button>}
        </div>
        {openFailed === row.file && <p role="alert" className="text-sm text-destructive">{S.decisions.openFailed}</p>}
      </li>)}
    </ul>}
    {result !== null && result.total > result.decisions.length && <p className="text-xs text-muted-foreground">{S.decisions.showing(result.decisions.length, result.total)}</p>}
  </div>;
}
