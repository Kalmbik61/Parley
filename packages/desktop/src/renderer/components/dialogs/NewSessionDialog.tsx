/**
 * Новая сессия (⌘T): провайдер из `providers.list` (недоступный — неактивен),
 * ярлык, задача (пустая — тихий старт) и «дочерняя выбранной» → `sessions.create`
 * (кусок 1.10 плана окна).
 */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import type { HarnasBridge } from '../../../shared/bridge.js';

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
      });
      onOpenChange(false);
      setLabel('');
      setTask('');
      setChildOfSelected(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--h-base)] p-4 text-[var(--h-text)] shadow-lg">
          <Dialog.Title className="text-sm font-medium">Новая сессия</Dialog.Title>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <Select.Root value={provider} onValueChange={setProvider}>
              <Select.Trigger className="flex items-center justify-between rounded border border-[var(--h-overlay)] px-2 py-1">
                <Select.Value placeholder="провайдер…" />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className="rounded-md bg-[var(--h-mantle)] p-1 shadow-lg">
                  <Select.Viewport>
                    {providers.map((item) => (
                      <Select.Item
                        key={item.id}
                        value={item.id}
                        disabled={!item.available}
                        className="cursor-default rounded px-2 py-1 data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--h-selection)]"
                      >
                        <Select.ItemText>{item.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
            <label className="flex flex-col gap-1">
              Ярлык
              <input
                className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              Задача
              <textarea
                className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
                placeholder="пусто — тихий старт, задачу агент получит первым сообщением"
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={childOfSelected}
                disabled={selectedSessionId === null}
                onChange={(event) => setChildOfSelected(event.target.checked)}
              />
              дочерняя выбранной
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
              Запустить
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
