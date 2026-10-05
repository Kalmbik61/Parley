import { z } from 'zod';

// Поиск по прошлому проекта для окна (P31): обёртка над `search_history` ядра. Файл в находке — путь внутри
// проекта (относительный), абсолютных путей на проводе нет.
const project = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const workId = z.string().regex(/^w-\d+$/).max(128);
const roomId = z.string().regex(/^r-\d+$/).max(128);
const sessionId = z.string().regex(/^s-\d+$/).max(128);

export const HISTORY_SEARCH_MAX_LIMIT = 30;
export const HISTORY_SEARCH_DEFAULT_LIMIT = 10;
export const historySource = z.enum(['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions']);
export const historyScope = z.enum(['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions', 'all']);

export const historyHit = z.strictObject({
  source: historySource,
  title: z.string().max(400),
  excerpt: z.string().max(1024),
  date: z.string().max(64).nullable(),
  /** Файл относительно папки проекта; нет у итога сессии и у файла вне папки проекта (его окно не откроет). */
  file: z.string().min(1).max(4096).optional(),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  id: z.string().max(256).optional(),
  workId: workId.optional(), roomId: roomId.optional(), sessionId: sessionId.optional(),
  state: z.string().max(64).optional(),
  shared: z.literal(true).optional(), alsoShared: z.literal(true).optional(),
  complete: z.boolean(),
});
export const historySearchResult = z.strictObject({
  query: z.string().max(1000),
  scope: historyScope,
  limit: z.number().int().min(1).max(HISTORY_SEARCH_MAX_LIMIT),
  /** Сколько записей подошло; больше `hits.length` — выдача обрезана лимитом. */
  total: z.number().int().nonnegative(),
  hits: z.array(historyHit).max(HISTORY_SEARCH_MAX_LIMIT),
  /** Источники, прочитанные не целиком. */
  unavailable: z.array(historySource).max(6),
});

export const historyMethodSchemas = {
  'history.search': z.strictObject({
    projectPath: project,
    query: z.string().min(1).max(1000),
    scope: historyScope.optional(),
    limit: z.number().int().min(1).max(HISTORY_SEARCH_MAX_LIMIT).optional(),
  }),
};

export type HistoryHitView = z.infer<typeof historyHit>;
export type HistorySearchView = z.infer<typeof historySearchResult>;
export type HistoryMethodName = keyof typeof historyMethodSchemas;
export type HistoryMethodParams<M extends HistoryMethodName> = z.infer<(typeof historyMethodSchemas)[M]>;
export type HistoryMethodResults = { 'history.search': HistorySearchView };
