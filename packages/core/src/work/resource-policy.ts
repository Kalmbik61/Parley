/**
 * Бюджет работы и комнаты (P37, A11/A25 аудита): сколько сессий живёт одновременно, сколько новых заводят агенты,
 * сколько запусков и возобновлений за скользящий час, сколько писем и адресатов.
 *
 * Модуль чистый — без файлов и процессов: правила применяются к `WorkMap` внутри мутатора `updateMap`, то есть под
 * тем же замком, что и сама операция. Поэтому проверка и резерв атомарны, а израсходованное лежит в самой карте и переживает перезапуск хоста. Окно и пороги — счётчики
 * запусков и писем: жёсткого денежного потолка у провайдеров нет, и бюджет его не обещает (`RESOURCE_COVERAGE`).
 *
 * Резерв берётся до операции и закрывается её исходом: `spent` — случилась, `released` — отменена владельцем.
 * Освободить можно только свой ещё ожидающий слот. Резерв, чей владелец неизвестен (другое поколение хоста), не
 * снимается по сроку: он считается занятым, пока не появится свидетельство в карте или его не подхватит повторная
 * попытка той же сессии, которая второй раз не списывается.
 */

import type { LetterTx } from './letter-store.js';
import { HUMAN, PARLEY, SYSTEM } from './types.js';
import type { WorkSwarm } from './swarms.js';
import type { Message, ResourceAttempt, ResourceKind, WindowWorkMap, WorkMap, WorkResources } from './types.js';

/** Скользящее окно запусков, возобновлений и писем. */
export const RESOURCE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Пороги бюджета. Ключи совпадают с настройками (`ParleyConfig`): человек видит и меняет их в окне, агент —
 * нет. Комнатные пороги уже рабочих: комната тратит из общего бюджета работы, а не рядом с ним.
 */
export interface ResourceLimits {
  /** Одновременно живых и заранее занятых сессий в работе. */
  workConcurrent: number;
  /** То же в одной комнате. */
  roomConcurrent: number;
  /** Новых сессий от агентов за всё время работы. */
  workNewSessions: number;
  /** То же на комнату породившего агента. */
  roomNewSessions: number;
  /** Запусков, возобновлений и повторов за скользящий час в работе. */
  workLaunches: number;
  /** То же в комнате. */
  roomLaunches: number;
  /** Писем от агентов за скользящий час в работе (приглашения — тоже письма). */
  workMessages: number;
  /** То же в комнате. */
  roomMessages: number;
  /** Адресатов, которым агенты доставили письма за скользящий час в работе. */
  fanout: number;
  /** Участников одного роя, королева включена. */
  swarmSessions: number;
  /** Одновременно живых и заказанных участников одного роя. */
  swarmConcurrent: number;
  /** Сессий роёв, созданных агентами, за всё время работы. */
  workSwarmSessions: number;
  /** Роёв, созданных агентами, за всё время работы. */
  workSwarms: number;
  /** Срок жизни одного роя в минутах от создания; 0 — без срока. */
  swarmMinutes: number;
}

/**
 * Умолчания рассчитаны на работу из двух-трёх команд по шесть-восемь агентов; человек меняет их в настройках.
 * Пороги писем и адресатов остаются прежними — главная защита от разгона.
 */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = {
  workConcurrent: 24,
  roomConcurrent: 12,
  workNewSessions: 50,
  roomNewSessions: 12,
  workLaunches: 60,
  roomLaunches: 20,
  workMessages: 200,
  roomMessages: 100,
  fanout: 400,
  swarmSessions: 16,
  swarmConcurrent: 8,
  workSwarmSessions: 64,
  workSwarms: 6,
  swarmMinutes: 90,
};

export const RESOURCE_LIMIT_KEYS = Object.keys(DEFAULT_RESOURCE_LIMITS) as ReadonlyArray<keyof ResourceLimits>;

/**
 * Границы значений настройки: ноль новых сессий, сессий роёв и роёв разрешён (агентам породить нельзя), прочие пороги —
 * от единицы; рой — от двух (королева и хотя бы один участник); ноль `swarmMinutes` — рой без срока жизни.
 */
