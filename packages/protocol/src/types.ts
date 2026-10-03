import type { WorkEntry } from '@parley/core';

/**
 * Лимиты подписки провайдера (спека комнат Organic, 3.5): пятичасовое и недельное окна и время, когда
 * CLI отдал числа. Типы живут в core — их же разбирают читатели логов, — а по проводу ходят как есть.
 */
export type { LimitWindow, ProviderLimits } from '@parley/core';

/**
 * Модель в списке провайдера (`providers.list`, дизайн комнат, 3.2): `id` — значение `--model`,
 * `label` — подпись для окна. Тип живёт в core рядом с реестром, откуда список и берётся.
 */
export type { ModelOption } from '@parley/core';
/** Подсказки поля ввода вида «Chat» (`capabilities.list`): команды, скиллы и субагенты CLI провайдера. */
export type { Capabilities, CapabilityAgent, CapabilityCommand, CapabilitySkill, CapabilitySource } from '@parley/core';

/**
 * Лента вида «Chat» (план 2026-10-01, решение 14): элемент, решение окна и состояние карточки. Типы
 * живут в core рядом с редьюсером; схемы zod к ним — в `feed.ts`.
 */
export type { FeedCardState, FeedDecision, FeedItem } from '@parley/core';

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

/**
 * Живой субагент сессии для строки участника комнаты (`LiveMetrics.tasks`). Хост берёт описание из
 * снимка фоновых задач Claude Code, а если там его нет — из `meta.json` субагента; путь к
 * транскрипту, по которому он ищется, наружу не отдаётся.
 */
export interface LiveTask {
  id: string;
  /** `general-purpose`…; `null` — неизвестно. */
  agentType: string | null;
  /** Короткое описание задачи; `null` — неизвестно. */
  description: string | null;
  /** Фоновый: работает и после конца хода родителя. */
  background: boolean;
}

/**
 * Почему письма сессии ещё не забраны — причина будильника хоста; окно пишет её в комнате рядом с
 * «not picked up yet». Строки — часть протокола.
 * - `busy` — сессия занята ходом или ждёт ответа человека;
 * - `draft` — в поле ввода её терминала неотправленный текст;
 * - `no-hooks` — с запуска процесса не пришло ни одного хука (диалог доверия папке или входа);
 * - `in-flight` — указатель напечатан, ход по нему ещё не начался;
 * - `pointed` — указатель дошёл, но письма агент ещё не прочёл;
 * - `paused` — будильник на паузе;
 * - `sleeping` — сессия спит, и эти письма её не будят (лежали до старта хоста, подъём недоступен);
 * - `resuming` — хост поднимает сессию;
 * - `resume-limit` — исчерпан лимит подъёмов в час;
 * - `pending` — сессия ещё не запускалась.
 */
export type MailWait =
  | 'busy'
  | 'draft'
  | 'no-hooks'
  | 'in-flight'
  | 'pointed'
  | 'paused'
  | 'sleeping'
  | 'resuming'
  | 'resume-limit'
  | 'pending';

/** Живые цифры сессии для строки статуса и списка — `null`, пока их не видно. */
export interface LiveMetrics {
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  unread: number;
  subagents: number;
  model: string | null;
  /**
   * Живые субагенты; пустой список — их нет. Поля нет у хоста более ранней версии: окно читает
   * его как «неизвестно» и показывает то, что было, а не падает.
   */
  tasks?: LiveTask[];
  /**
   * На что ждёт `wait_for` этой сессии: id сессии (`s-03`) или `inbox`; `null` — не ждёт. Поля нет
   * у хоста более ранней версии, как и у `tasks`.
   */
  waitingFor?: string | null;
  /**
   * Почему непрочитанные письма сессии ещё не забраны; `null` — писем нет или причина не известна.
   * Поля нет у хоста более ранней версии.
   */
  mailWaiting?: MailWait | null;
}

/** Виды уведомлений хоста, для которых не нужен отдельный запрос-ответ. */
export type NoticeKind =
  | 'map-lock'
  | 'map-corrupt'
  | 'hooks-missing'
  | 'launch-failed'
  | 'parley-md-created'
  | 'parley-md-unreadable'
  | 'parley-md-truncated'
  | 'provider-override-gap'
  | 'role-missing'
  | 'memory-truncated'
  | 'memory-unreadable'
  | 'plan-effect-failed'
  | 'role-truncated'
  | 'recipe-playbook-truncated'
  | 'pointer-timeout'
  | 'pointer-cancelled'
  | 'resume-failed'
  | 'resume-limit'
  | 'trust-wait'
  // Codex не показал ни `Ready`, ни `Working` за срок после запуска: он на экране входа или доверия к папке,
  // и его проходит человек в терминале Codex. Сессия при этом «нужен ты» (`blocked`), а уведомление называет причину.
  | 'startup-wait'
  // Скилл `parley` не поставлен в проект: путь уже есть, а создал его не харнесс (или по дороге лежит
  // симлинк). Файл остаётся как есть; окно показывает короткую строку, подробности — в `host.log`.
  | 'skill-foreign';

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
