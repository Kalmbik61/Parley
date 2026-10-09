/**
 * Картинки результатов инструментов в ленте (план 2026-10-09, Task 1). Лента несёт ссылки на файлы, а не
 * байты: base64 в журнале Claude и в теле хука весит мегабайты, ходит по протоколу и держится в памяти,
 * а в окне его всё равно никто не читает.
 *
 * Два шага. Хост до редьюсера обходит JSON записи или тела хука (`stashFeedImages`): каждую
 * base64-картинку отдаёт в `save` (файл на диск) и заменяет блок на `{ type, parleyImage }`. `type`
 * остаётся прежним: по нему считают картинки промпта (`block.type === 'image'` в журнале Claude,
 * `imageCount` Codex). Редьюсер потом сводит такой блок в пометку `[image png, 123 KB]` и ссылку
 * `FeedToolResponse.images` (`summarizeImageBlocks`).
 *
 * Метки `parleyImage` / `parleyImageOmitted` ставит только этот обход: результат инструмента — чужой
 * текст и не должен вести окно к произвольному файлу, поэтому метки, пришедшие в данных, обход снимает
 * (читатель ниже верит меткам, потому что хост проводит через обход всё, что идёт в редьюсер).
 *
 * Модуль чистый: ни диска, ни часов — `save` приходит снаружи.
 */

import { isRecord, textOf } from '../work/events.js';
import {
  FEED_IMAGE_MIME_LIMIT,
  FEED_IMAGE_PATH_LIMIT,
  FEED_IMAGES_PER_CALL,
  type FeedImageRef,
} from './types.js';

/**
 * Глубина, ниже которой обход не спускается. Живые записи неглубоки (в записи журнала Claude до
 * картинки около шести уровней); предел нужен, чтобы чужой вложенный JSON не обрушил стек.
 */
const WALK_DEPTH = 32;
const BYTES_IN_KB = 1024;

/** `type` блока-картинки: Anthropic, MCP, Codex и Read — `image`; OpenAI — `input_image`. */
const IMAGE_TYPES: ReadonlySet<unknown> = new Set(['image', 'input_image']);
/** `type` текстового блока результата. */
const TEXT_TYPES: ReadonlySet<unknown> = new Set(['text', 'input_text']);
/** Пометка картинки, у которой нет ссылки: хост её выбросил, ссылка кривая или картинок уже шесть. */
const OMITTED_MARK = '[image omitted]';
/** Ключи метки блока; ставит их только `stashFeedImages`. */
const MARKER_KEYS: ReadonlySet<string> = new Set(['parleyImage', 'parleyImageOmitted']);
const DATA_SCHEME = 'data:';
const BASE64_PARAM = 'base64';

type Save = (base64: string, mime: string) => FeedImageRef | null;

/** Байты картинки из блока и её тип; `mime: null` — блок типа не назвал. */
interface Payload {
  base64: string;
  mime: string | null;
}

/** Тип картинки без пробелов по краям и в нижнем регистре; не строка или пусто — `null`: тип не назван. */
function mimeOf(value: unknown): string | null {
  return typeof value === 'string' ? textOf(value.trim().toLowerCase()) : null;
}

/**
 * `data:<mime>[;параметры];base64,<данные>`; схема и `base64` — без учёта регистра. data-URL без base64
 * и прочие адреса — `null`.
 */
function dataUrlPayload(url: string): Payload | null {
  if (url.slice(0, DATA_SCHEME.length).toLowerCase() !== DATA_SCHEME) return null;
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const [mime, ...params] = url.slice(DATA_SCHEME.length, comma).split(';');
  if (params.at(-1)?.trim().toLowerCase() !== BASE64_PARAM) return null;
  return { base64: url.slice(comma + 1), mime: mimeOf(mime) };
}

/**
 * Байты картинки, если блок — одна из четырёх известных форм; иначе `null`:
 * Anthropic `{type:'image', source:{type:'base64', media_type, data}}`, Read у Claude
 * `{type:'image', file:{base64, type}}`, MCP и Codex `{type:'image', data, mimeType}`, OpenAI
 * `{type:'input_image', image_url:'data:<mime>;base64,<data>'}`.
 */