export const RESOURCE_LIMIT_BOUNDS: Readonly<Record<keyof ResourceLimits, { min: number; max: number }>> = {
  workConcurrent: { min: 1, max: 64 },
  roomConcurrent: { min: 1, max: 64 },
  workNewSessions: { min: 0, max: 1000 },
  roomNewSessions: { min: 0, max: 1000 },
  workLaunches: { min: 1, max: 1000 },
  roomLaunches: { min: 1, max: 1000 },
  workMessages: { min: 1, max: 10_000 },
  roomMessages: { min: 1, max: 10_000 },
  fanout: { min: 1, max: 100_000 },
  swarmSessions: { min: 2, max: 64 },
  swarmConcurrent: { min: 2, max: 64 },
  workSwarmSessions: { min: 0, max: 1000 },
  workSwarms: { min: 0, max: 100 },
  swarmMinutes: { min: 0, max: 1440 },
};

/** Из любого объекта с ключами порогов (настройки целиком) берёт только пороги. */
export function limitsFromConfig(config: ResourceLimits): ResourceLimits {
  const limits = { ...DEFAULT_RESOURCE_LIMITS };
  for (const key of RESOURCE_LIMIT_KEYS) limits[key] = config[key];
  return limits;
}

/**
 * Что бюджет считает и чего нет. Неполнота названа прямо: подагенты и форки, которые CLI запускает внутри сессии
 * сам, и сессии, начатые в терминале мимо Parley, сюда не попадают, и обходом, предотвращённым бюджетом, они не
 * называются. Токены и деньги бюджет тоже не считает.
 */
export const RESOURCE_COVERAGE = {
  completeness: 'partial',
  counted: [
    'wake resumes',
    'launches and resumes started from the window',
    'send_message and room invitations',
  ],
  notCounted: [
    'subagents or forks a CLI starts inside its own session',
    'sessions started in a terminal outside Parley',
    'tokens, cache or money',
  ],
} as const;

/** Что делать, когда бюджет исчерпан: расширяет его только человек. */
export const REQUEST_BUDGET_EXTENSION =
  'Only the human can raise this limit (Parley Settings, Limits). Call report, tell the human, and wait.';

export type ResourceDeniedCode =
  | 'concurrent'
  | 'new-sessions'
  | 'launches'
  | 'resume-rate'
  | 'messages'
  | 'fanout'
  | 'swarms'
  | 'swarm-sessions'
  | 'swarm-concurrent'
  | 'swarm-total';

/** Область отказа: `swarm` — пороги роёв (один рой или все рои работы, смотря по коду). */
export type ResourceDeniedScope = 'work' | 'room' | 'session' | 'swarm';

/** Бюджет исчерпан: безопасный исход вместо операции. Ничего не записано, модель не запущена. */
export class ResourceDeniedError extends Error {
  readonly code: ResourceDeniedCode;
  readonly scope: ResourceDeniedScope;
  readonly limit: number;
  readonly used: number;

  constructor(code: ResourceDeniedCode, scope: ResourceDeniedScope, used: number, limit: number) {
    super(`${DENIED_TEXT[code](scope, used, limit)}`);
    this.name = 'ResourceDeniedError';
    this.code = code;
    this.scope = scope;
    this.limit = limit;
    this.used = used;
  }
}

const where = (scope: ResourceDeniedScope): string =>
  scope === 'room' ? 'in this room' : scope === 'session' ? 'for this session' : scope === 'swarm' ? 'in this swarm' : 'in this workspace';

const DENIED_TEXT: Record<ResourceDeniedCode, (scope: ResourceDeniedScope, used: number, limit: number) => string> = {
  concurrent: (scope, used, limit) =>
    `session limit reached: ${used} of ${limit} sessions are running or reserved ${where(scope)}; stop one or raise the limit in Settings`,
  'new-sessions': (scope, used, limit) =>
    `new-session limit reached: agents already created ${used} of ${limit} sessions ${where(scope)}; raise the limit in Settings`,
  launches: (scope, used, limit) =>
    `launch limit reached: ${used} of ${limit} launches and resumes in the last hour ${where(scope)}; wait or raise the limit in Settings`,
  'resume-rate': (_scope, used, limit) =>
    `resume limit reached: ${used} of ${limit} resumes of this session in the last hour; wait or raise the limit in Settings`,
  messages: (scope, used, limit) =>
    `message limit reached: ${used} of ${limit} agent messages in the last hour ${where(scope)}; wait or raise the limit in Settings`,
  fanout: (scope, used, limit) =>
    `delivery limit reached: ${used} of ${limit} message deliveries in the last hour ${where(scope)}; wait or raise the limit in Settings`,
  // Область у всех четырёх `swarm`, но фразу каждый код строит сам: `swarms` и `swarm-total` считают всю работу.
  swarms: (_scope, used, limit) =>
    `swarm limit reached: agents already created ${used} of ${limit} swarms in this workspace; raise the limit in Settings`,
  'swarm-sessions': (_scope, used, limit) =>
    `swarm size limit reached: ${used} of ${limit} sessions already belong to this swarm; raise the limit in Settings`,
  'swarm-concurrent': (_scope, used, limit) =>
    `swarm concurrency limit reached: ${used} of ${limit} sessions of this swarm are running or reserved; wait for one to hand in or raise the limit in Settings`,
  'swarm-total': (_scope, used, limit) =>
    `swarm session limit reached: agents already created ${used} of ${limit} swarm sessions in this workspace; raise the limit in Settings`,
};

