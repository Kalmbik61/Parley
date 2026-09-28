/**
 * Тело вкладки `file` (кусок 7.3b, спека 10.4, 10.5, 13): Monaco над буфером стора
 * (`files/store.ts`). Тело к буферу только подключается — `openBuffer` повтором ничего не
 * делает, — поэтому текст, курсор и прокрутка переживают смену вкладки, перенос в другую группу
 * и вытеснение работы из LRU.
 *
 * Правки человека и агента молча не теряются: ⌘S пишет с `expectedMtimeMs` буфера, ответ
 * `conflict` и «Keep mine» перед записью спрашивают «Overwrite / Compare / Cancel», изменение на
 * диске при правках — баннер (`DiskChangeBanner`), решение за человеком.
 *
 * Monaco грузится лениво (`lazy`): окно без открытых файлов его не тянет, а сбой загрузки чанка
 * ловит та же граница ошибки, что и отказ `loader.init()` и бросок редактора: «Editor didn't
 * load», «Retry» и «Open in default app» (спека 13). Граница `GroupView` — запасная.
 */

import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import type { FileRoot } from '../../../shared/files-types.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import type { TabSpec } from '../../../shared/layout-types.js';
import { errorText, S } from '../../../shared/strings.js';
import { rootKey } from '../../../shared/work-keys.js';
import { ErrorBoundary } from '../../shell/ErrorBoundary.js';
import { openLinkPath, revealLinkPath } from '../../terminal/LinkMenu.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { bufferKey, bufferView, RELOADED_FLASH_MS, type BufferModel } from '../buffer.js';
import { absPathOf, useFilesStore } from '../store.js';
import { DiskChangeBanner } from './DiskChangeBanner.js';

const MonacoEditor = lazy(async () => ({ default: (await import('./MonacoEditor.js')).MonacoEditor }));
const CompareView = lazy(async () => ({ default: (await import('./CompareView.js')).CompareView }));

/** Запасной шрифт до конфигурации терминала — как у терминала в `App.tsx`. */
const FALLBACK_FONT = { family: 'Menlo, monospace', size: 13 };

export interface FileBodyProps {
  bridge: HarnasBridge;
  workKey: string;
  entry: WorkEntry;
  tab: Extract<TabSpec, { kind: 'file' }>;
  onClose(): void;
  /** Шрифт терминала (дополнение плана): редактору — он же минус 1 (спека 10.4). */
  font?: { family: string; size: number };
}

/** Номер буфера для пути модели: у двух работ одного проекта id вкладки одинаковый. */
const modelIds = new Map<string, number>();

/**
 * Путь модели Monaco: язык — по имени файла в конце, а каталог свой у каждого буфера — общая
 * модель смешала бы правки двух вкладок. Только простые символы: с `%`-кодами в пути (пробел,
 * `:` id вкладки) воркер TS не находил модель — «Could not find source file» на собранном окне.
 * Имя с прочими символами сводится к `file.<расширение>`: языку хватает расширения.
 */
function modelPath(kind: string, key: string, path: string): string {
  let id = modelIds.get(key);
  if (id === undefined) {
    id = modelIds.size + 1;
    modelIds.set(key, id);
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const safe = /^[A-Za-z0-9._-]+$/.test(name) ? name : /^[A-Za-z0-9]+$/.test(extension) ? `file.${extension}` : 'file';
  return `file:///harnas/${kind}/${id}/${safe}`;
}

function Message({ text, children }: { text: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      <p className="max-w-full break-words">{text}</p>
      {children}
    </div>
  );
}

/** Тело по коду отказа `readText` (спека 10.4 и 13): кодов `files:*` `errorText` не знает. */
function ErrorBody({ code, onClose, onReveal }: { code: string; onClose(): void; onReveal(): void }): JSX.Element {
  const closeButton = (
    <Button type="button" size="sm" onClick={onClose}>
      {S.common.close}
    </Button>
  );
  if (code === 'not_found') return <Message text={S.files.notFound}>{closeButton}</Message>;
  // Worktree удалён при открытой вкладке: `pruneLayout` чистит раскладку только при восстановлении.
  if (code === 'files:denied') return <Message text={S.files.rootGone}>{closeButton}</Message>;
  if (code === 'files:too-large') {
    return (
      <Message text={S.files.tooLarge}>
        <Button type="button" size="sm" onClick={onReveal}>
          {S.cardMenu.reveal}
        </Button>
      </Message>
    );
  }
  return <Message text={errorText(code, S.errors.actions.openFile)}>{closeButton}</Message>;
}

/** Плашка шапки тела: только чтение по коду и «Reloaded from disk» на 2 с. */
function useReloadedFlash(model: BufferModel | null): boolean {
  const [, tick] = useState(0);
  const reloadedAt = model?.reloadedAt ?? null;
  useEffect(() => {
    if (reloadedAt === null) return;
    const left = reloadedAt + RELOADED_FLASH_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => tick((value) => value + 1), left);
    return () => clearTimeout(timer);
  }, [reloadedAt]);
  return model !== null && bufferView(model, Date.now()).reloadedFlash;
}