function payloadOf(block: Record<string, unknown>): Payload | null {
  if (block['type'] === 'input_image') {
    const url = block['image_url'];
    return typeof url === 'string' ? dataUrlPayload(url) : null;
  }
  if (block['type'] !== 'image') return null;
  const source = block['source'];
  if (isRecord(source) && source['type'] === 'base64' && typeof source['data'] === 'string') {
    return { base64: source['data'], mime: mimeOf(source['media_type']) };
  }
  const file = block['file'];
  if (isRecord(file) && typeof file['base64'] === 'string') {
    return { base64: file['base64'], mime: mimeOf(file['type']) };
  }
  return typeof block['data'] === 'string'
    ? { base64: block['data'], mime: mimeOf(block['mimeType']) }
    : null;
}

/**
 * Ссылка на файл для картинки; `null` — картинку в ленту не берём. Тип не назван — `save` не зовётся:
 * хранилище принимает картинки по типу. `save` бросил (диск полон, нет прав) — картинка выбрасывается,
 * а хук и лента живут дальше.
 */
function saved(save: Save, payload: Payload): FeedImageRef | null {
  if (payload.mime === null) return null;
  try {
    return save(payload.base64, payload.mime);
  } catch {
    return null;
  }
}

function walk(value: unknown, save: Save, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= WALK_DEPTH) return value;
    let next: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      const stashed = walk(item, save, depth + 1);
      if (stashed === item) continue;
      next ??= value.slice();
      next[i] = stashed;
    }
    return next ?? value;
  }
  if (!isRecord(value)) return value;

  const payload = payloadOf(value);
  if (payload !== null) {
    const ref = saved(save, payload);
    return ref === null
      ? { type: value['type'], parleyImageOmitted: true }
      : { type: value['type'], parleyImage: ref };
  }
  if (depth >= WALK_DEPTH) return value;
  let next: Record<string, unknown> | null = null;
  for (const key of Object.keys(value)) {
    if (MARKER_KEYS.has(key)) {
      next ??= { ...value };
      delete next[key];
      continue;
    }
    const item = value[key];
    const stashed = walk(item, save, depth + 1);
    if (stashed === item) continue;
    next ??= { ...value };
    next[key] = stashed;
  }
  return next ?? value;
}

/**
 * Обходит JSON записи или тела хука и меняет каждую base64-картинку (четыре формы блока, см.
 * `payloadOf`) на блок `{ type, parleyImage: ref }` — `type` прежний, байтов нет. `save` кладёт
 * картинку в файл и возвращает ссылку; `null` (слишком большая, неизвестный тип, битая) или исключение
 * — блок `{ type, parleyImageOmitted: true }`.
 *
 * Исходник не меняется. Ничего не нашлось — возвращается он сам, не копия: запись может весить
 * мегабайты. Остальные поля записи, не похожие на картинку, обход не трогает — кроме ключей
 * `parleyImage` и `parleyImageOmitted`: у каждого посещённого объекта они снимаются, а ставит их
 * только сам обход. Поэтому он не идемпотентен: хост проводит через него сырую запись один раз, а
 * не уже обработанную. Глубже `WALK_DEPTH` обход не идёт, метки там остаются: редьюсеры читают блоки
 * на мелких уровнях записи.
 */
export function stashFeedImages(value: unknown, save: Save): unknown {
  return walk(value, save, 0);
}

// ---------------------------------------------------------------------------------------------------
// Чтение: блоки после `stashFeedImages` → сводка результата

const isTypedBlock = (block: unknown): block is Record<string, unknown> =>
  isRecord(block) && typeof block['type'] === 'string';

const isImageBlock = (block: Record<string, unknown>): boolean => IMAGE_TYPES.has(block['type']);

