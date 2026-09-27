/**
 * Панель «Изменения» сессии в своём worktree (кусок 4.3 плана worktree,
 * спека 8.2, 8.3): список файлов и дифф (`worktrees.diff`), «Закоммитить
 * всё», «Влить в <base>» и «Отбросить» — то же самое, что агент делает
 * инструментами MCP, теперь доступно и из окна.
 *
 * «Влить» неактивна, пока `baseDirty` или `uncommitted` — слияние с грязной
 * базой или незакоммиченным в worktree хост всё равно отклонит, кнопка лишь
 * показывает причину заранее, не дожидаясь отказа (спека 8.2).
 *
 * «Отбросить» грязного worktree требует двух подтверждений — второе явно
 * называет цену (незакоммиченное будет потеряно) и только тогда шлёт
 * `force: true`. Второе подтверждение — отдельный кусок состояния
 * (`secondConfirmOpen`), а не единый шаг: `ConfirmDialog` сам зовёт
 * `onOpenChange(false)` сразу после `onConfirm()` (закрывает себя), и если
 * бы оба шага делили один флаг, это закрытие стирало бы переход на второй.
 */

import { useEffect, useState } from 'react';
import type { MergeResult, WorktreeDiff } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { sessionTag } from '../../lib/participant.js';
import { ConfirmDialog } from '../dialogs/ConfirmDialog.js';
import { DiffView } from './DiffView.js';

export interface ChangesPanelProps {
  bridge: HarnasBridge;
  sessionRef: SessionRef;
  /** Ветка или коммит базы worktree — подпись кнопки «Влить в <base>». */
  base: string;
}

const STATUS_LABEL: Record<string, string> = {
  A: 'добавлен',
  M: 'изменён',
  D: 'удалён',
  R: 'переименован',
};

/** Причина, по которой «Влить» неактивна — текст под курсором на самой кнопке. */
function mergeDisabledReason(diff: WorktreeDiff): string | null {
  if (diff.baseDirty) return 'база грязная: в её рабочей копии есть незакоммиченное';
  if (diff.uncommitted) return 'в worktree есть незакоммиченное — сперва закоммитить';
  return null;
}

const MERGE_FAIL_TEXT: Record<Exclude<MergeResult, { ok: true }>['reason'], string> = {
  base_not_checked_out: 'база нигде не выгружена',
  base_dirty: 'база грязная',
  uncommitted: 'в worktree есть незакоммиченное',
  conflict: 'конфликт слияния',
};

export function ChangesPanel({ bridge, sessionRef, base }: ChangesPanelProps): JSX.Element {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [sentToAgent, setSentToAgent] = useState(false);
  const [firstConfirmOpen, setFirstConfirmOpen] = useState(false);
  const [secondConfirmOpen, setSecondConfirmOpen] = useState(false);

  const label = sessionTag(sessionRef.sessionId);

  const load = (): void => {
    bridge
      .call('worktrees.diff', { ref: sessionRef })
      .then((result) => {
        setDiff(result);
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(load, [bridge, sessionRef.projectPath, sessionRef.workId, sessionRef.sessionId]);

  const commit = async (): Promise<void> => {
    const trimmed = commitMessage.trim();
    if (trimmed === '') return;
    try {
      await bridge.call('worktrees.commit', { ref: sessionRef, message: trimmed });
      setCommitMessage('');
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const merge = async (): Promise<void> => {
    setActionError(null);
    setConflictFiles(null);
    setSentToAgent(false);
    try {
      const result = await bridge.call('worktrees.merge', { ref: sessionRef });
      if (result.ok) {
        load();
        return;
      }
      if (result.reason === 'conflict') {
        setConflictFiles(result.files);
        return;
      }
      setActionError(MERGE_FAIL_TEXT[result.reason]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  // «Поручить агенту»: письмо этой же сессии со списком конфликтных файлов
  // (`rooms.send` с `roomId: null` — личная переписка, не общая комната).
  const assignToAgent = (): void => {
    if (conflictFiles === null) return;
    bridge
      .call('rooms.send', {
        projectPath: sessionRef.projectPath,
        workId: sessionRef.workId,
        roomId: null,
        to: [sessionRef.sessionId],
        kind: 'question',
        text: `Слияние ${label} упёрлось в конфликт: ${conflictFiles.join(', ')}. Разреши и закоммить.`,
      })
      .then(() => setSentToAgent(true))
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  };

  const discard = (force: boolean): void => {
    bridge.call('worktrees.discard', { ref: sessionRef, force }).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  };

  if (diff === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {loadError ?? 'Загрузка…'}
      </div>
    );
  }

  const disabledReason = mergeDisabledReason(diff);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {diff.files.length === 0 ? (
          <span className="text-muted-foreground">Файлов нет</span>
        ) : (
          diff.files.map((file) => (
            <span key={file.path} className="rounded bg-muted px-2 py-0.5">
              {STATUS_LABEL[file.status] ?? file.status} {file.path}
            </span>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {diff.uncommitted ? (
          <>
            <input
              className="rounded border border-input bg-transparent px-2 py-1 text-xs"
              placeholder="сообщение коммита"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <button
              type="button"
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground"
              onClick={() => void commit()}
            >
              Закоммитить всё
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="rounded border border-status-success-border bg-status-success-background px-3 py-1 text-xs text-status-success disabled:opacity-50"
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => void merge()}
        >
          Влить в {base}
        </button>
        <button
          type="button"
          className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground"
          onClick={() => setFirstConfirmOpen(true)}
        >
          Отбросить
        </button>
      </div>

      {actionError !== null ? <p className="text-xs text-destructive">{actionError}</p> : null}
      {loadError !== null ? <p className="text-xs text-destructive">{loadError}</p> : null}

      {conflictFiles !== null ? (
        <div className="rounded border border-status-warning-border p-2 text-xs">
          <p className="mb-1">Конфликт: {conflictFiles.join(', ')}</p>
          {sentToAgent ? (
            <p className="text-muted-foreground">Письмо отправлено</p>
          ) : (
            <button
              type="button"
              className="rounded border border-status-warning-border bg-status-warning-background px-3 py-1 text-status-warning"
              onClick={assignToAgent}
            >
              Поручить агенту
            </button>
          )}
        </div>
      ) : null}

      <DiffView patch={diff.patch} />

      <ConfirmDialog
        open={firstConfirmOpen}
        title={`Отбросить «${label}»?`}
        confirmLabel="Отбросить"
        onConfirm={() => {
          if (diff.uncommitted) setSecondConfirmOpen(true);
          else discard(false);
        }}
        onOpenChange={setFirstConfirmOpen}
      />
      <ConfirmDialog
        open={secondConfirmOpen}
        title="Незакоммиченные изменения будут потеряны"
        confirmLabel="Отбросить всё равно"
        onConfirm={() => discard(true)}
        onOpenChange={setSecondConfirmOpen}
      />
    </div>
  );
}
