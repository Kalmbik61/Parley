/**
 * Новая работа: каталог, заголовок, цель → `works.create` (кусок 1.10 плана
 * окна). Кусок 1.4 плана «облик Orca» — примитивы `ui/dialog`, `ui/input`,
 * `ui/textarea`, `ui/button` вместо голого Radix и токенов старой палитры.
 */

import { useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
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
  const [title, setTitle] = useState('Новая работа');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chooseFolder = async (): Promise<void> => {
    const dir = await bridge.app.chooseFolder();
    if (dir !== null) setProjectPath(dir);
  };

  const submit = async (): Promise<void> => {
    if (projectPath === null) {
      setError('выберите каталог проекта');
      return;
    }
    setError(null);
    try {
      await bridge.call('works.create', { projectPath, title, goal });
      onOpenChange(false);
      setProjectPath(null);
      setTitle('Новая работа');
      setGoal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>Новая работа</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <Button type="button" variant="outline" className="justify-start truncate font-normal" onClick={() => void chooseFolder()}>
            {projectPath ?? 'Выбрать каталог…'}
          </Button>
          <label className="flex flex-col gap-1">
            Заголовок
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Цель
            <Textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
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
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