/** Блок-картинка, оставленный `stashFeedImages`: со ссылкой или с пометкой, что картинку выбросили. */
function isStashedImage(value: unknown): value is Record<string, unknown> {
  return (
    isTypedBlock(value) &&
    isImageBlock(value) &&
    (value['parleyImage'] !== undefined || value['parleyImageOmitted'] === true)
  );
}

/** Есть ли в значении блок-картинка после `stashFeedImages`: сам объект или элемент массива. */
export function hasStashedImage(value: unknown): boolean {
  return Array.isArray(value) ? value.some(isStashedImage) : isStashedImage(value);
}

/**
 * Есть ли в значении блок-картинка с настоящей ссылкой, годной для ленты (та же проверка, что у сводки):
 * сам объект или элемент массива. Пометка «выброшена» не в счёт — этим `hasStashedImage` и отличается.
 */
export function hasImageRef(value: unknown): boolean {
  const linked = (block: unknown): boolean =>
    isStashedImage(block) && refOf(block['parleyImage']) !== null;
  return Array.isArray(value) ? value.some(linked) : linked(value);
}

/**
 * Годная ссылка из `parleyImage`: путь и тип в пределах схемы протокола; кривая — `null`, ссылка
 * пересобрана без лишних полей.
 */
function refOf(value: unknown): FeedImageRef | null {
  if (!isRecord(value)) return null;
  const { path, mime, bytes } = value;
  if (typeof path !== 'string' || path === '' || path.length > FEED_IMAGE_PATH_LIMIT) return null;
  if (typeof mime !== 'string' || mime.length > FEED_IMAGE_MIME_LIMIT) return null;
  if (bytes === undefined) return { path, mime };
  return typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0
    ? { path, mime, bytes }
    : null;
}

/** `[image png, 123 KB]`; размер неизвестен — `[image png]`; тип не разобрать — `[image]`. */
function imageMark(ref: FeedImageRef): string {
  const subtype = /^[^/]+\/([\w.+-]+)/.exec(ref.mime)?.[1];
  const format = subtype === undefined ? 'image' : `image ${subtype}`;
  const size =
    ref.bytes === undefined || ref.bytes === 0
      ? ''
      : `, ${Math.max(1, Math.round(ref.bytes / BYTES_IN_KB))} KB`;
  return `[${format}${size}]`;
}

/** Текст и картинки результата: пометки вместо байтов, ссылки отдельно. */
export interface ImageBlocksSummary {
  text: string;
  images: FeedImageRef[];
}

/**
 * Сводка результата из блоков: объект-картинка после `stashFeedImages` (Read) или массив блоков,
 * у каждого из которых есть строковый `type` и среди которых есть текст или картинка (MCP). Текст
 * текстовых блоков и пометки картинок идут по порядку через перевод строки, без JSON. В `images` —
 * ссылки, не больше `FEED_IMAGES_PER_CALL`; остальные картинки (лишние, выброшенные, без годной
 * ссылки, а также не обработанные хостом) — пометка `[image omitted]`. Чужие блоки в сводку не идут.
 * Не блоки — `null`: сводку строит вызывающий.
 */
export function summarizeImageBlocks(value: unknown): ImageBlocksSummary | null {
  let blocks: Record<string, unknown>[];
  if (Array.isArray(value)) {
    if (!value.every(isTypedBlock)) return null;
    blocks = value;
    const known = (block: Record<string, unknown>): boolean =>
      TEXT_TYPES.has(block['type']) || isImageBlock(block);
    if (!blocks.some(known)) return null;
  } else if (isStashedImage(value)) {
    blocks = [value];
  } else {
    return null;
  }

  const parts: string[] = [];
  const images: FeedImageRef[] = [];
  for (const block of blocks) {
    if (isImageBlock(block)) {
      const ref = refOf(block['parleyImage']);
      if (ref !== null && images.length < FEED_IMAGES_PER_CALL) {
        images.push(ref);
        parts.push(imageMark(ref));
      } else {
        parts.push(OMITTED_MARK);
      }
    } else if (TEXT_TYPES.has(block['type']) && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return { text: parts.join('\n'), images };
}