/** Текст отказа агенту: причина и что делать — расширение бюджета за человеком. */
export const deniedForAgent = (error: ResourceDeniedError): string =>
  `${error.message}. ${REQUEST_BUDGET_EXTENSION}`;

const isAgentSender = (from: string): boolean => from !== HUMAN && from !== SYSTEM && from !== PARLEY;

const within = (at: string, now: number): boolean => now - Date.parse(at) < RESOURCE_WINDOW_MS;

/** Рабочая комната сессии по members; одна на сессию. `null` — сессия вне комнат. */
export function roomOfSession(map: WorkMap, sessionId: string): string | null {
  const room = map.rooms.find((candidate) => candidate.members.includes(sessionId));
  return room === undefined ? null : room.id;
}

function ensureResources(map: WorkMap): WorkResources {
  map.resources ??= { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [] };
  return map.resources;
}

const nextAttemptId = (resources: WorkResources): string => {
  resources.seq += 1;
  return `a-${String(resources.seq).padStart(4, '0')}`;
};

/**
 * Свидетельства в карте закрывают ожидающие резервы без таймера: сессии нет или она закрыта — операции уже не
 * будет (`released`); переход в `active` после резерва — операция случилась (`spent`). Нет свидетельства — резерв
 * остаётся: срок сам по себе ничего не доказывает.
 */
export function settleByEvidence(map: WorkMap, now: number = Date.now()): void {
  const resources = map.resources;
  if (resources === undefined) return;
  const at = new Date(now).toISOString();
  for (const attempt of resources.attempts) {
    if (attempt.state !== 'reserved' || attempt.kind === 'spawn') continue;
    const session = map.sessions.find((candidate) => candidate.id === attempt.session);
    if (session === undefined || session.lifecycle === 'closed') {
      attempt.state = 'released';
      attempt.settledAt = at;
    } else if (session.history.some((step) => step.event === 'active' && Date.parse(step.at) >= Date.parse(attempt.at))) {
      // Переход в `active` после резерва: так видно и первый запуск, и возобновление (`startedAt` остаётся от первого).
      attempt.state = 'spent';
      attempt.settledAt = at;
    }
  }
}

/** Старые закрытые попытки свёрнуты: счётчики новых сессий хранятся отдельно, окну нужен только последний час. */
function prune(resources: WorkResources, now: number): void {
  resources.attempts = resources.attempts.filter(
    (attempt) => attempt.state === 'reserved' || within(attempt.settledAt ?? attempt.at, now),
  );
}

/** Занятые слоты: живые, заранее заказанные агентом (`pending` с родителем) и сессии с ожидающим резервом. */
function occupied(map: WorkMap): Set<string> {
  const ids = new Set<string>();
  for (const session of map.sessions) {
    if (session.lifecycle === 'active' || (session.lifecycle === 'pending' && session.parent !== null)) ids.add(session.id);
  }
  for (const attempt of map.resources?.attempts ?? []) {
    if (attempt.state === 'reserved' && attempt.kind !== 'spawn') ids.add(attempt.session);
  }
  return ids;
}

const launchAttempts = (map: WorkMap, now: number): ResourceAttempt[] =>
  (map.resources?.attempts ?? []).filter(
    (attempt) => attempt.kind !== 'spawn' && attempt.state !== 'released' && within(attempt.at, now),
  );

