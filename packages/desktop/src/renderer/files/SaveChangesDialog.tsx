/**
 * Вопрос «Сохранить / Не сохранять / Отмена» (кусок 7.3a, спека 10.4): закрытие вкладки файла с
 * несохранённым буфером и — «Save all» — закрытие окна и ⌘Q. Один на окно, смонтирован в
 * `AppShell`; спрашивают через `askSaveChanges`, ответ — промисом. Вопросы в очереди: закрытие
 * нескольких вкладок спрашивает по одной, а вопрос окна может прийти, пока открыт вопрос вкладки.
 *
 * Закрыть диалог мимо кнопок (Esc, щелчок мимо) — «Отмена»: ничего не записано и не отброшено.
 * Имена файлов — данные: длинное имя обрезано многоточием, полное — в `title`.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { flushNoteSaves, useNotesStore } from '../review/notes/store.js';
import { answerVanishedWork, answerWindowClose, type SaveAnswer } from './close-guard.js';
import { dirtyBufferKeys, dirtyBufferRefs, useFilesStore, type FilesState } from './store.js';

interface SaveChangesRequest {
  /**
   * `tab` — одна вкладка («Save»); `window` — все грязные буферы окна («Save all»); `vanished` —
   * работа удалена не из этого окна: только «Save» и «Discard», закрыть мимо кнопок нельзя.
   */
  mode: 'tab' | 'window' | 'vanished';
  names: string[];
  /** Название исчезнувшей работы — для `vanished`. */
  work?: string;
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

/** Вопрос по работе, удалённой не из этого окна (fix-7.3 п. 1): отмены нет — «Save» или «Discard». */
function askVanished(work: string, names: string[]): Promise<'save' | 'discard'> {
  return new Promise((resolve) => {
    const request: SaveChangesRequest = { mode: 'vanished', names, work, resolve: (answer) => resolve(answer === 'save' ? 'save' : 'discard') };
    useSaveChangesStore.setState((state) => ({ queue: [...state.queue, request] }));
  });
}

/**
 * Работа ушла из снимка: есть грязные буферы её вкладок — вопрос, промис ответа (записи сделаны);
 * нет — null, и раскладку можно снять сразу, как прежде.
 */
export function settleVanishedWork(bridge: ParleyBridge, workKey: string, title: string): Promise<void> | null {
  const dirty = dirtyBufferRefs().filter((item) => item.workKey === workKey);
  if (dirty.length === 0) return null;
  return answerVanishedWork({
    dirty,
    ask: (names) => askVanished(title, names),
    save: async (key, tabId) => (await useFilesStore.getState().save(bridge, key, tabId)) === 'saved',
    toast: (text) => toast(text),
  });
}

function titleOf(request: SaveChangesRequest): string {
  if (request.mode === 'vanished') return S.files.workDeleted(request.work ?? '', request.names.length);
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
        // Удаление работы не отменить: Esc и щелчок мимо не отбрасывают её правки молча.
        if (!open && request.mode !== 'vanished') answerFirst('cancel');
      }}
    >
      <DialogContent
        data-testid="save-changes-dialog"
        // Описание — только список файлов окна; без него Radix не должен ждать `aria-describedby`.
        {...(request.names.length > 1 || request.mode === 'vanished' ? null : { 'aria-describedby': undefined })}
        className="w-96 max-w-[calc(100vw-2rem)]"
      >
        <DialogTitle className="truncate pr-6" title={title}>
          {title}
        </DialogTitle>
        {request.names.length > 1 || request.mode === 'vanished' ? (
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
          {request.mode === 'vanished' ? null : (
            <Button type="button" variant="ghost" onClick={() => answerFirst('cancel')}>
              {S.common.cancel}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => answerFirst('discard')}>
            {request.mode === 'vanished' ? S.files.discard : S.files.dontSave}
          </Button>
          <Button type="button" onClick={() => answerFirst('save')}>
            {/* Один файл — единственное число и у кнопки (fix-7.3 п. 5). */}
            {request.mode === 'window' && request.names.length > 1 ? S.files.saveAll : S.files.save}
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
export function WindowCloseQuestion({ bridge }: { bridge: ParleyBridge }): JSX.Element {
  /**
   * Буферы, по которым человек ответил «закрыть» («Don't save»): выгрузку с ними страница больше не
   * отменяет — main закрывает окно или повторяет перезагрузку. Сверка по ссылке: любая правка после
   * ответа — новый объект `buffers`, и выгрузка снова отменяется.
   */
  const approved = useRef<FilesState['buffers'] | null>(null);
  useEffect(
    () =>
      bridge.app.onConfirmClose(() => {
        // Заметки к диффу — сначала и без вопроса (раунд fix-final-c, п. 2): их запись отложена на
        // 300 мс, и ответ «закрыть» до неё терял заметку или `sentAt`. Отказ записи — окно остаётся:
        // тост уже показан, следующее закрытие пройдёт (ждущих записей больше нет).
        void flushNoteSaves()
          .then((notesSaved) =>
            notesSaved
              ? answerWindowClose({
                  dirty: dirtyBufferRefs,
                  ask: (names) => askSaveChanges('window', names),
                  save: async (workKey, tabId) => (await useFilesStore.getState().save(bridge, workKey, tabId)) === 'saved',
                  toast: (text) => toast(text),
                })
              : ('cancel' as const),
          )
          .then((answer) => {
            approved.current = answer === 'close' ? useFilesStore.getState().buffers : null;
            bridge.app.answerClose(answer);
          });
      }),
    [bridge],
  );
  // Выгрузка без вопроса main (он не знал о ждущих записях) — последний шанс: запись уходит сразу.
  useEffect(() => {
    const onPageHide = (): void => void flushNoteSaves();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);
  // Перезагрузка страницы (fix-7.3 п. 4б) у main события не даёт: грязные буферы — выгрузка
  // отменяется, main узнаёт об этом (`will-prevent-unload`) и задаёт тот же вопрос, что при закрытии.
  useEffect(() => {
    const onBeforeUnload = (event: Event): void => {
      const { buffers } = useFilesStore.getState();
      // Ждущая запись заметок — тоже отмена: main спросит, ответ сбросит запись и повторит выгрузку.
      if ((buffers !== approved.current && dirtyBufferKeys(buffers).length > 0) || useNotesStore.getState().pendingSaves > 0) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  return <SaveChangesDialog />;
}
