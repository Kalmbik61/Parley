/**
 * One line of a Qwen Code transcript (`<qwenHome>/projects/<cwd>/chats/<sessionId>.jsonl`, spec §3.5, appendix A).
 * Every record carries `uuid, sessionId, timestamp, type`; the content lives in `message.parts[]`.
 * Parsing never throws: a broken or foreign line gives `null`.
 */

export interface QwenRecord {
  uuid: string | null;
  at: string;
  /** `user`, `assistant`, `tool_result`, `system`, or anything newer. */
  type: string;
  provenance: string | null;
  subtype: string | null;
  /** `message.parts[]` objects only; non-objects are dropped. */
  parts: Record<string, unknown>[];
  usageMetadata: Record<string, unknown> | null;
  toolCallResult: Record<string, unknown> | null;
}

export const isQwenObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function qwenRecordOf(raw: unknown): QwenRecord | null {
  if (!isQwenObject(raw)) return null;
  const type = text(raw['type']);
  const at = text(raw['timestamp']);
  if (type === null || at === null) return null;
  const message = isQwenObject(raw['message']) ? raw['message'] : null;
  const parts = Array.isArray(message?.['parts']) ? (message['parts'] as unknown[]).filter(isQwenObject) : [];
  return {
    uuid: text(raw['uuid']),
    at,
    type,
    provenance: text(raw['provenance']),
    subtype: text(raw['subtype']),
    parts,
    usageMetadata: isQwenObject(raw['usageMetadata']) ? raw['usageMetadata'] : null,
    toolCallResult: isQwenObject(raw['toolCallResult']) ? raw['toolCallResult'] : null,
  };
}

export function parseQwenLine(line: string): QwenRecord | null {
  if (line.trim() === '') return null;
  try {
    return qwenRecordOf(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * Tail reading: `rest` is the unfinished last line kept from the previous read, `chunk` the newly read text.
 * Only lines ended by a newline are consumed; the partial last line stays in `rest` for the next call.
 * `malformed` counts complete lines that did not parse.
 */
export function splitQwenChunk(rest: string, chunk: string): { records: QwenRecord[]; rest: string; malformed: number } {
  const data = rest + chunk;
  const end = data.lastIndexOf('\n');
  if (end === -1) return { records: [], rest: data, malformed: 0 };
  const records: QwenRecord[] = [];
  let malformed = 0;
  for (const line of data.slice(0, end).split('\n')) {
    if (line.trim() === '') continue;
    const record = parseQwenLine(line);
    if (record === null) malformed += 1;
    else records.push(record);
  }
  return { records, rest: data.slice(end + 1), malformed };
}
