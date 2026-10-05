import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { memorySnapshot } from '@parley/protocol';
import type { MemoryItemView, MemoryMethodName, MemoryMethodParams, MemorySnapshot, MemorySuggestionView } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Textarea } from '../../ui/textarea.js';

export interface MemoryPanelProps {
  bridge: Pick<ParleyBridge, 'call'>;
  projectPath: string | null;
  /** Хост знает методы `memory.*`. */
  supported: boolean;
  /** Номер подключения к хосту: новое подключение — новый запрос, старые ответы отбрасываются. */
  connection: number;
  /** Открывает `memory.md` во вкладке файла; путь — внутри проекта. */
  onOpenFile(relativePath: string): void;
  /** Сколько предложений ждёт решения: число в подписи вкладки. */
  onCount?(count: number): void;
}

type Kind = MemoryItemView['kind'];
type Editor = { mode: 'add' | 'item' | 'suggestion'; id: string | null; kind: Kind; fact: string; details: string };
type Failure = 'load' | 'action' | 'conflict' | 'undo-conflict';
const KINDS: readonly Kind[] = ['fact', 'lesson', 'agreement'];

/** Память проекта (спека памяти и журнала, 5): записи по разделам, Suggested, Add, Edit, Dismiss и Undo записей «по просьбе». */
export function MemoryPanel({ bridge, projectPath, supported, connection, onOpenFile, onCount }: MemoryPanelProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const factRef = useRef<HTMLInputElement>(null);
  const editorKey = editor ? `${editor.mode}:${editor.id ?? ''}` : null;

  // Форма внизу панели, под длинными списками: при открытии ведём к ней фокус и прокрутку.
  useEffect(() => {
    if (editorKey === null) return;
    factRef.current?.focus({ preventScroll: true });
    formRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [editorKey]);

  const apply = (value: unknown, current: number): boolean => {
    if (generation.current !== current) return false;
    const parsed = memorySnapshot.safeParse(value);
    if (!parsed.success || parsed.data.projectPath !== projectPath) { setFailure('load'); return false; }
    setSnapshot(parsed.data); setFailure(null); onCount?.(parsed.data.suggestions.length);
    return true;
  };

  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null); setFailure(null); setEditor(null); setBusy(false); onCount?.(0);
    if (!supported || projectPath === null) return;
    setBusy(true);
    void bridge.call('memory.get', { projectPath }).then(value => { apply(value, current); })
      .catch(() => { if (generation.current === current) setFailure('load'); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { ++generation.current; };
    // `apply` и `onCount` читают только актуальное поколение запроса.
  }, [bridge, projectPath, supported, connection, reload]);

  const mutate = async <M extends MemoryMethodName>(method: M, params: MemoryMethodParams<M>, undo = false): Promise<void> => {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setFailure(null);
    try { if (apply(await bridge.call(method, params), current)) setEditor(null); }
    catch (error) {
      if (generation.current !== current) return;
      setFailure(decodeIpcError(error).code === 'conflict' ? (undo ? 'undo-conflict' : 'conflict') : 'action');
    } finally { if (generation.current === current) setBusy(false); }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!editor || projectPath === null || !snapshot || !editor.fact.trim()) return;
    if (editor.mode === 'add') void mutate('memory.add', { projectPath, kind: editor.kind, fact: editor.fact.trim(),
      ...(editor.details === '' ? {} : { details: editor.details }), version: snapshot.version });
    else if (editor.mode === 'item' && editor.id !== null) void mutate('memory.update', { projectPath, id: editor.id, version: snapshot.version,
      patch: { fact: editor.fact.trim(), details: editor.details } });
    else if (editor.id !== null) void mutate('memory.accept', { projectPath, id: editor.id, fact: editor.fact.trim(), details: editor.details });
  };

  if (!supported) return <p role="status" className="text-sm">{S.memory.unavailable}</p>;
  if (projectPath === null) return <p role="status" className="text-sm">{S.memory.disconnected}</p>;
  const bySection = (kind: Kind): MemoryItemView[] => snapshot?.items.filter(item => item.kind === kind) ?? [];
  const suggestion = (row: MemorySuggestionView): JSX.Element => <article key={row.id} className="space-y-1 rounded-md border border-border p-3" aria-label={row.fact}>
    <p className="break-words font-medium">{row.fact}</p>
    <p className="text-xs text-muted-foreground">{S.memory.kinds[row.kind]}{row.sessionId ? ` · ${S.memory.suggestedBy(row.sessionId)}` : ''}</p>
    {row.details && <p className="whitespace-pre-wrap break-words text-sm">{row.details}</p>}
    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{S.memory.why(row.why)}</p>
    <div className="flex gap-2">
      <Button size="xs" disabled={busy} onClick={() => { void mutate('memory.accept', { projectPath, id: row.id }); }}>{S.memory.add}</Button>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditor({ mode: 'suggestion', id: row.id, kind: row.kind, fact: row.fact, details: row.details })}>{S.memory.editAdd}</Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void mutate('memory.dismiss', { projectPath, id: row.id }); }}>{S.memory.dismiss}</Button>
    </div>
  </article>;
  return <div className="space-y-3 text-sm">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>{S.memory.refresh}</Button>
      <Button size="sm" variant="outline" disabled={!snapshot?.file.exists} onClick={() => snapshot && onOpenFile(snapshot.file.relativePath)}>{S.memory.openFile}</Button>
      <Button size="sm" disabled={busy || !snapshot} onClick={() => setEditor({ mode: 'add', id: null, kind: 'fact', fact: '', details: '' })}>{S.memory.addEntry}</Button>
    </div>
    {busy && snapshot === null && <p role="status" className="text-xs">{S.memory.loading}</p>}
    {failure === 'load' && <p role="alert" className="text-destructive">{S.memory.loadFailed}</p>}
    {failure === 'action' && <p role="alert" className="text-destructive">{S.memory.failed}</p>}
    {failure === 'conflict' && <p role="alert" className="text-destructive">{S.memory.conflict}</p>}
    {failure === 'undo-conflict' && <p role="alert" className="text-destructive">{S.memory.undoConflict}</p>}
    {snapshot?.diagnostics.map(row => <p key={row.code} role="status" className="text-xs text-muted-foreground">{S.memory.ignore[row.code]}</p>)}
    {snapshot && <>
      <section aria-label="Suggested" className="space-y-2">
        <h3 className="font-medium">{S.memory.suggested(snapshot.suggestions.length)}</h3>
        {snapshot.suggestions.length === 0 ? <p className="text-xs text-muted-foreground">{S.memory.emptySuggested}</p> : snapshot.suggestions.map(suggestion)}
      </section>
      {snapshot.undoable.length > 0 && <section aria-label={S.memory.recentRequests} className="space-y-2">
        <h3 className="font-medium">{S.memory.recentRequests}</h3>
        <p className="text-xs text-muted-foreground">{S.memory.recentHint}</p>
        {snapshot.undoable.map(row => <div key={row.operationId} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          <p className="min-w-0 break-words">{row.fact}</p>
          <Button size="xs" variant="outline" disabled={busy} aria-label={`${S.memory.undo}: ${row.fact}`}
            onClick={() => { void mutate('memory.undo', { projectPath, operationId: row.operationId }, true); }}>{S.memory.undo}</Button>
        </div>)}
      </section>}
      <section aria-label={S.memory.entries} className="space-y-3">
        {snapshot.items.length === 0 && <p className="text-muted-foreground">{S.memory.empty}</p>}
        {KINDS.map(kind => bySection(kind).length === 0 ? null : <div key={kind} className="space-y-2">
          <h3 className="font-medium">{S.memory.kinds[kind]}</h3>
          <ul className="space-y-2" aria-label={S.memory.kinds[kind]}>
            {bySection(kind).map((item, index) => <li key={item.id ?? `hand-${kind}-${index}`} className="space-y-1 rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-words">{item.fact}</p>
                {item.id !== null && <Button size="xs" variant="outline" disabled={busy} aria-label={`${S.memory.edit}: ${item.fact}`}
                  onClick={() => setEditor({ mode: 'item', id: item.id, kind: item.kind, fact: item.fact, details: item.details })}>{S.memory.edit}</Button>}
              </div>
              {item.details && <p className="whitespace-pre-wrap break-words text-xs">{item.details}</p>}
              <p className="break-all text-xs text-muted-foreground">
                {[item.id ?? '', `${S.memory.authors[item.author]}${item.by ? ` ${item.by}` : ''}`, item.onRequest ? S.memory.onRequest : '', item.amended ? S.memory.amended : '',
                  item.state === 'superseded' ? S.memory.superseded : ''].filter(Boolean).join(' · ')}
              </p>
            </li>)}
          </ul>
        </div>)}
      </section>
    </>}
    {editor && <form ref={formRef} onSubmit={submit} className="space-y-2" aria-label={S.memory.title}>
      {editor.mode === 'add' && <label className="block">{S.memory.kind}
        <select aria-label={S.memory.kind} className="ml-2" value={editor.kind} disabled={busy}
          onChange={event => { const value = event.target.value; if (value === 'fact' || value === 'lesson' || value === 'agreement') setEditor({ ...editor, kind: value }); }}>
          {KINDS.map(kind => <option key={kind} value={kind}>{S.memory.kinds[kind]}</option>)}
        </select></label>}
      <label className="block">{S.memory.factField}<Input ref={factRef} aria-label={S.memory.factField} maxLength={4096} value={editor.fact} disabled={busy}
        onChange={event => setEditor({ ...editor, fact: event.target.value })} /></label>
      <label className="block">{S.memory.detailsField}<Textarea aria-label={S.memory.detailsField} maxLength={65536} value={editor.details} disabled={busy}
        onChange={event => setEditor({ ...editor, details: event.target.value })} /></label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || !editor.fact.trim() || /<!--|-->/.test(editor.fact)}>{editor.mode === 'item' ? S.memory.save : S.memory.add}</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>{S.memory.cancel}</Button>
      </div>
    </form>}
  </div>;
}
