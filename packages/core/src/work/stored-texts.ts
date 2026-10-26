/**
 * Тексты, которые после записи живут не в карте (спека хранилища 6.2). Записанный экспорт плана или решения лежит в
 * своём `.md`, письмо плана — в письме, и карте нужны только отпечатки: у экспорта `sha256`, размер и заголовок, у
 * отправленного или отменённого эффекта — `textSha256`. Пока экспорт `pending`, а эффект `queued`, текст остаётся в
 * карте: файл пишется вне транзакции и при отказе повторяется ровно с него, а письмо ещё не отправлено.
 *
 * Модуль не знает ни базы, ни файлов, чтобы им могли пользоваться и `plan-snapshots.ts`, и `decision-journal.ts`
 * (тот намеренно не подключает `store.ts`).
 */

import { createHash } from 'node:crypto';
import type { DecisionJournalMap } from './decision-journal.js';
import type { PlanEffect, WorkMap } from './types.js';

/** Общая жизнь `planExports` и `decisionExports`: текст до записи файла, отпечаток после. */
export interface StoredExport {
  status: 'pending' | 'written';
  content?: string;
  sha256?: string;
  bytes?: number;
  title?: string;
}

const EXPORT_BYTES = 1024 * 1024;
const TITLE_LENGTH = 200;

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Заголовок экспорта — его первая строка «# …», не длиннее 200 знаков; тем же правилом список журнала берёт заголовок файла. */
export const exportTitle = (content: string): string => (/^# (.*)$/m.exec(content)?.[1] ?? '').slice(0, TITLE_LENGTH);

/** sha256 текста экспорта: готовый у записанного, посчитанный у ещё ожидающего (или не успевшего сжаться). */
export const exportSha256 = (intent: StoredExport): string => intent.sha256 ?? sha256Hex(intent.content ?? '');

/** Записанный экспорт в сжатом виде: текста нет, на месте sha256, размер и заголовок. */
export const hasDigestOnly = (intent: StoredExport): boolean =>
  intent.content === undefined &&
  intent.status === 'written' &&
  isSha256(intent.sha256) &&
  typeof intent.bytes === 'number' &&
  Number.isSafeInteger(intent.bytes) &&
  intent.bytes >= 0 &&
  intent.bytes <= EXPORT_BYTES &&
  typeof intent.title === 'string' &&
  intent.title.length <= TITLE_LENGTH;

/** Файл записан: экспорт становится `written`, а его текст заменяют sha256, размер и заголовок. */
export function settleExport(intent: StoredExport): void {
  if (typeof intent.content === 'string') {
    intent.sha256 = sha256Hex(intent.content);
    intent.bytes = Buffer.byteLength(intent.content);
    intent.title = exportTitle(intent.content);
    delete intent.content;
  }
  intent.status = 'written';
}

/** Эффект отправлен или отменён: текст письма заменяет его `textSha256`. */
export function settleEffectText(effect: PlanEffect): void {
  if (typeof effect.text === 'string') {
    effect.textSha256 = sha256Hex(effect.text);
    delete effect.text;
  }
}

/** Текст письма — тот, что собран для эффекта: прямо (`queued`) или по хэшу (`sent`, `cancelled`). */
export const effectTextIs = (effect: PlanEffect, text: string): boolean =>
  effect.text !== undefined ? effect.text === text : effect.textSha256 === sha256Hex(text);

/**
 * Старый вид карты в сжатый: записанные экспорты теряют `content`, отправленные и отменённые эффекты — `text`. Правит
 * карту на месте и возвращает её же; идемпотентна. Зовёт `normalizeMap` (так сжимаются и прежние строки базы, и
 * карта прежнего `map.json`) и переезд перед сверкой. Неверная форма коллекции или записи здесь не трогается — это дело
 * проверок `normalizeMap`.
 */
export function compactStoredTexts<M extends WorkMap>(map: M): M {
  const decisions = (map as DecisionJournalMap).decisionExports;
  for (const list of [map.planExports, decisions]) {
    if (!Array.isArray(list)) continue;
    for (const intent of list) if (intent?.status === 'written') settleExport(intent);
  }
  if (Array.isArray(map.planEffects)) {
    for (const effect of map.planEffects) if (effect !== null && typeof effect === 'object' && effect.status !== 'queued') settleEffectText(effect);
  }
  return map;
}
