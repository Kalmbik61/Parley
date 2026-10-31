import { appendFileSync, chmodSync, closeSync, openSync } from 'node:fs';
import { ensureDirSync } from './files-sync.js';

/** Поля, значения которых никогда не пишутся: секреты, payload и тексты. */
const SECRET_KEY = /token|secret|key|psk|payload|text|body|password|qr|^s$/i;

export interface BridgeLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Зарегистрировать значение секрета: если оно встретится в строке, оно вырезается. */
  addSecret(value: string): void;
}

export interface LogOptions {
  file: string;
  now?: () => Date;
}

function scalar(value: unknown, redact: (text: string) => string): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // Сначала вырезаем секреты, потом обрезаем: иначе на границе остаётся начало секрета.
    const clean = redact(value);
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  }
  // Ошибки: только имя и код, не сообщение — оно может нести значение.
  if (value instanceof Error) return `${value.name}${(value as NodeJS.ErrnoException).code ? `:${(value as NodeJS.ErrnoException).code}` : ''}`;
  return '[object]';
}

/** Лог моста `bridge.log`, 0600, одна JSON-строка на запись. */
export function createLog(options: LogOptions): BridgeLog {
  const now = options.now ?? (() => new Date());
  const secrets = new Set<string>();

  function redact(text: string): string {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  }

  function write(level: string, event: string, fields: Record<string, unknown> = {}): void {
    const entry: Record<string, unknown> = { at: now().toISOString(), level, event };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = SECRET_KEY.test(key) ? '[redacted]' : scalar(value, redact);
    }
    const line = redact(JSON.stringify(entry));
    try {
      ensureDirSync(options.file);
      const fd = openSync(options.file, 'a', 0o600);
      try {
        appendFileSync(fd, `${line}\n`);
      } finally {
        closeSync(fd);
      }
      chmodSync(options.file, 0o600);
    } catch {
      // лог не должен ронять мост
    }
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    addSecret(value) {
      if (value.length >= 8) secrets.add(value);
    },
  };
}
