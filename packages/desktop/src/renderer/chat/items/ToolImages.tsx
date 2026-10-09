/**
 * Картинки из результата инструмента под строкой вызова (скриншот MCP браузера, картинка, которую агент прочитал):
 * ряд миниатюр 160×120 по ссылкам `response.images`. Лента несёт ссылки на файлы, а не байты (файлы кладёт хост),
 * миниатюры берёт `app.imageThumbnail` через общий кэш `use-thumbnail.ts`. Клик по миниатюре — диалог просмотра:
 * картинка до `PREVIEW_PX` по длинной стороне отдельным запросом, мимо кэша миниатюр; пока она в пути и если не придёт,
 * в диалоге стоит миниатюра.
 *
 * Высота ряда не прыгает: пока миниатюра в пути, на её месте пустая рамка того же размера, а картинка, которой нет
 * (файл убрали, нет моста), — компактный значок «Image unavailable», без падения. Ряд — часть строки виртуальной ленты
 * (`FeedList` мерит строку `measureElement` и следит за ней `ResizeObserver`), поэтому его перенос по `flex-wrap`
 * в узком окне виден списку как рост строки: следующая строка сдвигается, а не накладывается.
 */

import { useContext, useEffect, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import type { FeedImageRef } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../ui/dialog.js';
import { ChatEnvContext } from '../chat-env.js';
import { useThumbnailState } from '../use-thumbnail.js';

/** Длинная сторона картинки в просмотре, px (main берёт до 2048). */
const PREVIEW_PX = 1600;

/** Рамка миниатюры: одна на кнопку и на пустую рамку, чтобы приход миниатюры не менял высоту строки ленты. */
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

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="chat-tool-image"
          aria-label={label}
          title={S.chat.toolImageOpen}
          className={cn(FRAME, 'cursor-zoom-in transition-colors hover:border-foreground/30')}
        >
          <img src={url} alt="" className="size-full object-cover" />
        </button>
      </DialogTrigger>
      {/*
        Шире обычного диалога (`max-w-lg`): большая картинка иначе ушла бы в горизонтальную прокрутку тела. Крестик диалога
        лежит поверх угла картинки, а скриншоты бывают любого цвета, поэтому у него своя подложка и полная непрозрачность.
      */}
      <DialogContent
        aria-describedby={undefined}
        className="w-fit max-w-[calc(100vw-2rem)] [&>button]:bg-background/85 [&>button]:p-1 [&>button]:opacity-100"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className="flex justify-center">
          <PreviewImage bridge={bridge} path={path} thumbnail={url} label={label} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Содержимое диалога живёт, пока он открыт (Radix монтирует его на открытие): запрос большой версии идёт только тогда. */
function PreviewImage({
  bridge,
  path,
  thumbnail,
  label,
}: {
  bridge: ParleyBridge;
  path: string;
  thumbnail: string;
  label: string;
}): JSX.Element {
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    bridge.app.imageThumbnail(path, PREVIEW_PX).then(
      (url) => {
        if (mounted) setFull(url);
      },
      // Большая версия не пришла — остаётся миниатюра.
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [bridge, path]);
  return (
    <img
      data-testid="chat-tool-image-view"
      src={full ?? thumbnail}
      alt={label}
      className="max-h-[85vh] max-w-[90vw] object-contain"
    />
  );
}
