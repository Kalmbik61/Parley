/**
 * Миниатюры картинок-вложений для чипов (`AttachmentChip`): `app.imageThumbnail` по пути, ответы — в кэше
 * на весь модуль. Строки ленты виртуализированы и размонтируются при прокрутке: без кэша миниатюры мигали бы
 * и каждый раз шёл IPC, а с кэшем уже полученная миниатюра встаёт на первой же отрисовке строки.
 */

import { useEffect, useState } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';

/** Столько путей кэш помнит; миниатюра — data-URL в сотню КБ, поэтому не бесконечно. */
const MAX_ENTRIES = 200;

interface Entry {
  promise: Promise<string | null>;
  /** Ответ, когда он пришёл (`null` — миниатюры нет); пока запрос в пути — не задан. */
  value?: string | null;
}

const cache = new Map<string, Entry>();

function load(bridge: ParleyBridge, path: string): Entry {
  const known = cache.get(path);
  if (known !== undefined) return known;
  // Сбой IPC — то же, что «миниатюры нет»: чип остаётся значком с именем.
  const entry: Entry = { promise: bridge.app.imageThumbnail(path).catch(() => null) };
  void entry.promise.then((value) => {
    entry.value = value;
  });
  cache.set(path, entry);
  // Порядок `Map` — по вставке: первым уходит самый старый путь.
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return entry;
}

/** data-URL миниатюры пути; пока она грузится, нет её или `path === null` — `null`. */
export function useThumbnail(bridge: ParleyBridge | null, path: string | null): string | null {
  const [, setSettled] = useState(0);
  useEffect(() => {
    if (bridge === null || path === null) return undefined;
    let mounted = true;
    // Ответ читается из кэша при отрисовке (он годится и для пути, уже известного кэшу); тут — только повод перерисовать.
    void load(bridge, path).promise.then(() => {
      if (mounted) setSettled((count) => count + 1);
    });
    return () => {
      mounted = false;
    };
  }, [bridge, path]);
  return path === null ? null : (cache.get(path)?.value ?? null);
}

/** Только для тестов. */
export function resetThumbnailCacheForTests(): void {
  cache.clear();
}
