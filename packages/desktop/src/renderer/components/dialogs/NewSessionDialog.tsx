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
 */

import { useEffect, useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { Textarea } from '../../ui/textarea.js';

interface ProviderOption {
  id: string;
  label: string;
  available: boolean;
}

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
        const firstAvailable = result.providers.find((item) => item.available);
        setProvider((current) => (current !== '' ? current : (firstAvailable ?? result.providers[0])?.id ?? ''));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
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
      setError('нет выбранной работы');
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
      onOpenChange(false);
      setLabel('');
      setTask('');
      setChildOfSelected(false);
      setWorktree(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>Новая сессия</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger>
              <SelectValue placeholder="провайдер…" />
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
            Ярлык
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Задача
            <Textarea
              placeholder="пусто — тихий старт, задачу агент получит первым сообщением"
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
            дочерняя выбранной
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={worktree} disabled={!worktreeAvailable} onCheckedChange={setWorktree} />
            в своём worktree
          </label>
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Отмена
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void submit()}>
            Запустить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
