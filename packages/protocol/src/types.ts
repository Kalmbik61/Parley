import type { WorkEntry } from '@harnas/core';

/** Адрес сессии: без него не различить два «work-01» в разных проектах. */
export interface SessionRef {
  projectPath: string;
  workId: string;
  sessionId: string;
}

/**
 * Строковый ключ для `Map`/`Set` по ссылке на сессию. `\u0000` в путях и id не
 * встречается, так что склейка не даёт ложных совпадений.
 */
export const refKey = (ref: SessionRef): string =>
  `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;

/** Живые цифры сессии для строки статуса и списка — `null`, пока их не видно. */
export interface LiveMetrics {
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  unread: number;
  subagents: number;
  model: string | null;
}

/** Виды уведомлений хоста, для которых не нужен отдельный запрос-ответ. */
export type NoticeKind =
  | 'map-lock'
  | 'map-corrupt'
  | 'hooks-missing'
  | 'launch-failed'
  | 'pointer-timeout'
  | 'pointer-cancelled'
  | 'resume-failed'
  | 'resume-limit'
  | 'trust-wait';

export interface HostNotice {
  kind: NoticeKind;
  ref: SessionRef | null;
  text: string;
  at: string;
}

/**
 * Почему `pty.send` не нажал Enter или не вставил текст (спека 3.2, 8.6). Лежит здесь, а
 * не в хосте: исход читает и окно, а его типы видят только protocol и core.
 */
export type SendReason =
  | 'blocked' // агент ждёт разрешения или ответа: текст не вставлен
  | 'busy' // указатель будильника или прошлый pty.send ждут своего Enter: не вставлен
  | 'no-paste-mode' // многострочный текст, а агент не включил bracketed paste: не вставлен
  | 'draft' // вставлен без Enter: в поле ввода черновик
  | 'input' // вставлен без Enter: человек печатал в окне ожидания Enter
  | 'restarted'; // вставлен без Enter: процесс сессии сменился за ожидание

export interface SendResult {
  inserted: boolean;
  submitted: boolean;
  reason: SendReason | null;
}

export type ErrorCode =
  | 'unauthorized'
  | 'protocol_mismatch'
  | 'bad_request'
  | 'unknown_method'
  | 'not_found'
  | 'conflict'
  | 'internal';

/** `data` — машинные подробности: у `protocol_mismatch` это `{ hostVersion, liveSessions }`. */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export interface WorksSnapshot {
  entries: WorkEntry[];
  branches: Record<string, string | null>;
}
