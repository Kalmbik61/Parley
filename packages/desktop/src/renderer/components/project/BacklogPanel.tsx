import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { backlogPrepareTakeResult, backlogSnapshot } from '@parley/protocol';
import type { BacklogChanged, BacklogMethodName, BacklogMethodParams, BacklogMethodResults, BacklogSnapshot } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Textarea } from '../../ui/textarea.js';

type Item = BacklogSnapshot['items'][number];
type Suggestion = BacklogSnapshot['suggestions'][number];
export interface BacklogBridge {
  on(event: 'backlog.changed', listener: (event: BacklogChanged) => void): () => void;
  call<M extends BacklogMethodName>(method: M, params: BacklogMethodParams<M>): Promise<BacklogMethodResults[M]>;
}
export interface BacklogPanelProps {
  bridge: BacklogBridge; projectPath: string | null; supported: boolean; connection: number;
  onOpenFile(projectPath: string): Promise<void>;
  /** Opens a creation dialog; marking is deliberately performed only by its success callback. */
  onTake(projectPath: string, item: Item, version: string, index: number): void;
  canTake?: boolean;
  onCount?(count: number): void;
  renderAuthor?(suggestion: Suggestion): ReactNode;
}
type Editor = { kind: 'add'; title: string; details: string; section: string } |
  { kind: 'item'; id: string | null; index: number; title: string; details: string; section: string; version: string } |
  { kind: 'suggestion'; id: string; title: string; details: string; section: string; version: string };
type Filter = 'open' | 'taken' | 'done';