const inRoom = (map: WorkMap, ids: Iterable<string>, roomId: string): number => {
  let count = 0;
  for (const id of ids) if (roomOfSession(map, id) === roomId) count += 1;
  return count;
};

export interface ReserveRequest {
  /** `launch`/`retry` — запуск, `resume` — возобновление; новые spawn не создаются. */
  kind: Exclude<ResourceKind, 'spawn'>;
  /** `human`, `wake` или `auto`. */
  actor: string;
  session: string;
  /** Поколение того, кто резервирует: рестарт хоста — новое значение. */
  owner: string;
  limits: ResourceLimits;
  /** Возобновлений одной сессии за час (`resumeRate`): задаётся только будильнику. */
  sessionResumeRate?: number;
  now?: number;
}

/**
 * Вид попытки по карте: возобновление — `resume`; запуск сессии, у которой уже была удавшаяся попытка в журнале, —
 * `retry`; иначе `launch`.
 */
export function attemptKindFor(map: WorkMap, sessionId: string, mode: 'launch' | 'resume' | 'new'): Exclude<ResourceKind, 'spawn'> {
  if (mode === 'resume') return 'resume';
  const spentBefore = (map.resources?.attempts ?? []).some(
    (attempt) => attempt.kind !== 'spawn' && attempt.session === sessionId && attempt.state === 'spent',
  );
  return spentBefore ? 'retry' : 'launch';
}

/**
 * Резерв слота под запуск или возобновление: окно запусков, слоты одновременных сессий, при возобновлении будильником
 * ещё и частота по самой сессии. Нерешённый резерв той же сессии — повтор прежней попытки: его подхватывает новый
 * владелец, второй раз он не списывается. Отказ — исключение, карта не меняется.
 */
export function reserveAttempt(map: WorkMap, request: ReserveRequest): ResourceAttempt {
  const now = request.now ?? Date.now();
  const { limits, session } = request;
  settleByEvidence(map, now);
  const resources = ensureResources(map);
  prune(resources, now);

  const pending = resources.attempts.find(
    (attempt) => attempt.state === 'reserved' && attempt.kind !== 'spawn' && attempt.session === session,
  );
  if (pending !== undefined) {
    pending.owner = request.owner;
    return pending;
  }

  const room = roomOfSession(map, session);

  if (request.kind === 'resume' && request.sessionResumeRate !== undefined) {
    const taken = launchAttempts(map, now).filter((attempt) => attempt.kind === 'resume' && attempt.session === session).length;
    if (taken >= request.sessionResumeRate) throw new ResourceDeniedError('resume-rate', 'session', taken, request.sessionResumeRate);
  }

  const recent = launchAttempts(map, now);
  if (recent.length >= limits.workLaunches) throw new ResourceDeniedError('launches', 'work', recent.length, limits.workLaunches);
  if (room !== null) {
    const recentInRoom = recent.filter((attempt) => attempt.room === room).length;
    if (recentInRoom >= limits.roomLaunches) throw new ResourceDeniedError('launches', 'room', recentInRoom, limits.roomLaunches);
  }

  const others = occupied(map);
  others.delete(session);
  if (others.size + 1 > limits.workConcurrent) throw new ResourceDeniedError('concurrent', 'work', others.size, limits.workConcurrent);
  if (room !== null) {
    const othersInRoom = inRoom(map, others, room);
    if (othersInRoom + 1 > limits.roomConcurrent) throw new ResourceDeniedError('concurrent', 'room', othersInRoom, limits.roomConcurrent);
  }

  const attempt: ResourceAttempt = {
    id: nextAttemptId(resources),
    kind: request.kind,
    state: 'reserved',
    at: new Date(now).toISOString(),
    actor: request.actor,
    session,
    room,
    owner: request.owner,
  };
  resources.attempts.push(attempt);
  return attempt;
}

/**
 * Закрывает ожидающий резерв исходом. Трогает только свой слот: чужое поколение, закрытая или неизвестная попытка —
 * `false`, карта не меняется. Отмена (`released`) возвращает слот в окно; подтверждение (`spent`) оставляет его
 * потраченным.
 */
