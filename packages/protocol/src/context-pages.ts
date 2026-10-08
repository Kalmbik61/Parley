import { z } from 'zod';
import type { Message, PageInfo, TextPage } from '@parley/core';

// Страницы переписки для окна (P35, первая ступень A14): снимок работ несёт только хвост писем, а историю выбранной
// комнаты и длинные тексты окно берёт этими методами. Страница ограничена в байтах, курсор называет номер письма, а
// не позицию, поэтому дописывание в конец ничего не пропускает и не повторяет.

/**
 * Возможность клиента в `hello.features`: он читает компактный снимок работ (письма — хвостом, длинные тексты
 * сокращены, итоги и счётчики — в `map.compact`). Клиент без неё получает прежний полный снимок, пока тот влезает в кадр.
 */
export const COMPACT_WORKS_FEATURE = 'compact-works';

/**
 * Прежний полный снимок отдаётся клиенту без `compact-works`, только если он не больше этого размера: кадр
 * ограничен 8 МиБ (`MAX_LINE_BYTES`), и запас нужен, чтобы дописывание письма не перекинуло снимок за предел.
 */
export const LEGACY_SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;

const project = z.string().min(1).max(32768).refine((value) => !value.includes('\0'));
const workId = z.string().regex(/^w-\d+$/).max(128);
const roomId = z.string().regex(/^r-\d+$/).max(128);
const sessionId = z.string().regex(/^s-\d+$/).max(128);
const messageId = z.string().regex(/^m-\d+$/).max(128);
const cursor = z.string().regex(/^(before|after):\d{1,12}$/);
const textCursor = z.string().regex(/^offset:\d{1,12}:[0-9a-f]{12}$/);
const maxBytes = z.number().int().min(2 * 1024).max(256 * 1024);

export const contextPageMethodSchemas = {
  /** Страница писем комнаты (`roomId`) или прямых писем работы (`null`); без курсора — самые новые. */
  'context.messages': z.strictObject({
    projectPath: project,
    workId,
    roomId: roomId.nullable(),
    cursor: cursor.optional(),
    maxBytes: maxBytes.optional(),
  }),
  /** Кусок длинного текста по смещению: письмо, цель работы или задача и резюме сессии. */
  'context.text': z.strictObject({
    projectPath: project,
    workId,
    ref: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('message'), id: messageId }),
      z.strictObject({ kind: z.literal('goal') }),
      z.strictObject({ kind: z.literal('session'), sessionId, field: z.enum(['task', 'summary']) }),
    ]),
    cursor: textCursor.optional(),
    maxBytes: maxBytes.optional(),
  }),
};

export type ContextPageMethodName = keyof typeof contextPageMethodSchemas;
export type ContextPageMethodParams<M extends ContextPageMethodName> = z.infer<(typeof contextPageMethodSchemas)[M]>;
export interface ContextPageMethodResults {
  /** Письма по возрастанию номера; сокращённое письмо несёт `textBytes` — полный размер текста. */
  'context.messages': { messages: Message[]; page: PageInfo };
  'context.text': TextPage;
}