export function BacklogPanel({ bridge, projectPath, supported, connection, onOpenFile, onTake, renderAuthor, canTake = true, onCount }: BacklogPanelProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<BacklogSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const generation = useRef(0);
  const sequence = useRef(0);
  const mutation = useRef<number | null>(null);
  const invalidated = useRef(false);
  const request = useRef<(() => void) | null>(null);
  const seen = useRef(new Set<string>());

  const apply = (value: unknown, current: number, id: number): boolean => {
    if (current !== generation.current || id !== sequence.current) return false;
    const parsed = backlogSnapshot.safeParse(value);
    if (!parsed.success || parsed.data.projectPath !== projectPath) { setError(true); return false; }
    setSnapshot(parsed.data); onCount?.(parsed.data.suggestions.length); setError(false);
    const fresh = parsed.data.diagnostics.filter(row => !seen.current.has(`${projectPath}\0${row.code}`));
    fresh.forEach(row => seen.current.add(`${projectPath}\0${row.code}`));
    if (fresh.length) setDiagnostics(value => [...value, ...fresh.map(row => row.code)]);
    return true;
  };
  useEffect(() => {
    const current = ++generation.current;
    ++sequence.current; request.current = null; mutation.current = null; invalidated.current = false;
    setSnapshot(null); onCount?.(0); setBusy(false); setError(false); setEditor(null); setFilter('open'); setDiagnostics([]);
    if (!supported || projectPath === null) return;
    let live = false;
    let unavailableEpoch = 0;
    let loading = false;
    setLiveUnavailable(false);
    const load = (subscribe = false): void => {
      if (loading || mutation.current === current) { invalidated.current = true; return; }
      loading = true;
      const id = ++sequence.current;
      const subscribedAt = unavailableEpoch;
      setBusy(true); setError(false);
      void bridge.call(subscribe ? 'backlog.subscribe' : 'backlog.get', { projectPath }).then(value => {
        if (apply(value, current, id) && subscribe && subscribedAt === unavailableEpoch) { live = true; setLiveUnavailable(false); }
      }).catch(async () => {
        if (current !== generation.current || id !== sequence.current) return;
        if (!subscribe) { setError(true); return; }
        live = false; setLiveUnavailable(true);
        try { apply(await bridge.call('backlog.get', { projectPath }), current, id); }
        catch { if (current === generation.current && id === sequence.current) setError(true); }
      }).finally(() => {
        loading = false;
        if (current !== generation.current || id !== sequence.current) return;
        setBusy(false);
        if (invalidated.current) { invalidated.current = false; load(); }
      });
    };
    const off = bridge.on('backlog.changed', event => {
      if (generation.current !== current || event.projectPath !== projectPath) return;
      if (event.unavailable) { ++unavailableEpoch; live = false; setLiveUnavailable(true); return; }
      load();
    });
    request.current = () => load(!live); load(true);
    return () => {
      ++generation.current; ++sequence.current; request.current = null; off();
      void bridge.call('backlog.unsubscribe', { projectPath }).catch(() => {});
    };
  }, [bridge, projectPath, supported, connection]);

  const mutate = async <M extends BacklogMethodName>(method: M, params: BacklogMethodParams<M>): Promise<void> => {
    if (busy) return;
    const current = generation.current; const id = ++sequence.current;
    mutation.current = current; setBusy(true); setError(false);
    try { if (apply(await bridge.call(method, params), current, id)) setEditor(null); }
    catch { if (current === generation.current && id === sequence.current) setError(true); }
    finally {
      if (current === generation.current && id === sequence.current) {
        mutation.current = null; setBusy(false);
        if (invalidated.current) { invalidated.current = false; request.current?.(); }
      }
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (!editor || !projectPath || !editor.title.trim()) return;
    if (editor.kind === 'add') void mutate('backlog.add', { projectPath, title: editor.title, details: editor.details,
      ...(editor.section.trim() ? { section: editor.section } : {}), ...(snapshot ? { version: snapshot.version } : {}) });
    else if (editor.kind === 'item') void mutate('backlog.update', { projectPath, ...(editor.id === null ? { index: editor.index } : { id: editor.id }), version: editor.version,
      patch: { title: editor.title, details: editor.details } });
    else void mutate('backlog.suggestions.accept', { projectPath, id: editor.id, title: editor.title, details: editor.details });
  };
  const openFile = (): void => {
    if (!projectPath || busy) return;
    const current = generation.current; setBusy(true); setError(false);
    void onOpenFile(projectPath).catch(() => { if (current === generation.current) setError(true); })
      .finally(() => { if (current === generation.current) setBusy(false); });
  };
  const prepareTake = async (item: Item): Promise<void> => {
    if (!canTake || !projectPath || !snapshot || busy || item.checked || item.taken !== undefined) return;
    const current = generation.current; const id = ++sequence.current;
    mutation.current = current; setBusy(true); setError(false);
    try {
      const parsed = backlogPrepareTakeResult.safeParse(await bridge.call('backlog.prepareTake', { projectPath,
        ...(item.id === null ? { index: snapshot.items.indexOf(item) } : { id: item.id }), version: snapshot.version }));
      if (current !== generation.current || id !== sequence.current) return;
      if (!parsed.success || !apply(parsed.data.snapshot, current, id)) { setError(true); return; }
      const prepared = parsed.data.snapshot.items.find(row => row.id === parsed.data.id);
      if (!prepared || prepared.checked || prepared.taken !== undefined) { setError(true); return; }
      onTake(projectPath, prepared, parsed.data.snapshot.version, parsed.data.snapshot.items.indexOf(prepared));
    } catch { if (current === generation.current && id === sequence.current) setError(true); }
    finally {
      if (current === generation.current && id === sequence.current) {
        mutation.current = null; setBusy(false);
        if (invalidated.current) { invalidated.current = false; request.current?.(); }
      }
    }
  };
  if (!supported) return <p>{S.backlog.unavailable}</p>;
  if (projectPath === null) return <p>Select a project to view its backlog.</p>;
  const filtered = snapshot?.items.filter(item => filter === 'done' ? item.checked : filter === 'taken' ? !item.checked && item.taken !== undefined : !item.checked) ?? [];
  const sections = [...new Set(filtered.map(item => item.section))];
  return <div className="space-y-3 text-sm">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => request.current?.()}>{S.backlog.refresh}</Button>
      <Button size="sm" variant="outline" disabled={busy || !snapshot?.file.exists} onClick={openFile}>{S.backlog.openFile}</Button>
      <Button size="sm" disabled={busy || !snapshot} onClick={() => setEditor({ kind: 'add', title: '', details: '', section: '' })}>{S.backlog.addItem}</Button>
    </div>
    {busy && <p role="status">Loading…</p>}
    {liveUnavailable && <p role="status">{S.backlog.liveUnavailable}</p>}
    {error && <p role="alert">{S.backlog.failed}</p>}
    {diagnostics.map(code => <p key={code} role="status">{S.backlog.ignore[code as keyof typeof S.backlog.ignore]}</p>)}
    {!canTake && <p>{S.backlog.noWorkspace}</p>}
    {snapshot && <>
      <label className="flex items-center gap-2">{S.backlog.agentSuggestions}
        <select aria-label={S.backlog.agentSuggestions} value={snapshot.rule} disabled={busy} onChange={event => {
          const rule = event.target.value;
          if (rule === 'ask' || rule === 'problems' || rule === 'everything') void mutate('backlog.preferences.set', { projectPath, rule });
        }}>
          <option value="ask">{S.backlog.ask}</option><option value="problems">{S.backlog.problems}</option><option value="everything">{S.backlog.everything}</option>
        </select>
      </label>
      {snapshot.file.choice !== undefined && <>
        {snapshot.file.choice === null && snapshot.file.todos && <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
          <span>{S.backlog.todosOffer(snapshot.file.todos)}</span>
          <Button size="xs" disabled={busy} onClick={() => { void mutate('backlog.file.set', { projectPath, file: 'todos' }); }}>{S.backlog.useTodos(snapshot.file.todos)}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => { void mutate('backlog.file.set', { projectPath, file: 'state' }); }}>{S.backlog.keepState}</Button>
        </div>}
        <label className="flex items-center gap-2">{S.backlog.file}
          <select aria-label={S.backlog.file} value={snapshot.file.choice ?? 'state'} disabled={busy} onChange={event => {
            const file = event.target.value;
            if (file === 'state' || file === 'todos') void mutate('backlog.file.set', { projectPath, file });
          }}>
            <option value="state">{S.backlog.stateFile}</option><option value="todos">{snapshot.file.todos ?? S.backlog.todosFile}</option>
          </select>
        </label>
      </>}
      <section aria-label="Suggested">
        <h3>{S.backlog.suggested(snapshot.suggestions.length)}</h3>
        {snapshot.suggestions.map(row => <article key={row.id} className="space-y-1 rounded-md border border-border p-2">
          <p>{row.title}</p>{row.details && <p className="whitespace-pre-wrap">{row.details}</p>}
          <p className="whitespace-pre-wrap">{row.why}</p>
          <div>{renderAuthor?.(row) ?? `${row.workId}/${row.sessionId}`}</div>
          <div className="flex gap-2">
            <Button size="xs" disabled={busy} onClick={() => { void mutate('backlog.suggestions.accept', { projectPath, id: row.id }); }}>{S.backlog.add}</Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditor({ kind: 'suggestion', id: row.id, title: row.title, details: row.details, section: '', version: snapshot.version })}>{S.backlog.editAdd}</Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void mutate('backlog.suggestions.dismiss', { projectPath, id: row.id }); }}>{S.backlog.dismiss}</Button>
          </div>
        </article>)}
      </section>
      <label>{S.backlog.show} <select aria-label={S.backlog.showItems} value={filter} onChange={event => {
        const value = event.target.value; if (value === 'open' || value === 'taken' || value === 'done') setFilter(value);
      }}><option value="open">{S.backlog.open}</option><option value="taken">{S.backlog.taken}</option><option value="done">{S.backlog.done}</option></select></label>
      {filtered.length === 0 && <p>{S.backlog.empty}</p>}
      {sections.map(section => <section key={section ?? ''} aria-label={section ?? S.backlog.items}>
        {section !== null && <h3>{section}</h3>}
        {filtered.filter(item => item.section === section).map((item, index) => <article key={item.id ?? `handwritten-${index}`} className="space-y-1 rounded-md border border-border p-2">
          <label className="flex gap-2"><input type="checkbox" checked={item.checked} disabled={busy} onChange={event => {
            void mutate('backlog.update', { projectPath, ...(item.id === null ? { index: snapshot.items.indexOf(item) } : { id: item.id }), version: snapshot.version, patch: { checked: event.target.checked } });
          }} /><span>{item.title}</span></label>
          {item.details && <p className="whitespace-pre-wrap">{item.details}</p>}
          {item.taken && <p>{S.backlog.itemTaken(item.taken)}</p>}{item.done && <p>{S.backlog.itemDone(item.done)}</p>}
          {<div className="flex gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditor({ kind: 'item', id: item.id, index: snapshot.items.indexOf(item), title: item.title, details: item.details, section: item.section ?? '', version: snapshot.version })}>{S.backlog.edit}</Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void mutate('backlog.remove', { projectPath, ...(item.id === null ? { index: snapshot.items.indexOf(item) } : { id: item.id }), version: snapshot.version }); }}>{S.backlog.remove}</Button>
            <Button size="xs" disabled={!canTake || busy || item.checked || item.taken !== undefined} onClick={() => { void prepareTake(item); }}>{S.backlog.take}</Button>
          </div>}
        </article>)}
      </section>)}
    </>}
    {editor && <form onSubmit={submit} className="space-y-2">
      <label>{S.backlog.titleField}<Input aria-label={S.backlog.titleField} maxLength={4096} value={editor.title} disabled={busy} onChange={event => setEditor({ ...editor, title: event.target.value })} /></label>
      <label>{S.backlog.details}<Textarea aria-label={S.backlog.details} maxLength={65536} value={editor.details} disabled={busy} onChange={event => setEditor({ ...editor, details: event.target.value })} /></label>
      {editor.kind === 'add' && <label>{S.backlog.section}<Input aria-label={S.backlog.section} maxLength={4096} value={editor.section} disabled={busy} onChange={event => setEditor({ ...editor, section: event.target.value })} /></label>}
      <Button size="sm" type="submit" disabled={busy || !editor.title.trim()}>{editor.kind === 'item' ? S.backlog.save : S.backlog.add}</Button>
      <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>{S.backlog.cancel}</Button>
    </form>}
  </div>;
}
