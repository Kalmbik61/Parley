/**
 * Превью картинки (кусок 7.5, спека 10.6): `<img>` из `Blob` байтов `files.readBytes`, «Fit /
 * 100%» и размер в пикселях. `svg` тоже здесь: в `<img>` его скрипты и внешние ссылки не
 * работают, в отличие от вставки разметкой.
 */

import { useState } from 'react';
import { S } from '../../../shared/strings.js';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';
import { imageType, useObjectUrl } from './object-url.js';

export interface ImagePreviewProps {
  bytes: Uint8Array;
  /** Путь файла — для типа картинки и подписи `alt`. */
  path: string;
}

export function ImagePreview({ bytes, path }: ImagePreviewProps): JSX.Element {
  const url = useObjectUrl(bytes, imageType(path));
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const name = path.slice(path.lastIndexOf('/') + 1);

  return (
    <div data-testid="image-preview" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <ToggleGroup
          type="single"
          size="sm"
          value={fit ? 'fit' : 'actual'}
          // Повторный клик по выбранному снял бы выбор: пустое значение пропускаем.
          onValueChange={(value) => (value === '' ? undefined : setFit(value === 'fit'))}
        >
          <ToggleGroupItem value="fit" className="h-6 px-2 text-xs">
            {S.files.fit}
          </ToggleGroupItem>
          <ToggleGroupItem value="actual" className="h-6 px-2 text-xs">
            {S.files.actualSize}
          </ToggleGroupItem>
        </ToggleGroup>
        {size === null ? null : <span className="truncate text-xs text-muted-foreground">{S.files.imageSize(size.width, size.height)}</span>}
      </div>
      <div className={`min-h-0 flex-1 overflow-auto p-2 ${fit ? 'flex items-center justify-center' : ''}`}>
        {url === null ? null : (
          <img
            src={url}
            alt={name}
            draggable={false}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}
          />
        )}
      </div>
    </div>
  );
}
