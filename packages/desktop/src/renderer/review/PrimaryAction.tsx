/**
 * Главная кнопка «Изменений» (кусок 8.2b, спека 11.2, решения сверки M16, I2): одна кнопка от
 * правки агента до слияния — что она делает, решает `primaryActionFor` (8.2a), а не разметка.
 *
 * Всё, что меняет репозиторий, — только нажатием человека. Сообщение коммита пишет человек
 * (рамка 15.1: без генерации). Вопросы:
 * - `commit` — без вопроса, в `working` — вопрос со строкой про агента;
 * - `commit-project` — вопрос всегда: коммит заберёт всё в папке, не только правки этой сессии;
 * - `merge` — вопрос всегда; `baseCheckout: null` — сразу тост, слияние заведомо откажет.
 * После своего коммита и слияния — `onChanged()` (refresh мимо дросселя).
 *
 * Несохранённые буферы корня сессии (раунд fix-final-c, п. 4): правка во вкладке без ⌘S в коммит
 * не попадала молча. Есть такие — коммит всегда с вопросом, он называет «N unsaved files» и даёт
 * «Save all and commit» (запись, затем коммит; запись не удалась — коммита нет) и «Commit
 * anyway». Слияние не коммитит — его вопрос прежний.
 */

import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { dirtyBufferKeys, useFilesStore } from '../files/store.js';
import { splitBufferKey } from '../files/buffer.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { Button } from '../ui/button.js';
import { Textarea } from '../ui/textarea.js';
import { AskAgentDialog } from './AskAgentDialog.js';
import { askAgentText, mergeResultText, primaryActionFor, type ChangesSource } from './state.js';

export interface PrimaryActionProps {
  bridge: ParleyBridge;
  /** Работа сессии: буферы файлов ищутся по её корням. */
  workKey: string;
  sessionRef: SessionRef;
  source: ChangesSource;
  /** Сессия в `working`: подтверждения добавляют строку «агент ещё работает». */
  working: boolean;
  sendDeps: SendWithToastDeps;
  /** Свой коммит или слияние прошли — обновить сразу. */
  onChanged(): void;
  /** Ответ `conflict` слияния — файлы для секции «Конфликты». */
  onConflicts(files: string[]): void;
}

/** Описание вопроса: предложения через пробел, каждое с точкой; пустые выпадают. */
function sentences(...parts: Array<string | null>): string {
  return parts
    .filter((part): part is string => part !== null)
    .map((part) => (part.endsWith('.') ? part : `${part}.`))
    .join(' ');
}

/** Ключи грязных буферов корня, который коммитит источник: worktree сессии или папка проекта. */
function useUnsavedKeys(workKey: string, sessionId: string, source: ChangesSource): string[] {
  const worktree = source.kind === 'worktree';
  return useFilesStore(
    useShallow((state) =>
      source.kind === 'pending'
        ? []
        : dirtyBufferKeys(state.buffers).filter((key) => {
            const root = state.buffers[key]?.root;
            if (root?.workKey !== workKey) return false;
            return worktree ? root.spec.kind === 'worktree' && root.spec.sessionId === sessionId : root.spec.kind === 'project';
          }),
    ),
  );
}