export function settleAttempt(
  map: WorkMap,
  attemptId: string,
  owner: string,
  outcome: 'spent' | 'released',
  now: number = Date.now(),
): boolean {
  const attempt = map.resources?.attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined || attempt.state !== 'reserved' || attempt.owner !== owner) return false;
  attempt.state = outcome;
  attempt.settledAt = new Date(now).toISOString();
  return true;
}

export interface SwarmSpawnRequest {
  /** Рой, в который добавляют участника; `null` — рой создаётся вместе с королевой. */
  swarm: WorkSwarm | null;
  /** Создаётся рой (`create_swarm`), а не участник существующего. */
  creatingSwarm: boolean;
  /** Действие агента: считается в `workSwarmSessions` и `workSwarms`. Королева роя человека (`swarms.create`) не считается. */
  byAgent: boolean;
}

/**
 * Пороги роёв для новой сессии роя (спека роя, 5), в порядке спеки: размер роя → сессии роёв работы (для нового роя ещё
 * и число роёв) → живые участники роя. Закрытость роя (`swarm-closed`) — код хоста, не бюджета: вызывающий проверяет её
 * раньше, а общий `reserveAttempt` берёт после. Карту не меняет; отказ возвращается, а не бросается, чтобы хост сам
 * решил, где поднять `ResourceDeniedError`. Счётчики растут только у хоста, в той же записи карты.
 */
export function checkSwarmSpawn(map: WorkMap, limits: ResourceLimits, request: SwarmSpawnRequest): ResourceDeniedError | null {
  const { swarm, creatingSwarm, byAgent } = request;
  if (swarm !== null && swarm.members.length >= limits.swarmSessions) {
    return new ResourceDeniedError('swarm-sessions', 'swarm', swarm.members.length, limits.swarmSessions);
  }
  if (byAgent) {
    const spawned = map.resources?.swarmSpawned ?? 0;
    if (spawned >= limits.workSwarmSessions) return new ResourceDeniedError('swarm-total', 'swarm', spawned, limits.workSwarmSessions);
    if (creatingSwarm) {
      const created = map.resources?.swarmsCreated ?? 0;
      if (created >= limits.workSwarms) return new ResourceDeniedError('swarms', 'swarm', created, limits.workSwarms);
    }
  }
  if (swarm !== null) {
    // Заказанный, но не стартовавший участник занимает место и без родителя: `occupied` берёт `pending` только с ним.
    // Сдавший места не держит: его сессию хост закрывает следом (спека роя, 5).
    const busy = occupied(map);
    for (const session of map.sessions) if (session.lifecycle === 'pending') busy.add(session.id);
    const used = swarm.members.filter((member) => member.handedAt === null && busy.has(member.sessionId)).length;
    if (used >= limits.swarmConcurrent) return new ResourceDeniedError('swarm-concurrent', 'swarm', used, limits.swarmConcurrent);
  }
  return null;
}

export interface MessageRequest {
  actor: string;
  /** Комната письма; `null` — прямое письмо. */
  room: string | null;
  /** Сколько писем добавится (приглашения — по числу приглашённых). */
  messages: number;
  /** Сколько адресатов получат их всего. */
  recipients: number;
  limits: ResourceLimits;
  now?: number;
}

/**
 * Сколько адресатов получат письмо: так же, как `recipientsOf` (рассылка комнаты — все участники, кроме отправителя),
 * но без файлового кода: модуль общий с окном.
 */
export function countRecipients(map: WorkMap, from: string, roomId: string | null, to: readonly string[]): number {
  if (roomId === null || to.length > 0) return to.length;
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) return 0;
  const members = new Set(room.members);
  members.delete(HUMAN);
  members.delete(from);
  return members.size;
}

const recipientCount = (message: Message, map: WorkMap): number =>
  countRecipients(map, message.from, message.roomId, message.to);

/**
 * Бюджет писем работы и комнаты: сколько писем и адресатов агенты уже разослали за час. Личный потолок сессии
 * (`messageRate`) проверяет `send_message`; здесь — общий. Письма человека, хоста и плана (`human`, `system`, `parley`)
 * не считаются и не блокируются: остановка, ошибки и управление идут мимо разговорной квоты.
 */
