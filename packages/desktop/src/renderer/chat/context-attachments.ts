/**
 * Файлы-контексты браузера среди вложений (спека браузера 4.5): `drops/context/<вид>-<метка>-<4 hex>.md`. Чип узнаёт
 * их по пути. Снимок `.png` с тем же именем уходит агенту следом за `.md` (`composePrompt`, `composeRoomMessage`), но
 * только известный: о нём знает лишь ответ `saveContext`, поэтому его запоминает `rememberContextImage`. Реестр живёт в
 * памяти окна — столько же, сколько сами вложения Chat и комнаты.
 */

import { isContextKind, type ContextKind } from '../../shared/context-markdown.js';

const CONTEXT_FILE = /[\\/]drops[\\/]context[\\/]([a-z]+)-([a-z0-9._-]+)-[0-9a-f]{4}\.md$/;
/** Записей реестра не больше: первыми уходят старые. */
const MAX_IMAGES = 500;

export interface ContextAttachment {
  kind: ContextKind;
  label: string;
  /** Соседний `.png` для миниатюры: только у `element` и `annotations`. */
  imagePath: string | null;
}

export function contextAttachment(path: string): ContextAttachment | null {
  const match = CONTEXT_FILE.exec(path);
  const kind = match?.[1];
  if (match === null || !isContextKind(kind)) return null;
  return {
    kind,
    label: match[2] ?? '',
    imagePath: kind === 'element' || kind === 'annotations' ? path.replace(/\.md$/, '.png') : null,
  };
}

const images = new Map<string, string>();

export function rememberContextImage(mdPath: string, pngPath: string): void {
  images.delete(mdPath);
  images.set(mdPath, pngPath);
  if (images.size > MAX_IMAGES) images.delete(images.keys().next().value as string);
}

export function contextImageOf(mdPath: string): string | null {
  return images.get(mdPath) ?? null;
}

/** Пути вложений для отправки: известный снимок — сразу за своим `.md`, без повторов. */
export function withContextImages(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const image = contextAttachment(path) === null ? null : contextImageOf(path);
    return image === null || paths.includes(image) ? [path] : [path, image];
  });
}

/** Для ленты: `.png`, у которого в списке есть `.md` с тем же именем, показывает чип самого `.md`. */
export function pairContextAttachments(paths: readonly string[]): string[] {
  const paired = new Set(
    paths.flatMap((path) => {
      const image = contextAttachment(path)?.imagePath ?? null;
      return image === null ? [] : [image];
    }),
  );
  return paths.filter((path) => !paired.has(path));
}

/** Только для тестов. */
export function resetContextImagesForTests(): void {
  images.clear();
}
