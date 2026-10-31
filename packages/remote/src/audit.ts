import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { z } from 'zod';
import { ensureDirSync } from './files-sync.js';

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Виды записей — спека 5.8. */
export const AUDIT_KINDS = [
  'pair-offer',
  'pair-request',
  'pair-allowed',
  'pair-denied',
  'pair-failed',
  'connect',
  'connect-refused',
  'call',
  'call-refused',
  'revoked',
  'reset',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const auditRecordSchema = z.object({
  at: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  kind: z.enum(AUDIT_KINDS),
  method: z.string().optional(),
  target: z.string().optional(),
  outcome: z.string(),
  detail: z.string().optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditInput = Omit<AuditRecord, 'at' | 'deviceId' | 'deviceName'> & {
  at?: string;
  deviceId?: string;
  deviceName?: string;
};

export interface AuditLog {
  append(record: AuditInput): void;
  /** Последние `limit` записей, старые первыми; архив при нехватке тоже читается. */
  tail(limit: number): AuditRecord[];
}

export interface AuditOptions {
  file: string;
  archive: string;
  maxBytes?: number;
  now?: () => Date;
}

/** Журнал JSONL, 0600. Перед записью, выводящей за предел, текущий файл становится архивом (прежний архив теряется). */
export function createAuditLog(options: AuditOptions): AuditLog {
  const { file, archive } = options;
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;
  const now = options.now ?? (() => new Date());

  function readLines(path: string): AuditRecord[] {
    if (!existsSync(path)) return [];
    const records: AuditRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = auditRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch {
        // оборванная строка после сбоя — пропускаем
      }
    }
    return records;
  }

  return {
    append(input) {
      const record: AuditRecord = {
        ...input,
        at: input.at ?? now().toISOString(),
        deviceId: input.deviceId ?? '',
        deviceName: input.deviceName ?? '',
      };
      const line = `${JSON.stringify(record)}\n`;
      ensureDirSync(file);
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, archive);
      const fd = openSync(file, 'a', 0o600);
      try {
        appendFileSync(fd, line);
      } finally {
        closeSync(fd);
      }
      chmodSync(file, 0o600);
    },
    tail(limit) {
      const current = readLines(file);
      const all = current.length >= limit ? current : [...readLines(archive), ...current];
      return all.slice(-limit);
    },
  };
}
