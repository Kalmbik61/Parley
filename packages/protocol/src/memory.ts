import { z } from 'zod';

// Окно памяти проекта (P31): только методы окна. Инструменты агентов (remember, memory_read) — в MCP ядра.
// На проводе нет абсолютных путей и текста файла целиком: окно получает разобранные записи.
const text = z.string().max(1024 * 1024);
const project = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const version = z.string().min(1).max(512);
const memoryId = z.string().regex(/^m-\d{3,}$/).max(512);
const suggestionId = z.string().regex(/^ms-\d{2,}$/).max(512);
const operationId = z.string().regex(/^remember:ms-\d{2,}$/).max(512);
const workId = z.string().regex(/^w-\d+$/).max(128);
const sessionId = z.string().regex(/^s-\d+$/).max(128);
/** Одна фраза: без переносов и служебных скобок комментария; остальное проверяет ядро при записи. */
const fact = z.string().min(1).max(4096).refine(value => value.trim() !== '' && !/[\r\n]/.test(value) && !value.includes('\0') && !value.includes('<!--') && !value.includes('-->'));
const details = z.string().max(65536).refine(value => !value.includes('\0'));

export const MEMORY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const memoryKind = z.enum(['fact', 'lesson', 'agreement']);
export const memoryDiagnostic = z.strictObject({ code: z.enum(['parley-gitignore-custom', 'parley-dir-ignored']) });

export const memoryItemView = z.strictObject({
  id: memoryId.nullable(), kind: memoryKind, fact: text, details: text,
  state: z.enum(['current', 'superseded']),
  /** `human` — записал или правил человек; `agent` — предложил агент; `unknown` — рукописный пункт без пометок. */
  author: z.enum(['human', 'agent', 'unknown']),
  by: text.optional(),
  /** Агент заявил, что человек сам попросил запомнить. Это заявление агента, а не подтверждение. */
  onRequest: z.boolean(),
  /** Человек правил фразу или подробности. */
  amended: z.boolean(),
});
export const memorySuggestionView = z.strictObject({
  id: suggestionId, kind: memoryKind, fact: text, details: text, why: text, workId: workId.optional(), sessionId: sessionId.optional(), createdAt: z.string().max(128),
});
export const memoryUndoView = z.strictObject({ operationId, memoryId, fact: text, workId: workId.optional(), sessionId: sessionId.optional() });

export const memorySnapshot = z.strictObject({
  projectPath: project,
  file: z.strictObject({ relativePath: z.enum(['.parley/memory.md', '.harnas/memory.md']), exists: z.boolean(),
    /** Общий каталог лежит вне папки проекта (linked worktree): файл открывает только main (`app:open-shared-file`, `memory.md`). */
    shared: z.literal(true).optional() }),
  /** Версия `memory.md`; её же ждут Edit и Add как `version`. */
  version,
  items: z.array(memoryItemView).max(10000),
  suggestions: z.array(memorySuggestionView).max(10000),
  /** Записи «по просьбе», которые ещё можно отменить (новые первыми). */
  undoable: z.array(memoryUndoView).max(20),
  diagnostics: z.array(memoryDiagnostic).max(2),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MEMORY_SNAPSHOT_MAX_BYTES, { message: 'Memory snapshot exceeds the transport budget.' });

export const memoryMethodSchemas = {
  'memory.get': z.strictObject({ projectPath: project }),
  /** Запись человека: пункт без пометки агента; без `version` дописывается в актуальную версию. */
  'memory.add': z.strictObject({ projectPath: project, kind: memoryKind, fact, details: details.optional(), version: version.optional() }),
  /** Правка фразы и подробностей по id; устаревшая версия — конфликт. */
  'memory.update': z.strictObject({
    projectPath: project, id: memoryId, version,
    patch: z.strictObject({ fact: fact.optional(), details: details.optional() }).refine(value => Object.keys(value).length !== 0),
  }),
  /** Add / Edit & add: предложение попадает в `memory.md`; правка фразы или подробностей — по желанию. */
  'memory.accept': z.strictObject({ projectPath: project, id: suggestionId, fact: fact.optional(), details: details.optional() }),
  'memory.dismiss': z.strictObject({ projectPath: project, id: suggestionId }),
  /** Undo записи «по просьбе»: удаляет только строку, вставленную той операцией; после правки человека — конфликт. */
  'memory.undo': z.strictObject({ projectPath: project, operationId }),
};

export type MemoryItemView = z.infer<typeof memoryItemView>;
export type MemorySuggestionView = z.infer<typeof memorySuggestionView>;
export type MemoryUndoView = z.infer<typeof memoryUndoView>;
export type MemorySnapshot = z.infer<typeof memorySnapshot>;
export type MemoryMethodName = keyof typeof memoryMethodSchemas;
export type MemoryMethodParams<M extends MemoryMethodName> = z.infer<(typeof memoryMethodSchemas)[M]>;
export type MemoryMethodResults = { [M in MemoryMethodName]: MemorySnapshot };
