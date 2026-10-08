/**
 * Строка журнала Codex (`~/.codex/sessions/…/rollout-*.jsonl`; спека 2026-10-07, разделы 3 и 5.2):
 * `{ timestamp, ordinal, type, payload }`. Разбор без исключений: битая или чужая строка — `null`.
 */

export interface RolloutRecord {
  /** Монотонный номер строки; `null` — его нет (журналы до 0.160). */
  ordinal: number | null;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function rolloutRecordOf(raw: unknown): RolloutRecord | null {
  if (!isRecord(raw)) return null;
  const { type, timestamp, payload, ordinal } = raw;
  if (typeof type !== 'string' || typeof timestamp !== 'string' || !isRecord(payload)) return null;
  return { ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : null, at: timestamp, type, payload };
}

export function parseRolloutLine(line: string): RolloutRecord | null {
  if (line.trim() === '') return null;
  try {
    return rolloutRecordOf(JSON.parse(line));
  } catch {
    return null;
  }
}
