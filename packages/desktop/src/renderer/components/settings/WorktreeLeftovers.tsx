/**
 * Settings → Projects → Worktrees (спека 2026-11-03, 4.3): копии, которые хост не смог убрать сам
 * (`worktrees.leftovers`), с причиной и размером. «Remove copy» зовёт `worktrees.removeCopy` по одной строке,
 * «Remove all» — по очереди по всем; после каждого действия список перечитывается у хоста.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorktreeLeftover } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { sessionTag } from '../../lib/participant.js';
import { shortenMiddle } from '../../lib/shorten-middle.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../dialogs/ConfirmDialog.js';

export interface WorktreeLeftoversProps {
  bridge: ParleyBridge;
}

type Pending = { kind: 'one'; item: WorktreeLeftover } | { kind: 'all' };

function reasonText(item: WorktreeLeftover): string {
  const text = S.settings.worktrees.reason;
  switch (item.reason) {
    case 'dirty':
      return text.dirty(item.files);
    case 'unsaved':
      return text.unsaved;
    case 'refused':
      return text.refused(item.message);
    case 'in-use':
      return text.inUse;
  }
}

function itemKey(item: WorktreeLeftover): string {
  return `${item.ref.projectPath}\u0000${item.ref.workId}\u0000${item.ref.sessionId}`;
}

export function WorktreeLeftovers({ bridge }: WorktreeLeftoversProps): JSX.Element {
  const [items, setItems] = useState<WorktreeLeftover[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await bridge.call('worktrees.leftovers', {});
    setItems(result.items);
  }, [bridge]);

  useEffect(() => {
    let alive = true;
    bridge.call('worktrees.leftovers', {}).then(
      (result) => {
        if (alive) setItems(result.items);
      },
      (err: unknown) => {
        console.warn('[parley] worktrees.leftovers', 'failed');
        if (alive) setError(errorText(decodeIpcError(err).code, S.errors.actions.loadWorktrees));
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const remove = async (targets: WorktreeLeftover[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const item of targets) {
        try {
          await bridge.call('worktrees.removeCopy', { ref: item.ref });
        } catch (err) {
          console.warn('[parley] worktrees.removeCopy', 'failed');
          setError(errorText(decodeIpcError(err).code, S.errors.actions.removeWorktree));
        }
      }
      await load();
    } catch {
      console.warn('[parley] worktrees.leftovers', 'failed');
    } finally {
      setBusy(false);
    }
  };

  const text = S.settings.worktrees;
  const list = items ?? [];
  return (
    <section className="flex flex-col gap-2" aria-label={text.heading}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-sm font-medium">{text.heading}</h3>
        {list.length >= 2 ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPending({ kind: 'all' })}>
            {text.removeAll}
          </Button>
        ) : null}
      </div>
      {error !== null ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
      {items !== null && list.length === 0 ? <p className="m-0 text-muted-foreground">{text.empty}</p> : null}
      {list.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {list.map((item) => (
            <li key={itemKey(item)} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">
                  {item.label} <span className="text-xs text-muted-foreground">{sessionTag(item.ref.sessionId)}</span>
                </span>
                <span title={item.path} className="truncate font-mono text-[13px]">
                  {shortenMiddle(item.path)}
                </span>
                <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span title={item.branch} className="min-w-0 max-w-full truncate font-mono">
                    {item.branch}
                  </span>
                  {item.sizeBytes === null ? null : (
                    <span title={text.sizeHint}>{text.sizeLabel(text.size(item.sizeBytes))}</span>
                  )}
                  <span className="min-w-0 max-w-full truncate" title={reasonText(item)}>
                    {reasonText(item)}
                  </span>
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy}
                aria-label={`${text.removeCopy} ${item.label}`}
                onClick={() => setPending({ kind: 'one', item })}
              >
                {text.removeCopy}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'all' ? text.confirmAllTitle(list.length) : text.confirmTitle}
        description={text.confirmBody}
        confirmLabel={pending?.kind === 'all' ? text.removeAll : text.removeCopy}
        onConfirm={() => {
          const current = pending;
          if (current === null) return;
          void remove(current.kind === 'all' ? list : [current.item]);
        }}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      />
    </section>
  );
}