export function assertMessageBudget(map: WorkMap, letters: LetterTx, request: MessageRequest): void {
  const now = request.now ?? Date.now();
  const { limits } = request;
  // Окно «последний час» — запросы по индексу времени, а не обход всей ленты; письма человека, хоста и плана отсеивает
  // сам запрос (`agentsOnly`), а читаются только письма агентов и только после проверки счётчиков: их не больше
  // `workMessages` (спека хранилища 6.2).
  const window = { sinceAt: new Date(now - RESOURCE_WINDOW_MS).toISOString(), agentsOnly: true };
  const recentCount = letters.count(window);

  if (recentCount + request.messages > limits.workMessages) {
    throw new ResourceDeniedError('messages', 'work', recentCount, limits.workMessages);
  }
  if (request.room !== null) {
    const inThisRoom = letters.count({ ...window, roomId: request.room });
    if (inThisRoom + request.messages > limits.roomMessages) {
      throw new ResourceDeniedError('messages', 'room', inThisRoom, limits.roomMessages);
    }
  }
  const recent = letters.query({ ...window, limit: recentCount });
  const delivered = recent.reduce((sum, message) => sum + recipientCount(message, map), 0);
  if (delivered + request.recipients > limits.fanout) {
    throw new ResourceDeniedError('fanout', 'work', delivered, limits.fanout);
  }
}

export interface Meter {
  used: number;
  /** Занято заранее: ожидающие резервы и заказанные сессии. */
  reserved: number;
  limit: number;
  remaining: number;
}

export interface ScopeStatus {
  concurrent: Meter;
  newSessions: Meter;
  launches: Meter;
  messages: Meter;
}

export interface ResourceStatus {
  work: ScopeStatus & { fanout: Meter; swarmSessions: Meter; swarms: Meter };
  /** `null` — комната не названа. */
  room: ScopeStatus | null;
  /** Резервы чужого поколения без свидетельств: считаются занятыми, пока их не закроет свидетельство или повтор. */
  ambiguous: number;
  /** Исчерпанные пороги — причины, по которым новая операция безопасно не начнётся. */
  exhausted: ResourceDeniedCode[];
  coverage: typeof RESOURCE_COVERAGE;
  /** Без жёсткого денежного лимита: это счётчики запусков и писем. */
  monetaryCap: false;
}

const meter = (used: number, reserved: number, limit: number): Meter => ({
  used,
  reserved,
  limit,
  remaining: Math.max(0, limit - used - reserved),
});

/**
 * Состояние бюджета для окна и отчётов: сколько использовано, занято заранее и осталось, по работе и по комнате.
 * Ничего не меняет в карте: читает копию журнала и считает так же, как допуск.
 */
export function resourceStatus(
  map: WindowWorkMap,
  limits: ResourceLimits,
  now: number = Date.now(),
  roomId: string | null = null,
  owner: string | null = null,
): ResourceStatus {
  const resources = map.resources;
  const recent = launchAttempts(map, now);
  const live = map.sessions.filter((session) => session.lifecycle === 'active').map((session) => session.id);
  const liveSet = new Set(live);
  const busy = occupied(map);
  const reservedIds = [...busy].filter((id) => !liveSet.has(id));

  const scope = (inScope: (id: string) => boolean, launches: ResourceAttempt[], spawned: number, limit: {
    concurrent: number; newSessions: number; launches: number; messages: number;
  }, messages: number): ScopeStatus => ({
    concurrent: meter(live.filter(inScope).length, reservedIds.filter(inScope).length, limit.concurrent),
    newSessions: meter(spawned, 0, limit.newSessions),
    launches: meter(launches.filter((attempt) => attempt.state === 'spent').length, launches.filter((attempt) => attempt.state === 'reserved').length, limit.launches),
    messages: meter(messages, 0, limit.messages),
  });

  const agentRecent = map.messages.filter((message) => isAgentSender(message.from) && within(message.at, now));
  const work = scope(() => true, recent, resources?.spawned ?? 0, {
    concurrent: limits.workConcurrent, newSessions: limits.workNewSessions, launches: limits.workLaunches, messages: limits.workMessages,
  }, agentRecent.length);
  const delivered = agentRecent.reduce((sum, message) => sum + recipientCount(message, map), 0);

  const room = roomId === null
    ? null
    : scope((id) => roomOfSession(map, id) === roomId, recent.filter((attempt) => attempt.room === roomId),
      resources?.spawnedByRoom[roomId] ?? 0, {
        concurrent: limits.roomConcurrent, newSessions: limits.roomNewSessions, launches: limits.roomLaunches, messages: limits.roomMessages,
      }, agentRecent.filter((message) => message.roomId === roomId).length);

  const exhausted = new Set<ResourceDeniedCode>();
  const check = (status: ScopeStatus): void => {
    if (status.concurrent.remaining === 0) exhausted.add('concurrent');
    if (status.newSessions.remaining === 0) exhausted.add('new-sessions');
    if (status.launches.remaining === 0) exhausted.add('launches');
    if (status.messages.remaining === 0) exhausted.add('messages');
  };
  check(work);
  if (room !== null) check(room);
  if (delivered >= limits.fanout) exhausted.add('fanout');
  const swarmSessions = meter(resources?.swarmSpawned ?? 0, 0, limits.workSwarmSessions);
  const swarms = meter(resources?.swarmsCreated ?? 0, 0, limits.workSwarms);
  if (swarmSessions.remaining === 0) exhausted.add('swarm-total');
  if (swarms.remaining === 0) exhausted.add('swarms');

  return {
    work: { ...work, fanout: meter(delivered, 0, limits.fanout), swarmSessions, swarms },
    room,
    ambiguous: (resources?.attempts ?? []).filter(
      (attempt) => attempt.state === 'reserved' && owner !== null && attempt.owner !== owner,
    ).length,
    exhausted: [...exhausted],
    coverage: RESOURCE_COVERAGE,
    monetaryCap: false,
  };
}

