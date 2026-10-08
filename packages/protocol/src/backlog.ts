import { z } from 'zod';

const text = z.string().max(1024 * 1024);
const project = z.string().min(1).max(32768);
const version = z.string().min(1).max(512);
const itemId = z.string().regex(/^b-\d{3,}$/).max(512);
const suggestionId = z.string().regex(/^sg-\d{2,}$/).max(512);
const workId = z.string().regex(/^w-\d+$/).max(128);
const sessionId = z.string().regex(/^s-\d+$/).max(128);
const roomId = z.string().regex(/^r-\d+$/).max(128);
const title = z.string().min(1).max(4096).refine(value => value.trim() !== '' && !/[\r\n]/.test(value) && !value.includes('\0'));
const details = z.string().max(65536).refine(value => !value.includes('\0'));
const section = title;
export const backlogRule = z.enum(['ask', 'problems', 'everything']);
export const backlogDiagnostic = z.strictObject({ code: z.enum(['parley-gitignore-custom', 'parley-dir-ignored']) });
export const backlogErrorCode = z.enum([
  'project-unavailable', 'git-context-unverified', 'main-project-unavailable', 'shared-state-unsafe',
  'shared-file-too-large', 'shared-file-unreadable', 'backlog-lock-timeout', 'backlog-conflict',
  'backlog-merge-conflict', 'backlog-invalid', 'preferences-invalid', 'suggestions-invalid', 'backlog-operation-failed', 'backlog-watch-unavailable', 'backlog-snapshot-too-large',
]);

/** Existing human Markdown can contain longer/unknown metadata: reads preserve it, new inputs are bounded separately. */
export const backlogItem = z.strictObject({
  id: itemId.nullable(), title: text, details: text, checked: z.boolean(), section: text.nullable(),
  taken: text.optional(), done: text.optional(), by: text.optional(),
});
export const backlogAuthor = z.strictObject({ projectPath: project, workId, sessionId, label: text, revision: version,
  role: z.strictObject({ source: z.enum(['builtin', 'claude', 'codex']), name: text }).nullable() });
export type BacklogAuthor = z.infer<typeof backlogAuthor>;
export const backlogSuggestion = z.strictObject({
  id: suggestionId, kind: z.enum(['bug', 'debt', 'idea']), title: text, details: text, why: text,
  workId, sessionId, createdAt: z.string().max(128), status: z.literal('pending'), author: backlogAuthor.optional(),
});
export const BACKLOG_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const backlogFileChoice = z.enum(['state', 'todos']);
const todosName = z.string().regex(/^todos?\.md$/i);
export const backlogSnapshot = z.strictObject({
  /** Requested project identity remains stable while the corresponding main folder is explicit. */
  projectPath: project, sharedProjectPath: project,
  file: z.strictObject({
    relativePath: z.union([z.enum(['.parley/backlog.md', '.harnas/backlog.md']), todosName]), exists: z.boolean(),
    /** Absent from an older host: the window then hides the file choice. */
    choice: backlogFileChoice.nullable().optional(), todos: todosName.nullable().optional(),
  }),
  version, items: z.array(backlogItem).max(10000), suggestions: z.array(backlogSuggestion).max(10000),
  rule: backlogRule, diagnostics: z.array(backlogDiagnostic).max(2),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= BACKLOG_SNAPSHOT_MAX_BYTES, { message: 'Backlog snapshot exceeds the transport budget.' });
export const backlogPrepareTakeResult = z.strictObject({ id: itemId, snapshot: backlogSnapshot });
export type BacklogSnapshot = z.infer<typeof backlogSnapshot>;
export type BacklogDiagnostic = z.infer<typeof backlogDiagnostic>;
export type BacklogErrorCode = z.infer<typeof backlogErrorCode>;
export type BacklogRule = z.infer<typeof backlogRule>;
export type BacklogFileChoice = z.infer<typeof backlogFileChoice>;

const target = z.union([
  z.strictObject({ projectPath: project, workId, roomId }),
  z.strictObject({ projectPath: project, workId, sessionId }),
]);
const locator = { id: itemId.optional(), index: z.number().int().min(0).max(9999).optional() };
const exactlyOneLocator = (value: { id?: string | undefined; index?: number | undefined }): boolean => (value.id !== undefined) !== (value.index !== undefined);
const patch = z.strictObject({ title: title.optional(), details: details.optional(), checked: z.boolean().optional(),
}).refine(value => Object.keys(value).length !== 0);

/** Manual authenticated-host API. MCP exposes list/suggest separately; the host token is a user capability. */
export const backlogMethodSchemas = {
  'backlog.subscribe': z.strictObject({ projectPath: project }),
  'backlog.unsubscribe': z.strictObject({ projectPath: project }),
  'backlog.get': z.strictObject({ projectPath: project }),
  'backlog.add': z.strictObject({ projectPath: project, title, details: details.optional(), section: section.optional(), version: version.optional() }),
  'backlog.update': z.strictObject({ projectPath: project, ...locator, version, patch }).refine(exactlyOneLocator),
  'backlog.remove': z.strictObject({ projectPath: project, ...locator, version }).refine(exactlyOneLocator),
  'backlog.prepareTake': z.strictObject({ projectPath: project, ...locator, version }).refine(exactlyOneLocator),
  'backlog.take': z.strictObject({ projectPath: project, ...locator, version, target }).refine(exactlyOneLocator),
  'backlog.suggestions.accept': z.strictObject({ projectPath: project, id: suggestionId, title: title.optional(), details: details.optional() }),
  'backlog.suggestions.dismiss': z.strictObject({ projectPath: project, id: suggestionId }),
  'backlog.preferences.set': z.strictObject({ projectPath: project, rule: backlogRule }),
  'backlog.file.set': z.strictObject({ projectPath: project, file: backlogFileChoice }),
};
export type BacklogMethodName = keyof typeof backlogMethodSchemas;
export type BacklogMethodParams<M extends BacklogMethodName> = z.infer<(typeof backlogMethodSchemas)[M]>;
export type BacklogMethodResults = { [M in Exclude<BacklogMethodName, 'backlog.unsubscribe' | 'backlog.prepareTake'>]: BacklogSnapshot } & { 'backlog.unsubscribe': { ok: true }; 'backlog.prepareTake': { id: string; snapshot: BacklogSnapshot } };
export const backlogChanged = z.strictObject({ projectPath: project, unavailable: z.literal(true).optional() });
export type BacklogChanged = z.infer<typeof backlogChanged>;
