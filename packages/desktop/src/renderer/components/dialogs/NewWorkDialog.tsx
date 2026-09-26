/** Новая работа: каталог, заголовок, цель → `works.create` (кусок 1.10 плана окна). */

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { HarnasBridge } from '../../../shared/bridge.js';

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--h-base)] p-4 text-[var(--h-text)] shadow-lg">
          <Dialog.Title className="text-sm font-medium">Новая работа</Dialog.Title>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="truncate rounded border border-[var(--h-overlay)] px-2 py-1 text-left"
            >
              {projectPath ?? 'Выбрать каталог…'}
            </button>
            <label className="flex flex-col gap-1">
              Заголовок
              <input
                className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              Цель
              <textarea
                className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            {error !== null ? <p className="text-[var(--h-red)]">{error}</p> : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="rounded px-3 py-1 text-[var(--h-subtext)]">
                Отмена
              </button>
            </Dialog.Close>
            <button type="button" className="rounded bg-[var(--h-blue)] px-3 py-1 text-[var(--h-base)]" onClick={() => void submit()}>
              Создать
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