export function FileBody({ bridge, workKey, entry, tab, onClose, font = FALLBACK_FONT }: FileBodyProps): JSX.Element {
  const key = bufferKey(workKey, tab.id);
  const root: FileRoot = { workKey, spec: tab.root };
  const rootId = rootKey(root);
  const model = useFilesStore((state) => state.buffers[key]?.model ?? null);
  const reveal = useFilesStore((state) => state.reveals[key] ?? null);
  const [comparing, setComparing] = useState<{ disk: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const reloadedFlash = useReloadedFlash(model);

  useEffect(() => {
    // Повтор для перемонтированного тела ничего не делает: буфер уже в сторе.
    useFilesStore.getState().openBuffer(bridge, workKey, tab.id, root, tab.path);
    // Корень — в `rootId`: объект `root` новый на каждую отрисовку.
  }, [bridge, workKey, tab.id, rootId, tab.path]);

  const absPath = absPathOf(entry, tab.root, tab.path);
  const openDefault = (): void => {
    if (absPath !== null) void openLinkPath(bridge, absPath);
  };
  const revealInFinder = (): void => {
    if (absPath !== null) void revealLinkPath(bridge, absPath);
  };

  const save = useCallback(
    async (overwrite: boolean): Promise<void> => {
      const current = useFilesStore.getState().buffers[key]?.model;
      if (current === undefined || current.readOnlyReason !== null || current.binary) return;
      // «Keep mine» (7.3a): диск изменился, человек оставил свои правки — перед записью спросить.
      if (!overwrite && bufferView(current, Date.now()).confirmOverwrite) {
        setAsking(true);
        return;
      }
      const result = await useFilesStore.getState().save(bridge, workKey, tab.id, overwrite ? { overwrite: true } : {});
      if (result === 'conflict') setAsking(true);
      else if (result === 'saved') setComparing(null);
      else {
        const code = useFilesStore.getState().buffers[key]?.model.errorCode ?? 'failed';
        toast(code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.saveFile));
      }
    },
    [bridge, key, workKey, tab.id],
  );

  const compare = async (): Promise<void> => {
    setAsking(false);
    try {
      const file = await bridge.files.readText(root, tab.path);
      setComparing({ disk: file.text });
    } catch (error) {
      console.warn('[harnas] files.readText', error);
      const { code } = decodeIpcError(error);
      if (code === 'not_found') useFilesStore.getState().dispatch(key, { type: 'disk-deleted' });
      else toast(code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.openFile));
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const file = await bridge.files.readText(root, tab.path);
      useFilesStore.getState().dispatch(key, { type: 'reloaded', file, at: Date.now() });
      setComparing(null);
    } catch (error) {
      console.warn('[harnas] files.readText', error);
      const { code } = decodeIpcError(error);
      if (code === 'not_found') useFilesStore.getState().dispatch(key, { type: 'disk-deleted' });
      else toast(code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.openFile));
    }
  };

  const keepMine = (): void => {
    useFilesStore.getState().dispatch(key, { type: 'keep-mine' });
    setComparing(null);
  };

  const onRevealed = useCallback(() => void useFilesStore.getState().takeReveal(key), [key]);
  const onChange = useCallback((text: string) => useFilesStore.getState().dispatch(key, { type: 'edited', text }), [key]);
  const onSave = useCallback(() => void save(false), [save]);

  if (model === null || model.status === 'loading') return <div className="h-full" />;
  if (model.status === 'error') return <ErrorBody code={model.errorCode ?? 'failed'} onClose={onClose} onReveal={revealInFinder} />;
  if (model.binary) {
    // Картинки и PDF превью покажет 7.5.
    return (
      <Message text={S.files.binary}>
        <Button type="button" size="sm" onClick={openDefault}>
          {S.links.openInDefaultApp}
        </Button>
      </Message>
    );
  }

  const readOnlyText =
    model.readOnlyReason === 'too-large' ? S.files.readOnlyTooLarge : model.readOnlyReason === 'not-utf8' ? S.files.readOnlyNotUtf8 : null;
  const plaque = reloadedFlash ? S.files.reloadedFromDisk : readOnlyText;
  const fallback = <div className="h-full" />;

  return (
    <div data-testid="file-body" className="flex h-full min-h-0 min-w-0 flex-col">
      {plaque === null ? null : (
        <div data-testid="file-plaque" className="shrink-0 truncate border-b border-border px-3 py-1 text-xs text-muted-foreground" title={plaque}>
          {plaque}
        </div>
      )}
      <DiskChangeBanner
        model={model}
        comparing={comparing !== null}
        onReload={() => void reload()}
        onCompare={() => void compare()}
        onKeepMine={keepMine}
        onSaveAgain={() => void save(false)}
        onClose={onClose}
      />
      {comparing === null ? null : (
        <div className="flex shrink-0 items-center justify-end border-b border-border px-2 py-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setComparing(null)}>
            {S.common.close}
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <ErrorBoundary title={S.files.editorFailed} actions={[{ label: S.links.openInDefaultApp, onClick: openDefault }]}>
          <Suspense fallback={fallback}>
            {comparing !== null ? (
              <CompareView
                original={comparing.disk}
                modified={model.text}
                modelPaths={{ original: modelPath('disk', key, tab.path), modified: modelPath('compare', key, tab.path) }}
                fontFamily={font.family}
                fontSize={font.size}
              />
            ) : (
              <MonacoEditor
                viewStateKey={key}
                modelPath={modelPath('buffer', key, tab.path)}
                text={model.text}
                readOnly={model.readOnlyReason !== null}
                fontFamily={font.family}
                fontSize={font.size}
                reveal={reveal}
                onRevealed={onRevealed}
                onChange={onChange}
                onSave={onSave}
              />
            )}
          </Suspense>
        </ErrorBoundary>
      </div>
      <Dialog open={asking} onOpenChange={(open) => (open ? undefined : setAsking(false))}>
        <DialogContent aria-describedby={undefined} className="w-96 max-w-[calc(100vw-2rem)]">
          <DialogTitle className="pr-6">{S.files.overwriteQuestion}</DialogTitle>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              {S.common.cancel}
            </Button>
            <Button type="button" variant="outline" onClick={() => void compare()}>
              {S.files.compare}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setAsking(false);
                void save(true);
              }}
            >
              {S.files.overwrite}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
