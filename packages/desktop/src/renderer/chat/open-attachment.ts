/**
 * Клик по миниатюре вложения (пузырь промпта «Chat», сообщение человека в комнате). Картинка в корне работы
 * (`files.locate`) открывается вкладкой файла — просмотр `files/preview/ImagePreview`. Вне корней (скриншоты в `drops/`,
 * файлы из Finder) вкладку файла main не откроет: она читает только корни работы, — тогда диалог просмотра ленты
 * (`ImagePreview.tsx`), как у картинок из результата инструмента.
 *
 * Мост и работу даёт `FilePathLinksContext` (вид «Chat», комната, почта); диалог — `ImagePreviewHost`.
 */

import { useContext } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { FilePathLinksContext } from '../components/rooms/FilePathText.js';
import { openLinkInEditor } from '../terminal/LinkMenu.js';
import { useOpenImagePreview, type ImagePreviewTarget } from './ImagePreview.js';

export interface OpenAttachmentDeps {
  bridge: ParleyBridge;
  workKey: string;
  /** Диалог просмотра; `null` — хоста нет, картинка вне корней не откроется. */
  openPreview: ReturnType<typeof useOpenImagePreview>;
}

export async function openAttachmentImage(
  deps: OpenAttachmentDeps,
  target: ImagePreviewTarget,
  opener: HTMLElement | null,
): Promise<void> {
  const [hit] = await deps.bridge.files.locate(deps.workKey, [target.path]).catch(() => [null]);
  if (hit !== null && hit !== undefined && hit.root.workKey === deps.workKey && hit.stat.kind === 'file') {
    openLinkInEditor({ kind: 'path', absPath: target.path, located: hit });
    return;
  }
  deps.openPreview?.(target, opener);
}

/** Открыть вложение-картинку; `null` — окружения нет, миниатюра остаётся картинкой, а не кнопкой. */
export function useOpenAttachmentImage(): ((target: ImagePreviewTarget, opener: HTMLElement) => void) | null {
  const env = useContext(FilePathLinksContext);
  const openPreview = useOpenImagePreview();
  if (env === null) return null;
  return (target, opener) => void openAttachmentImage({ bridge: env.bridge, workKey: env.workKey, openPreview }, target, opener);
}
