/**
 * Shapes of the OpenCode 2.x `GET /api/session/{id}/message` list (spike 2026-11-12 §8, `openapi.json`
 * `Session.Message.*`). Parsing never throws: a part or message of a foreign shape gives `null`.
 */

export const isOpencodeObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export interface OpencodeMessage {
  id: string;
  /** `user`, `assistant`, `idle`, `system`, `synthetic`… or anything newer. */
  type: string;
  /** ISO time from `time.created` (milliseconds). */
  at: string;
  /** `time.completed` as ISO; `null` while the message still streams. */
  completedAt: string | null;
  raw: Record<string, unknown>;
}

const iso = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function opencodeIso(value: unknown): string | null {
  return iso(value);
}

export function opencodeMessageOf(raw: unknown): OpencodeMessage | null {
  if (!isOpencodeObject(raw)) return null;
  const id = text(raw['id']);
  const type = text(raw['type']);
  const time = isOpencodeObject(raw['time']) ? raw['time'] : null;
  const at = iso(time?.['created']);
  if (id === null || type === null || at === null) return null;
  return { id, type, at, completedAt: iso(time?.['completed']), raw };
}

/** Plain text of a tool `content` array (`Tool.TextContent` parts); other parts are dropped. */
export function opencodeContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => (isOpencodeObject(part) && part['type'] === 'text' ? text(part['text']) : null))
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join('\n');
}
