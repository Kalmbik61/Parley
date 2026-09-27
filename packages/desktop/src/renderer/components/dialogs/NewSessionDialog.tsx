/**
 * Новая сессия (⌘T): провайдер из `providers.list` (недоступный — неактивен),
 * ярлык, задача (пустая — тихий старт) и «дочерняя выбранной» → `sessions.create`
 * (кусок 1.10 плана окна). Кусок 1.4 плана «облик Orca» — примитивы
 * `ui/dialog`, `ui/select`, `ui/input`, `ui/textarea`, `ui/switch`, `ui/button`
 * вместо голого Radix и токенов старой палитры.
 *
 * «В своём worktree» (кусок 4.3 плана worktree, спека 5.1): неактивен, пока
 * `worktrees.available` не подтвердит, что проект — git-репозиторий. `branches`
 * из сайдбара для этого не годится — при отсоединённой голове ветки нет и у
 * git-проекта, а `worktrees.available` смотрит именно на `git rev-parse
 * --is-inside-work-tree`, не на текущую ветку.
 *
 * Кусок 3.5: агент по умолчанию — то же правило, что у формы новой работы
 * (`lib/default-provider.ts`), и созданная сессия запоминает его в `ui.json.lastProvider`.
 */

import { useEffect, useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { defaultProvider, type ProviderOption } from '../../lib/default-provider.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { Textarea } from '../../ui/textarea.js';

export interface NewSessionDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  projectPath: string;
  workId: string | null;
  /** Выбранная в сайдбаре сессия — кандидат в родители при включённом флажке. */
  selectedSessionId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function NewSessionDialog({
  open,
  bridge,
  projectPath,
  workId,
  selectedSessionId,
  onOpenChange,
}: NewSessionDialogProps): JSX.Element {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [task, setTask] = useState('');
  const [childOfSelected, setChildOfSelected] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    bridge
      .call('providers.list', {})
      .then((result) => {
        setProviders(result.providers);
        // Каждое открытие — заново по правилу: прошлый выбор уже лежит в `lastProvider`.
        setProvider(defaultProvider(result.providers, useUiStore.getState().ui.lastProvider) ?? '');
      })
      .catch((err: unknown) => {
        console.warn('[harnas] providers.list', err);
        setError(errorText(decodeIpcError(err).code, S.errors.actions.loadProviders));
      });
  }, [open, bridge]);

  useEffect(() => {
    if (!open) {
      setWorktreeAvailable(false);
      setWorktree(false);
      return;
    }
    bridge
      .call('worktrees.available', { projectPath })
      .then((result) => setWorktreeAvailable(result.available))
      .catch(() => setWorktreeAvailable(false));
  }, [open, bridge, projectPath]);

  const submit = async (): Promise<void> => {
    if (workId === null) {
      setError(S.dialogs.newSession.selectWorkRequired);
      return;
    }
    setError(null);
    try {
      await bridge.call('sessions.create', {
        projectPath,
        workId,
        provider,
        label,
        task,
        parent: childOfSelected ? selectedSessionId : null,
        worktree,
      });
      useUiStore.getState().patchUi({ lastProvider: provider });
      onOpenChange(false);
      setLabel('');
      setTask('');
      setChildOfSelected(false);
      setWorktree(false);
    } catch (err) {
      console.warn('[harnas] sessions.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createSession));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>{S.dialogs.newSession.title}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger>
              <SelectValue placeholder={S.dialogs.newSession.providerPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((item) => (
                <SelectItem key={item.id} value={item.id} disabled={!item.available}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex flex-col gap-1">
            {S.dialogs.newSession.labelField}
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            {S.dialogs.newSession.taskField}
            <Textarea
              placeholder={S.dialogs.newSession.taskPlaceholder}
              value={task}
              onChange={(event) => setTask(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={childOfSelected}
              disabled={selectedSessionId === null}
              onCheckedChange={setChildOfSelected}
            />
            {S.dialogs.newSession.childOfSelected}
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={worktree} disabled={!worktreeAvailable} onCheckedChange={setWorktree} />
            {S.dialogs.newSession.inOwnWorktree}
          </label>
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void submit()}>
            {S.dialogs.newSession.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
