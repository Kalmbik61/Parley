/**
 * Вопрос «Сохранить / Не сохранять / Отмена» (кусок 7.3a, спека 10.4): закрытие вкладки файла с
 * несохранённым буфером и — «Save all» — закрытие окна и ⌘Q. Один на окно, смонтирован в
 * `AppShell`; спрашивают через `askSaveChanges`, ответ — промисом. Вопросы в очереди: закрытие
 * нескольких вкладок спрашивает по одной, а вопрос окна может прийти, пока открыт вопрос вкладки.
 *
 * Закрыть диалог мимо кнопок (Esc, щелчок мимо) — «Отмена»: ничего не записано и не отброшено.
 * Имена файлов — данные: длинное имя обрезано многоточием, полное — в `title`.
 */

import { useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { answerWindowClose, type SaveAnswer } from './close-guard.js';
import { dirtyBufferRefs, useFilesStore } from './store.js';

interface SaveChangesRequest {
  /** `tab` — одна вкладка («Save»); `window` — все грязные буферы окна («Save all»). */
  mode: 'tab' | 'window';
  names: string[];
  resolve: (answer: SaveAnswer) => void;
}

const useSaveChangesStore = create<{ queue: SaveChangesRequest[] }>(() => ({ queue: [] }));

/** Задать вопрос; ответ — когда человек нажмёт кнопку (или закроет диалог — `cancel`). */
export function askSaveChanges(mode: 'tab' | 'window', names: string[]): Promise<SaveAnswer> {
  return new Promise((resolve) => {
    useSaveChangesStore.setState((state) => ({ queue: [...state.queue, { mode, names, resolve }] }));
  });
}

function answerFirst(answer: SaveAnswer): void {
  const [first, ...rest] = useSaveChangesStore.getState().queue;
  if (first === undefined) return;
  useSaveChangesStore.setState({ queue: rest });
  first.resolve(answer);
}

function titleOf(request: SaveChangesRequest): string {
  if (request.names.length === 1) return S.files.saveChanges(request.names[0] ?? '');
  return S.files.saveChangesCount(request.names.length);
}

export function SaveChangesDialog(): JSX.Element | null {
  const request = useSaveChangesStore((state) => state.queue[0] ?? null);
  if (request === null) return null;
  const title = titleOf(request);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answerFirst('cancel');
      }}
    >
      <DialogContent
        data-testid="save-changes-dialog"
        // Описание — только список файлов окна; без него Radix не должен ждать `aria-describedby`.
        {...(request.names.length > 1 ? null : { 'aria-describedby': undefined })}
        className="w-96 max-w-[calc(100vw-2rem)]"
      >
        <DialogTitle className="truncate pr-6" title={title}>
          {title}
        </DialogTitle>
        {request.names.length > 1 ? (
          <DialogDescription asChild>
            <ul className="max-h-40 min-w-0 overflow-y-auto text-sm text-muted-foreground">
              {request.names.map((name, index) => (
                // Имена бывают одинаковыми (a.ts двух корней): ключ — позиция.
                <li key={index} className="truncate" title={name}>
                  {name}
                </li>
              ))}
            </ul>
          </DialogDescription>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answerFirst('cancel')}>
            {S.common.cancel}
          </Button>
          <Button type="button" variant="outline" onClick={() => answerFirst('discard')}>
            {S.files.dontSave}
          </Button>
          <Button type="button" onClick={() => answerFirst('save')}>
            {request.mode === 'window' ? S.files.saveAll : S.files.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Вопрос при закрытии окна и ⌘Q (решение контролёра по сверке этапа 7): main отложил закрытие
 * (`app:confirm-close`), окно спрашивает по всем грязным буферам и отвечает `app:close-answer`.
 * Смонтирован всегда, пока открыто окно, — и в оболочке, и на экранах связи `App`: буферы
 * переживают потерю связи с хостом, и main без ответа не закрыл бы окно вовсе.
 */
export function WindowCloseQuestion({ bridge }: { bridge: HarnasBridge }): JSX.Element {
  useEffect(
    () =>
      bridge.app.onConfirmClose(() => {
        void answerWindowClose({
          dirty: dirtyBufferRefs,
          ask: (names) => askSaveChanges('window', names),
          save: async (workKey, tabId) => (await useFilesStore.getState().save(bridge, workKey, tabId)) === 'saved',
          toast: (text) => toast(text),
        }).then((answer) => bridge.app.answerClose(answer));
      }),
    [bridge],
  );
  return <SaveChangesDialog />;
}