/**
 * Хватит ли бюджета на старт команды из `count` участников: сколько слотов и запусков нужно, а сколько осталось.
 * Комната из `count` агентов не может работать целиком, если её порог `roomConcurrent` меньше. Считаются только
 * нужные участники: лишней временной сессии под старт команды нет.
 */
export function teamStartFits(
  status: ResourceStatus,
  count: number,
  roomConcurrent?: number,
): { fits: boolean; reason: ResourceDeniedCode | null; scope: 'work' | 'room' | null; needed: number; remaining: number } {
  if (count > status.work.concurrent.remaining) {
    return { fits: false, reason: 'concurrent', scope: 'work', needed: count, remaining: status.work.concurrent.remaining };
  }
  if (count > status.work.launches.remaining) {
    return { fits: false, reason: 'launches', scope: 'work', needed: count, remaining: status.work.launches.remaining };
  }
  if (roomConcurrent !== undefined && count > roomConcurrent) {
    return { fits: false, reason: 'concurrent', scope: 'room', needed: count, remaining: roomConcurrent };
  }
  return { fits: true, reason: null, scope: null, needed: count, remaining: status.work.concurrent.remaining };
}

/** Проверка формы журнала при чтении карты: битый журнал не молчаливый нулевой бюджет, а отказ читать. */
export function validateResources(map: WorkMap): void {
  const resources: unknown = map.resources;
  if (resources === undefined) return;
  const bad = (): never => {
    throw new Error('invalid resource ledger');
  };
  if (typeof resources !== 'object' || resources === null || Array.isArray(resources)) return bad();
  const { seq, spawned, spawnedByRoom, attempts, swarmSpawned, swarmsCreated } = resources as Record<string, unknown>;
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(spawned) || (seq as number) < 0 || (spawned as number) < 0) return bad();
  if (typeof spawnedByRoom !== 'object' || spawnedByRoom === null || Array.isArray(spawnedByRoom)) return bad();
  if (!Object.values(spawnedByRoom).every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) return bad();
  for (const counter of [swarmSpawned, swarmsCreated]) {
    if (counter !== undefined && (!Number.isSafeInteger(counter) || (counter as number) < 0)) return bad();
  }
  if (!Array.isArray(attempts)) return bad();
  for (const attempt of attempts as unknown[]) {
    if (typeof attempt !== 'object' || attempt === null) return bad();
    const row = attempt as Record<string, unknown>;
    if (
      typeof row['id'] !== 'string' || !['spawn', 'launch', 'resume', 'retry'].includes(String(row['kind'])) ||
      !['reserved', 'spent', 'released'].includes(String(row['state'])) || typeof row['at'] !== 'string' ||
      !Number.isFinite(Date.parse(row['at'])) || typeof row['actor'] !== 'string' || typeof row['session'] !== 'string' ||
      (row['room'] !== null && typeof row['room'] !== 'string') || typeof row['owner'] !== 'string'
    ) return bad();
  }
}
