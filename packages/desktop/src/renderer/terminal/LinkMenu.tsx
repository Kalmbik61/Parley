/**
 * Меню ссылки терминала у курсора (кусок 5.3, спека 8.3). Путь: «Open in editor» (у файла, не
 * у каталога — кусок 7.3b), «Open in default app», «Reveal in Finder», «Copy path». Адрес:
 * «Open in browser» — вкладка встроенного браузера (9.2b), «Open in system browser» и «Copy link».
 *
 * Действия вынесены функциями: ⌘-клик по ссылке (`TerminalSurface`) зовёт их сразу, без
 * меню. Отказ main показывается тостом по коду, текст ошибки (`shell.openPath` на русской
 * macOS локализован) — только в консоль.
 */

import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { openInBrowserTab } from '../browser/store.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { useFilesStore } from '../files/store.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab } from '../layout/tree.js';
import type { TerminalLink } from './links.js';

export interface LinkMenuState {
  link: TerminalLink;
  /** Точка клика в координатах окна. */
  x: number;
  y: number;
}

function failureToast(error: unknown, action: string): void {
  console.warn('[parley] terminal link', error);
  const { code } = decodeIpcError(error);
  toast(code === 'files:denied' ? S.files.denied : errorText(code, action));
}

function copy(text: string): void {
  navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[parley] clipboard', error));
}

/** «Open in default app»: main открывает только белый список, остальное показывает в Finder. */
export async function openLinkPath(bridge: ParleyBridge, absPath: string): Promise<void> {
  try {
    const outcome = await bridge.app.openPath(absPath);
    if (outcome === 'revealed') toast(S.files.revealedInFinder);
  } catch (error) {
    failureToast(error, S.errors.actions.openFile);
  }
}

export async function revealLinkPath(bridge: ParleyBridge, absPath: string): Promise<void> {
  try {
    await bridge.app.showInFinder(absPath);
  } catch (error) {
    failureToast(error, S.errors.actions.revealInFinder);
  }
}

/**
 * «Open in editor» (кусок 7.3b): вкладка `file` по корню и относительному пути из `files.locate`
 * (5.3), затем курсор на строку и колонку. У `TabSpec` вида `file` строки нет, а `openTab` уже
 * открытой вкладки её только фокусирует — позиция идёт разовой `revealAt`.
 */
export function openLinkInEditor(link: Extract<TerminalLink, { kind: 'path' }>): void {
  const { root, relPath } = link.located;
  const tab = { kind: 'file' as const, id: tabId.file(root.spec, relPath), root: root.spec, path: relPath };
  useLayoutStore.getState().apply(root.workKey, (layout) => openTab(layout, tab));
  if (link.line !== undefined) useFilesStore.getState().revealAt(root.workKey, tab.id, link.line, link.col ?? 1);
}

/** Путь ведёт на файл — его открывает редактор; каталог — приложение по умолчанию. */
export function isFileLink(link: Extract<TerminalLink, { kind: 'path' }>): boolean {
  return link.located.stat.kind === 'file';
}

/** Системный браузер — только http(s): провайдер других ссылок не даёт, main проверяет ещё раз. */
export function openLinkUrl(bridge: ParleyBridge, url: string): void {
  bridge.app.openExternal(url).catch((error: unknown) => console.warn('[parley] openExternal', error));
}

export interface LinkMenuProps {
  bridge: ParleyBridge;
  state: LinkMenuState;
  onClose(): void;
}

export function LinkMenu({ bridge, state, onClose }: LinkMenuProps): JSX.Element {
  const { link } = state;
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* Невидимый якорь в точке клика: меню встаёт у курсора, а не у элемента. */}
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: state.x, top: state.y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="terminal-link-menu">
        {link.kind === 'path' ? (
          <>
            {isFileLink(link) ? <DropdownMenuItem onSelect={() => openLinkInEditor(link)}>{S.links.openInEditor}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => void openLinkPath(bridge, link.absPath)}>{S.links.openInDefaultApp}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void revealLinkPath(bridge, link.absPath)}>{S.cardMenu.reveal}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy(link.absPath)}>{S.cardMenu.copyPath}</DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => openInBrowserTab(link.url)}>{S.links.openInBrowser}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openLinkUrl(bridge, link.url)}>{S.links.openInSystemBrowser}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy(link.url)}>{S.links.copyLink}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
