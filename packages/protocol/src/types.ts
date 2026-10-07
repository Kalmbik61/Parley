import type { UsageSummary, WorkEntry } from '@parley/core';

/**
 * Лимиты подписки провайдера (спека комнат Organic, 3.5): пятичасовое и недельное окна и время, когда
 * CLI отдал числа. Типы живут в core — их же разбирают читатели логов, — а по проводу ходят как есть.
 */
export type { LimitWindow, ProviderLimits } from '@parley/core';

/**
 * Почему не удалась явная проверка ключа Z.ai (`providers.check`): закрытый список, по которому окно
 * выбирает подпись и подсказку. Сам ответ Z.ai по проводу не ходит — только HTTP-статус и код.
 * - `authentication` — 401, коды 1000–1005: ключ неверный или истёк;
 * - `plan_expired` — 1309, 1314: подписка кончилась;
 * - `no_plan` — 1113: у ключа нет подписки или баланса;
 * - `limit_reached` — 1308, 1310, 1316–1321: лимит пяти часов или недели исчерпан, ключ рабочий;
 * - `model_unavailable` — 1311: тариф не даёт модель GLM-сессий;
 * - `key_restricted` — 403, 1220, 1313, 1315: Z.ai ограничил ключ;
 * - `rate_limited` — 1302, 1305 и прочие 429: частота запросов или перегрузка;
 * - `server_error` — 5xx, 1200, 1230, 1234: сбой на стороне Z.ai;
 * - `timeout` — ответа нет за отведённое время;
 * - `network` — запрос не дошёл: DNS, TLS, офлайн, прокси;
 * - `unsupported_response` — ответ незнакомого вида или Z.ai не понял наш запрос (1210–1215, 1221, 1222,
 *   1261, 1301: неизвестная модель или способ вызова, неверные поля, снятый API).
 */
export const PROVIDER_CHECK_REASONS = [
  'authentication',
  'plan_expired',
  'no_plan',
  'limit_reached',
  'model_unavailable',
  'key_restricted',
  'rate_limited',
  'server_error',
  'timeout',
  'network',
  'unsupported_response',
] as const;
export type ProviderCheckReason = (typeof PROVIDER_CHECK_REASONS)[number];

/**
 * Исход последней явной проверки сохранённого ключа Z.ai: тестовое сообщение в эндпоинт, с которым
 * работают GLM-сессии (`providers.check`, по Check again и после сохранения ключа).
 */
export interface ProviderCheck {
  state: 'ok' | 'failed';
  /** Почему не удалось; у `state: 'ok'` поля нет. */
  reason?: ProviderCheckReason;
  /** HTTP-статус ответа Z.ai; нет — ответа не было (таймаут, сеть) или он был успешным. */
  httpStatus?: number;
  /** Код ошибки Z.ai (`error.code`), только цифры; нет — Z.ai кода не прислал. */
  code?: string;
  /** Когда проверка закончилась, ISO 8601. */
  at: string;
}

/**
 * Модель в списке провайдера (`providers.list`, дизайн комнат, 3.2): `id` — значение `--model`,
 * `label` — подпись для окна, `efforts` — её уровни effort (нормалайзер модели и effort, 5.1). Уровень
 * (`EffortOption`): `id` — значение флага, `label` — подпись, `description` — пояснение каталога CLI.
 * Типы живут в core рядом с реестром, откуда список и берётся.
 */
export type { EffortOption, ModelOption } from '@parley/core';
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
  /**
   * Токены с происхождением: кэш (`null` — не сообщено), полный вход, источник, время наблюдения,
   * устарелость и полнота (P36). Без нативных id и путей. Поля нет у хоста более ранней версии: окно
   * показывает `tokensIn`/`tokensOut` как раньше. Это токены, а не деньги и не доля лимита подписки.
   */
  usage?: UsageSummary;
  /** Вход без кэша; `null` — не известен. */
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
  | 'skill-foreign'
  // Даже компактный снимок работ не влезает в кадр: окно остаётся с прежним, пока данные не уменьшатся (P35).
  | 'snapshot-too-large';

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
 *   хоста (раунд lane-r5);
 * - `client-upgrade-required` (`conflict`) — клиент без `compact-works`, а прежний полный снимок не влезает в кадр:
 *   обновите окно (P35);
 * - `snapshot-too-large` (`internal`) — даже компактный снимок работ не влезает в кадр (тысячи сессий или комнат):
 *   хост его не шлёт, окну остаётся сказать об этом человеку (P35).
 * - `busy` (`conflict`) — смену модели или effort идущей сессии хост сейчас не делает: агент работает или ждёт
 *   человека, держат фоновые задачи, в поле ввода терминала черновик, ползунок `/effort` уже открыт или идёт
 *   другая смена той же сессии (нормалайзер модели и effort, 5.7–5.8).
 */
export const HOST_ERROR_REASONS = {
  gitMissing: 'git-missing',
  notARepo: 'not-a-repo',
  noCommits: 'no-commits',
  worktreeMissing: 'worktree-missing',
  worktreeCorrupt: 'worktree-corrupt',
  worksUnreadable: 'works-unreadable',
  clientUpgradeRequired: 'client-upgrade-required',
  snapshotTooLarge: 'snapshot-too-large',
  busy: 'busy',
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
  /**
   * Номер снимка в жизни хоста: растёт на каждую рассылку. Окно применяет только снимок новее уже применённого, и
   * поздно пришедший старый ответ `works.list` не откатывает свежее событие. Нет поля — хост до P35.
   */
  revision?: number;
}
