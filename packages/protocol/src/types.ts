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
  | 'restarted' // вставлен без Enter: процесс сессии сменился за ожидание
  | 'blocked-before-enter'; // вставлен без Enter: за ожидание агент показал диалог (fix-final-b)

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

/**
 * Причины ошибок хоста — `data.reason` рядом с кодом (fix-lane-post, п. 3): хост их пишет, окно по ним
 * выбирает свой текст. Раньше строки жили отдельно в хосте и окне, и расхождение ловили только тесты.
 * Строки — часть протокола, менять их нельзя без обеих сторон.
 * - `git-missing` (`internal`), `not-a-repo`, `no-commits` (`bad_request`) — `GitStateError` из core (8.2a);
 * - `worktree-missing` (`bad_request`) — папки worktree сессии нет (раунд 8, пункт 1);
 * - `worktree-corrupt` (`bad_request`) — файл `.git` worktree не ведёт в зарегистрированный worktree
 *   проекта (подменён агентом): git в нём не запускается (раунд fix-final-a, п. 1);
 * - `works-unreadable` (`internal`) — первое чтение работ хостом отказало, снимка нет до перезапуска
 *   хоста (раунд lane-r5).
 */
export const HOST_ERROR_REASONS = {
  gitMissing: 'git-missing',
  notARepo: 'not-a-repo',
  noCommits: 'no-commits',
  worktreeMissing: 'worktree-missing',
  worktreeCorrupt: 'worktree-corrupt',
  worksUnreadable: 'works-unreadable',
} as const;

export type HostErrorReason = (typeof HOST_ERROR_REASONS)[keyof typeof HOST_ERROR_REASONS];

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
