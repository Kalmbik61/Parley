/**
 * Байты файла как адрес `blob:` для `<img>` превью (кусок 7.5, спека 10.6): `file://` в рендерере
 * нет, байты приходят из `files.readBytes`. Адрес отпускается при размонтировании и смене байтов —
 * иначе каждый показ картинки держал бы её копию в памяти окна до перезагрузки.
 */

import { useEffect, useState } from 'react';

const IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  // Без типа `<img>` svg не покажет; в `<img>` скрипты svg не исполняются.
  ['svg', 'image/svg+xml'],
]);

/** Тип картинки по расширению; прочее — пустой тип, браузер угадает по байтам сам. */
export function imageType(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : (IMAGE_TYPES.get(path.slice(dot + 1).toLowerCase()) ?? '');
}

export function useObjectUrl(bytes: Uint8Array | null, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (bytes === null) {
      setUrl(null);
      return;
    }
    // Копия в свой ArrayBuffer: `BlobPart` не принимает вид на `SharedArrayBuffer`.
    const next = URL.createObjectURL(new Blob([bytes.slice()], { type }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, type]);
  return url;
}
