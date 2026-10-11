/**
 * Что хост отдаёт обходу картинок `stashFeedImages` (план 2026-10-09, Task 3): не записи и тела целиком, а
 * поддеревья результатов инструментов. Картинки промпта человека и копии, которых никто не увидит, на
 * диск не идут. Свой источник — свой помощник:
 * - тело хука Claude и Codex — `tool_response`;
 * - запись журнала Claude — `toolUseResult` и содержимое блоков `tool_result` в `message.content`;
 * - запись журнала Codex — `payload.item.result` вызова `McpToolCall`, а у `ImageView` (`view_image`) — копия
 *   файла, который агент посмотрел (см. `stashCodexRecord`).
 *
 * У каждого вызова помощника свой счётчик: после `FEED_IMAGES_PER_CALL` удачных сохранений остальные
 * картинки получают `null` и в ленте стоят пометкой `[image omitted]`, а файлов не прибавляется.
 *
 * Обход не идемпотентен: он снимает метки `parleyImage`, пришедшие в данных. Поэтому каждая сырая запись и
 * каждое тело хука проходят через помощника один раз, прямо перед редьюсером; обработанное не кешируется и
 * обратно не подаётся. Исходник не меняется: ту же сырую запись можно провести снова. Ничего не нашлось —
 * возвращается сам исходник, не копия.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_IMAGE_MAX_BYTES, FEED_IMAGES_PER_CALL, stashFeedImages } from '@parley/core';
import type { FeedImageRef, RawRecord, RolloutRecord } from '@parley/core';
import { mimeOfBytes } from './image-store.js';
import type { SaveFeedImage } from './image-store.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `save` на один вызов помощника: не больше `FEED_IMAGES_PER_CALL` удачных сохранений. */
function capped(save: SaveFeedImage): SaveFeedImage {
  let saved = 0;
  return (base64, mime) => {
    if (saved >= FEED_IMAGES_PER_CALL) return null;
    const ref = save(base64, mime);
    if (ref !== null) saved += 1;
    return ref;
  };
}

/** Тело хука Claude или Codex: картинки только в `tool_response`. */
export function stashHookBody(
  body: Record<string, unknown>,
  save: SaveFeedImage,
): Record<string, unknown> {
  const response = body['tool_response'];
  if (response === undefined) return body;
  const stashed = stashFeedImages(response, capped(save));
  return stashed === response ? body : { ...body, tool_response: stashed };
}

/**
 * Запись журнала Claude: `toolUseResult` и `content` каждого блока `tool_result`. Остальное — картинки
 * промпта (прямые блоки `image` в `message.content`), текст, `tool_use` — остаётся как есть.
 */
export function stashClaudeRecord(record: RawRecord, save: SaveFeedImage): RawRecord {
  const limited = capped(save);
  let next = record;
  const result = record['toolUseResult'];
  if (result !== undefined) {
    const stashed = stashFeedImages(result, limited);
    if (stashed !== result) next = { ...next, toolUseResult: stashed };
  }

  const message = record['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return next;
  const content: unknown[] = message['content'];
  let blocks: unknown[] | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!isRecord(block) || block['type'] !== 'tool_result' || block['content'] === undefined)
      continue;
    const stashed = stashFeedImages(block['content'], limited);
    if (stashed === block['content']) continue;
    blocks ??= content.slice();
    blocks[index] = { ...block, content: stashed };
  }
  return blocks === null ? next : { ...next, message: { ...message, content: blocks } };
}

/** Расширения, по которым файл вообще рассматривается как картинка (то же правило, что `isImagePath` окна). */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Путь файла из `ImageView.path`. Codex пишет в журнал URL `file:///…` (так в каждой записи живых журналов);
 * обычный абсолютный путь тоже годится. Не строка, не абсолютный, чужая схема или хост, битый URL — `null`.
 * Расширение потом проверяется у этого пути, а не у строки журнала: `file:///a/x.txt?.png` — не картинка.
 */
function viewedFile(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(value) ? value : null;
}

/** Читает из открытого файла ровно `size` байт (меньше, если он оказался короче); не больше, как бы файл ни рос. */
function readFully(fd: number, size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let filled = 0;
  while (filled < size) {
    const count = readSync(fd, buffer, filled, size - filled, filled);
    if (count === 0) break;
    filled += count;
  }
  return buffer.subarray(0, filled);
}

/**
 * Копия файла, который агент посмотрел (`ImageView`), в хранилище: картинка в ленте должна быть той, что агент
 * видел тогда, а не той, что лежит по его пути теперь, — файл он переписывает, а временный каталог чистит ОС. Путь
 * задаёт агент, и между проверкой пути и чтением его можно подменить на FIFO: `open(2)` FIFO без писателя блокирует
 * хост, а в хосте живут все терминалы. Поэтому файл открывается один раз и без блокировки (`O_NONBLOCK`), а всё
 * остальное проверяется по открытому дескриптору: обычный файл, не больше `FEED_IMAGE_MAX_BYTES`, читается ровно
 * столько байт, сколько он весил. Ссылка по пути разворачивается (`O_NOFOLLOW` не нужен): ссылка на картинку
 * читается как сама картинка, а ссылка на чужое не картинка по подписи и в хранилище не попадёт. Расширение лишь
 * пускает файл дальше, тип берётся по подписи байтов. Нет такого файла, он не читается или хранилище отказало —
 * `null`, вызов остаётся без картинки.
 */
function copyViewedImage(item: Record<string, unknown>, save: SaveFeedImage): FeedImageRef | null {
  const file = viewedFile(item['path']);
  if (file === null || !IMAGE_EXTENSION.test(file)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > FEED_IMAGE_MAX_BYTES) return null;
    const bytes = readFully(fd, info.size);
    const mime = mimeOfBytes(bytes);
    return mime === null ? null : save(bytes.toString('base64'), mime);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Закрыть не вышло — ссылка от этого не хуже: дескриптор уйдёт с процессом.
      }
    }
  }
}

/**
 * Запись журнала Codex: `payload.item.result` законченного вызова `McpToolCall` и копия файла `ImageView`. Ссылка на
 * копию встаёт в элемент как `parleyImage` (ключ читает `apply-codex.ts`); пришедший в данных `parleyImage` чужой и
 * снимается всегда.
 */
export function stashCodexRecord(record: RolloutRecord, save: SaveFeedImage): RolloutRecord {
  const { payload } = record;
  if (payload['type'] !== 'item_completed') return record;
  const item = payload['item'];
  if (!isRecord(item)) return record;
  if (item['type'] === 'ImageView') {
    const ref = copyViewedImage(item, save);
    if (ref === null && !('parleyImage' in item)) return record;
    const next = { ...item };
    delete next['parleyImage'];
    if (ref !== null) next['parleyImage'] = ref;
    return { ...record, payload: { ...payload, item: next } };
  }
  if (item['type'] !== 'McpToolCall' || item['result'] === undefined) return record;
  const result = stashFeedImages(item['result'], capped(save));
  if (result === item['result']) return record;
  return { ...record, payload: { ...payload, item: { ...item, result } } };
}