export function PrimaryAction({ bridge, workKey, sessionRef, source, working, sendDeps, onChanged, onConflicts }: PrimaryActionProps): JSX.Element {
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<'commit' | 'merge' | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const action = primaryActionFor(source);
  const agentLine = working ? S.changes.agentStillWorking : null;
  const unsaved = useUnsavedKeys(workKey, sessionRef.sessionId, source);

  // Одно нажатие — один коммит (раунд 8, пункт 2): два клика или ⌘Enter + клик до ответа хоста слали
  // `worktrees.commit` дважды, второй получал отказ и ложный тост после успешного коммита. Ref гасит
  // повтор ещё до перерисовки, флаг делает кнопку неактивной, пока запрос идёт.
  const committing = useRef(false);
  const [busy, setBusy] = useState(false);

  const done = (): void => {
    committing.current = false;
    setBusy(false);
  };

  /** Начать коммит: `null` — пустое сообщение или коммит уже идёт. */
  const begin = (): string | null => {
    const trimmed = message.trim();
    if (trimmed === '' || committing.current) return null;
    committing.current = true;
    setBusy(true);
    return trimmed;
  };

  const commit = (): void => {
    const trimmed = begin();
    if (trimmed !== null) send(trimmed);
  };

  /** «Save all and commit»: буферы корня — по очереди; хоть одна запись не удалась — коммита нет. */
  const saveAllAndCommit = (): void => {
    const trimmed = begin();
    if (trimmed === null) return;
    void (async () => {
      let saved = true;
      for (const key of unsaved) {
        const { workKey: bufferWork, tabId } = splitBufferKey(key);
        if ((await useFilesStore.getState().save(bridge, bufferWork, tabId)) !== 'saved') saved = false;
      }
      if (saved) {
        send(trimmed);
        return;
      }
      done();
      toast.error(S.changes.saveBeforeCommitFailed);
    })();
  };

  const send = (trimmed: string): void => {
    const call =
      source.kind === 'project'
        ? bridge.call('changes.commitProject', { ref: sessionRef, message: trimmed })
        : bridge.call('worktrees.commit', { ref: sessionRef, message: trimmed });
    call.then(
      () => {
        done();
        setMessage('');
        onChanged();
      },
      (error: unknown) => {
        done();
        const info = decodeIpcError(error);
        // Сообщение хоста — текст рантайма: человеку — только свой, по коду.
        console.warn('[parley] commit', info.code, info.message);
        toast.error(errorText(info.code, S.errors.actions.commit));
      },
    );
  };

  const merge = (): void => {
    if (source.kind !== 'worktree') return;
    const base = source.base;
    bridge.call('worktrees.merge', { ref: sessionRef }).then(
      (result) => {
        const shown = mergeResultText(result, base);
        if (result.ok) {
          toast(shown.text);
          onChanged();
          return;
        }
        toast.error(shown.text);
        if (shown.conflicts !== null) onConflicts(shown.conflicts);
      },
      (error: unknown) => {
        const info = decodeIpcError(error);
        console.warn('[parley] worktrees.merge', info.code, info.message);
        toast.error(errorText(info.code, S.errors.actions.merge));
      },
    );
  };

  const press = (): void => {
    switch (action.kind) {
      case 'commit':
        if (message.trim() === '') return;
        if (working || unsaved.length > 0) setConfirm('commit');
        else commit();
        return;
      case 'commit-project':
        if (message.trim() !== '') setConfirm('commit');
        return;
      case 'merge':
        if (source.kind === 'worktree' && source.diff.baseCheckout === null) {
          // Ветка базы нигде не выгружена: хост откажет наверняка — без вопроса и без вызова.
          toast.error(mergeResultText({ ok: false, reason: 'base_not_checked_out', files: [] }, action.base).text);
          return;
        }
        setConfirm('merge');
        return;
      case 'ask-agent':
        setAskOpen(true);
        return;
      case 'nothing':
        return;
    }
  };

  const withMessage = action.kind === 'commit' || action.kind === 'commit-project';
  const label =
    action.kind === 'commit'
      ? S.changes.commit
      : action.kind === 'commit-project'
        ? S.changes.commitProject
        : action.kind === 'merge'
          ? S.changes.mergeInto(action.base)
          : action.kind === 'ask-agent'
            ? S.changes.askAgent
            : S.changes.noChanges;
  const disabled = action.kind === 'nothing' || (withMessage && (message.trim() === '' || busy));

  const commitDescription = sentences(
    source.kind === 'project' ? S.changes.projectFolderWarning : null,
    agentLine,
    unsaved.length > 0 ? S.changes.unsavedFiles(unsaved.length) : null,
  );
  // Заголовок вопроса коммита: ветка worktree или «master (project folder)».
  const commitTarget = source.kind === 'worktree' ? source.branch : source.kind === 'project' ? S.changes.projectFolder(source.changes.branch) : '';

  return (
    <div className="flex shrink-0 flex-col gap-2 px-1 pb-2 pt-1">
      {withMessage ? (
        <Textarea
          className="min-h-[52px] resize-y text-xs"
          placeholder={S.changes.commitMessagePlaceholder}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              press();
            }
          }}
        />
      ) : null}
      <Button type="button" size="sm" className="w-full min-w-0" disabled={disabled} title={label} onClick={press}>
        <span className="truncate">{label}</span>
      </Button>

      <ConfirmDialog
        open={confirm === 'commit'}
        title={S.changes.commitConfirmTitle(commitTarget)}
        {...(commitDescription === '' ? null : { description: commitDescription })}
        {...(unsaved.length === 0
          ? { confirmLabel: label, onConfirm: commit }
          : { confirmLabel: S.changes.saveAllAndCommit, onConfirm: saveAllAndCommit, secondary: { label: S.changes.commitAnyway, onSelect: commit } })}
        confirmVariant="default"
        onOpenChange={(next) => setConfirm(next ? 'commit' : null)}
      />
      {source.kind === 'worktree' ? (
        <ConfirmDialog
          open={confirm === 'merge'}
          title={S.changes.mergeConfirmTitle(source.branch, source.base)}
          description={sentences(
            S.changes.mergeConfirmDescription(
              source.diff.commits.length,
              source.diff.stats.additions,
              source.diff.stats.deletions,
              source.base,
              source.diff.baseCheckout ?? '',
            ),
            agentLine,
          )}
          confirmLabel={label}
        confirmVariant="default"
          onConfirm={merge}
          onOpenChange={(next) => setConfirm(next ? 'merge' : null)}
        />
      ) : null}
      {action.kind === 'ask-agent' && source.kind === 'worktree' ? (
        <AskAgentDialog
          open={askOpen}
          sessionRef={sessionRef}
          initialText={askAgentText(source.branch, source.base, action.files)}
          sendDeps={sendDeps}
          onOpenChange={setAskOpen}
        />
      ) : null}
    </div>
  );
}
