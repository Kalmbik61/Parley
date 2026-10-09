/**
 * Что хост отдаёт обходу картинок `stashFeedImages` (план 2026-10-09, Task 3): не записи и тела целиком, а
 * поддеревья результатов инструментов. Картинки промпта человека и копии, которых никто не увидит, на
 * диск не идут. Свой источник — свой помощник:
 * - тело хука Claude и Codex — `tool_response`;
 * - запись журнала Claude — `toolUseResult` и содержимое блоков `tool_result` в `message.content`;
 * - запись журнала Codex — `payload.item.result` вызова `McpToolCall`.
 *
 * У каждого вызова помощника свой счётчик: после `FEED_IMAGES_PER_CALL` удачных сохранений остальные
 * картинки получают `null` и в ленте стоят пометкой `[image omitted]`, а файлов не прибавляется.
 *
 * Обход не идемпотентен: он снимает метки `parleyImage`, пришедшие в данных. Поэтому каждая сырая запись и
 * каждое тело хука проходят через помощника один раз, прямо перед редьюсером; обработанное не кешируется и
 * обратно не подаётся. Исходник не меняется: ту же сырую запись можно провести снова. Ничего не нашлось —
 * возвращается сам исходник, не копия.
 */

import { FEED_IMAGES_PER_CALL, stashFeedImages } from '@parley/core';
import type { RawRecord, RolloutRecord } from '@parley/core';
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

/** Запись журнала Codex: `payload.item.result` законченного вызова `McpToolCall`. */
export function stashCodexRecord(record: RolloutRecord, save: SaveFeedImage): RolloutRecord {
  const { payload } = record;
  if (payload['type'] !== 'item_completed') return record;
  const item = payload['item'];
  if (!isRecord(item) || item['type'] !== 'McpToolCall' || item['result'] === undefined)
    return record;
  const result = stashFeedImages(item['result'], capped(save));
  if (result === item['result']) return record;
  return { ...record, payload: { ...payload, item: { ...item, result } } };
}
