import { z } from 'zod';

// Окно журнала решений и истории комнат (P28): только методы окна, без инструментов MCP.
// На проводе нет текста Markdown, абсолютных путей файлов, данных квитанций и общего API каталогов.
const project = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const workId = z.string().regex(/^w-\d+$/).max(128);
const roomId = z.string().regex(/^r-\d+$/).max(128);
const proposalId = z.string().regex(/^p-\d+$/).max(128);
const version = z.string().min(1).max(512);
const iso = z.string().max(64).refine(value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));

export const DECISIONS_LIST_MAX_LIMIT = 200;
export const DECISIONS_LIST_DEFAULT_LIMIT = 50;
/** Имя файла журнала: ссылка на конкретную принятую ревизию. Не путь, а имя в каталоге решений. */
export const DECISION_FILE_NAME = /^\d{4}-\d{2}-\d{2}-w-\d+-r-\d+-p-\d+-rev-\d+\.md$/;

export const decisionState = z.enum(['accepted', 'retained', 'edited', 'unverified', 'pending']);
export const decisionRef = z.strictObject({
  file: z.string().max(255).regex(DECISION_FILE_NAME),
  workId, roomId, proposalId,
  rev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  acceptedAt: iso.nullable(),
  title: z.string().max(200),
  kind: z.enum(['decision', 'completion']).nullable(),
  /** `accepted` и `retained` (работа удалена) открываются; остальное — нет. */
  state: decisionState,
  openable: z.boolean(),
});
export const decisionListErrorCode = z.enum(['file-unreadable', 'file-unrecognized', 'map-unreadable', 'scan-limit']);
export const decisionsListResult = z.strictObject({
  decisions: z.array(decisionRef).max(DECISIONS_LIST_MAX_LIMIT),
  /** Сколько записей подошло фильтру; больше `decisions.length` — список обрезан лимитом. */
  total: z.number().int().nonnegative().max(1_000_000),
  /** Журнал прочитан не весь: предел чтения, нечитаемые файлы или карты. */
  partial: z.boolean(),
  errors: z.array(z.strictObject({ code: decisionListErrorCode, count: z.number().int().positive().max(1_000_000) })).max(8),
});

export const historyState = z.enum(['not-shared', 'shared', 'conflict']);
export const historyDiagnostic = z.strictObject({ code: z.enum(['parley-gitignore-custom', 'parley-dir-ignored']) });
export const roomHistoryStatus = z.strictObject({
  state: historyState,
  /** Только у принадлежащего Parley неизменённого снимка. */
  sharedAt: iso.nullable(),
  /** Версия выложенного файла; её же ждут Share и Unshare как `expectedVersion`. */
  version,
  diagnostics: z.array(historyDiagnostic).max(2),
});
export const historyErrorCode = z.enum([
  'history-invalid', 'history-conflict', 'history-stale', 'history-unavailable', 'history-not-found', 'history-unconfirmed',
  'project-unavailable', 'git-context-unverified', 'main-project-unavailable', 'shared-state-unsafe',
  'shared-file-too-large', 'shared-file-unreadable', 'backlog-lock-timeout', 'journal-unavailable',
]);

const location = { projectPath: project, workId, roomId };
export const journalMethodSchemas = {
  'decisions.list': z.strictObject({
    projectPath: project,
    /** Слова через пробел; все должны встретиться в названии, имени файла или идентификаторах. */
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(DECISIONS_LIST_MAX_LIMIT).optional(),
  }),
  'rooms.history.get': z.strictObject(location),
  /** Публикация в общие файлы git — только с явным подтверждением человека из окна. */
  'rooms.history.share': z.strictObject({ ...location, expectedVersion: version, confirmed: z.literal(true) }),
  'rooms.history.unshare': z.strictObject({ ...location, expectedVersion: version }),
};
export type DecisionRef = z.infer<typeof decisionRef>;
export type DecisionsListResult = z.infer<typeof decisionsListResult>;
export type RoomHistoryStatusView = z.infer<typeof roomHistoryStatus>;
export type JournalMethodName = keyof typeof journalMethodSchemas;
export type JournalMethodParams<M extends JournalMethodName> = z.infer<(typeof journalMethodSchemas)[M]>;
export type JournalMethodResults = {
  'decisions.list': DecisionsListResult;
  'rooms.history.get': RoomHistoryStatusView;
  'rooms.history.share': RoomHistoryStatusView;
  'rooms.history.unshare': RoomHistoryStatusView;
};
