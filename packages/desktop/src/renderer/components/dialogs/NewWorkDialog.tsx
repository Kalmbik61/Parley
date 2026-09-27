/**
 * Новая работа: каталог, заголовок, цель → `works.create` (кусок 1.10 плана
 * окна). Кусок 1.4 плана «облик Orca» — примитивы `ui/dialog`, `ui/input`,
 * `ui/textarea`, `ui/button` вместо голого Radix и токенов старой палитры.
 */

import { useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Textarea } from '../../ui/textarea.js';

export interface NewWorkDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  onOpenChange: (open: boolean) => void;
}

export function NewWorkDialog({ open, bridge, onOpenChange }: NewWorkDialogProps): JSX.Element {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [title, setTitle] = useState(S.dialogs.newWork.title);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chooseFolder = async (): Promise<void> => {
    const dir = await bridge.app.chooseFolder();
    if (dir !== null) setProjectPath(dir);
  };

  const submit = async (): Promise<void> => {
    if (projectPath === null) {
      setError(S.dialogs.newWork.selectFolderRequired);
      return;
    }
    setError(null);
    try {
      await bridge.call('works.create', { projectPath, title, goal });
      onOpenChange(false);
      setProjectPath(null);
      setTitle(S.dialogs.newWork.title);
      setGoal('');
    } catch (err) {
      console.warn('[harnas] works.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createWorkspace));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>{S.dialogs.newWork.title}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <Button type="button" variant="outline" className="justify-start truncate font-normal" onClick={() => void chooseFolder()}>
            {projectPath ?? S.dialogs.newWork.chooseFolderPlaceholder}
          </Button>
          <label className="flex flex-col gap-1">
            {S.dialogs.newWork.titleField}
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            {S.dialogs.newWork.goalField}
            <Textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
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
            {S.common.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
