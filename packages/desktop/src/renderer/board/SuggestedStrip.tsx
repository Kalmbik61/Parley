/** Полоса предложений агентов над колонкой Backlog: Add, Edit & add и Dismiss. */
import { useState } from 'react';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

type Suggestion = BoardProject['snapshot']['suggestions'][number];
interface Editing { key: string; title: string; details: string }

const rowKey = (project: BoardProject, suggestion: Suggestion): string => `${project.key}\0${suggestion.id}`;

export function SuggestedStrip({ bridge, projects }: { bridge: BoardBridge; projects: readonly BoardProject[] }): JSX.Element | null {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const rows = projects.flatMap(project => project.snapshot.suggestions.map(suggestion => ({ project, suggestion })));
  if (rows.length === 0) return null;

  const run = async (call: () => Promise<BacklogSnapshot>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      useBoardStore.getState().apply(await call());
      setEditing(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={S.backlog.suggested(rows.length)} className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border p-2 text-sm">
      <h4 className="text-xs font-medium text-muted-foreground">{S.backlog.suggested(rows.length)}</h4>
      {rows.map(({ project, suggestion }) => {
        const key = rowKey(project, suggestion);
        const edit = editing !== null && editing.key === key ? editing : null;
        const projectPath = project.projectPath;
        return (
          <article key={key} className="flex min-w-0 flex-col gap-1">
            <span className="max-w-full self-start truncate rounded-full bg-muted px-2 text-xs">{project.title}</span>
            {edit === null ? (
              <>
                <p className="break-words font-medium">{suggestion.title}</p>
                {suggestion.details !== '' && <p className="whitespace-pre-wrap break-words text-xs">{suggestion.details}</p>}
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{suggestion.why}</p>
                <p className="truncate text-xs text-muted-foreground">{`${suggestion.workId}/${suggestion.sessionId}`}</p>
              </>
            ) : (
              <>
                <input aria-label={S.backlog.titleField} maxLength={4096} className="min-w-0 rounded-md bg-background px-2 py-1" value={edit.title}
                  onChange={event => setEditing({ ...edit, title: event.target.value })} />
                <textarea aria-label={S.backlog.details} rows={3} maxLength={65536} className="rounded-md bg-background px-2 py-1" value={edit.details}
                  onChange={event => setEditing({ ...edit, details: event.target.value })} />
              </>
            )}
            <div className="flex flex-wrap gap-1">
              {edit === null ? (
                <>
                  <button type="button" disabled={busy} className="rounded-md px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => void run(() => bridge.call('backlog.suggestions.accept', { projectPath, id: suggestion.id }))}>{S.backlog.add}</button>
                  <button type="button" disabled={busy} className="rounded-md px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => setEditing({ key, title: suggestion.title, details: suggestion.details })}>{S.backlog.editAdd}</button>
                  <button type="button" disabled={busy} className="rounded-md px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => void run(() => bridge.call('backlog.suggestions.dismiss', { projectPath, id: suggestion.id }))}>{S.backlog.dismiss}</button>
                </>
              ) : (
                <>
                  <button type="button" disabled={busy || edit.title.trim() === ''} className="rounded-md px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => void run(() => bridge.call('backlog.suggestions.accept', { projectPath, id: suggestion.id, title: edit.title.trim(), details: edit.details }))}>{S.backlog.add}</button>
                  <button type="button" disabled={busy} className="rounded-md px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => setEditing(null)}>{S.board.cancel}</button>
                </>
              )}
            </div>
          </article>
        );
      })}
      {failed && <p role="alert" className="text-xs text-destructive">{S.board.failed}</p>}
    </section>
  );
}
