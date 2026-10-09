/**
 * Картинки из результата инструмента под строкой вызова (скриншот MCP браузера, картинка, которую агент прочитал):
 * ряд миниатюр 160×120 по ссылкам `response.images`. Лента несёт ссылки на файлы, а не байты (файлы кладёт хост),
 * миниатюры берёт `app.imageThumbnail` через общий кэш `use-thumbnail.ts`. Клик по миниатюре только просит просмотр
 * (`useOpenImagePreview`): диалог держит `ImagePreviewHost` в `ChatView`, вне строк, — строку виртуальная лента может
 * размонтировать, пока человек смотрит картинку.
 *
 * Высота ряда не прыгает: пока миниатюра в пути, на её месте пустая рамка того же размера, а картинка, которой нет
 * (файл убрали, нет моста), — компактный значок «Image unavailable», без падения. Ряд — часть строки виртуальной ленты
 * (`FeedList` мерит строку `measureElement` и следит за ней `ResizeObserver`), поэтому его перенос по `flex-wrap`
 * в узком окне виден списку как рост строки: следующая строка сдвигается, а не накладывается.
 */

import { useContext } from 'react';
import { ImageIcon } from 'lucide-react';
import type { FeedImageRef } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { ChatEnvContext } from '../chat-env.js';
import { useOpenImagePreview } from '../ImagePreview.js';
import { useThumbnailState } from '../use-thumbnail.js';

/**
 * Рамка миниатюры: одна на кнопку и на пустую рамку, чтобы приход миниатюры не менял высоту строки ленты. Картинка
 * вписана в неё целиком (`object-contain`) на нейтральной подложке: скриншот 16:10 нельзя обрезать, его смотрят целиком.
 */
const FRAME = 'h-[120px] w-[160px] shrink-0 overflow-hidden rounded-md border border-border bg-muted';

export interface ToolImagesProps {
  images: readonly FeedImageRef[];
}

export function ToolImages({ images }: ToolImagesProps): JSX.Element {
  // Мост — только для миниатюр: `useChatEnv()` вне окружения бросает, а ряд без него рисуется значками.
  const bridge = useContext(ChatEnvContext)?.bridge ?? null;
  return (
    <div data-testid="chat-tool-images" className="flex flex-wrap items-start gap-2">
      {images.map((image, index) => (
        <ToolImage
          key={`${index}:${image.path}`}
          path={image.path}
          label={S.chat.toolImage(index + 1, images.length)}
          bridge={bridge}
        />
      ))}
    </div>
  );
}

function ToolImage({ path, label, bridge }: { path: string; label: string; bridge: ParleyBridge | null }): JSX.Element {
  const { url, settled } = useThumbnailState(bridge, path);
  const openPreview = useOpenImagePreview();

  if (bridge === null || url === null) {
    if (bridge !== null && !settled) return <div data-testid="chat-tool-image-pending" aria-hidden="true" className={FRAME} />;
    return (
      <span
        data-testid="chat-tool-image-unavailable"
        title={path}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
      >
        <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {S.chat.toolImageUnavailable}
      </span>
    );
  }

  // Просить просмотр некого (ряд вне `ChatView`): миниатюра остаётся картинкой, а не кнопкой, которая ничего не делает.
  if (openPreview === null) {
    return (
      <div data-testid="chat-tool-image-static" className={FRAME}>
        <img src={url} alt="" className="size-full object-contain" />
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="chat-tool-image"
      aria-label={label}
      aria-haspopup="dialog"
      title={S.chat.toolImageOpen}
      className={cn(FRAME, 'cursor-zoom-in transition-colors hover:border-foreground/30')}
      onClick={(event) => openPreview({ path, label, thumbnail: url }, event.currentTarget)}
    >
      <img src={url} alt="" className="size-full object-contain" />
    </button>
  );
}
