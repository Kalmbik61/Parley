// Белые списки роли `remote` по этапам (спека 4.2), запретный список (4.3) и правила параметров.
// Значения из корня протокола не импортируются: сверку с METHODS делает тест.

import { REMOTE_TEXT_LIMIT_BYTES, utf8Length } from './limits.js';
import { cardsParamRules } from './cards.js';
import { voiceParamRules } from './voice.js';

export { REMOTE_TEXT_LIMIT_BYTES };

export const REMOTE_PROTOCOL = 1;
/** The oldest phone app version (x.y.z) the bridge's hello accepts; the app's `version` in app.config.ts must not be lower. */
export const MIN_CLIENT_VERSION = '0.1.0';
export const REMOTE_POLICY_FEATURE = 'remote-policy-1';

export type RemoteStage = 'A' | 'B' | 'C';

const A_METHODS = [
  'works.list',
  'host.info',
  'feed.snapshot',
  'feed.decide',
  'rooms.resolveProposal',
  'context.messages',
  'context.letter',
  'context.text',
  // Запуск с телефона (решение 5, правки 11–12): хост пускает их только при включённом `remoteCreate`.
  'sessions.create',
  'rooms.create',
  'rooms.send',
  'providers.list',
  'roles.list',
  // Лента сессии, сообщения агенту, согласия и доверие к папке с телефона (правки 13 плана, спека 4.2).
  'feed.subscribe',
  'feed.unsubscribe',
  'pty.send',
  'consents.list',
  'consents.decide',
  'trust.check',
  // Пробуждение спящей сессии (решение человека 2026-11-03, правки 19): хост пускает только при `remoteCreate`.
  'sessions.resume',
  // Меню сессии (решение человека 2026-11-03, правки 20): Stop, Put to sleep, Close, замена провайдера — тоже за
  // `remoteCreate`.
  'feed.interrupt',
  'sessions.stop',
  'sessions.close',
  'sessions.switchOptions',
  'sessions.switchAgent',
  // Меню комнаты (решение человека 2026-11-03, правки 21): Archive и Delete — тоже за `remoteCreate`, с воротами по комнате.
  'rooms.archive',
  'rooms.delete',
  // Голос, jobs и карточки помощника с телефона (план голоса B3): `voice.session.prepare` хост пускает только при
  // включённом на Mac «Speak answers» (ключ OpenAI проверяет сам метод: `no_key`).
  'jobs.submit',
  'jobs.get',
  'jobs.cancel',
  'jobs.ackInline',
  'cards.decide',
  // Карточки помощника телефону (T4a): список активных и проекция; `assistant.*` по-прежнему закрыт.
  'cards.list',
  'voice.session.prepare',
  'voice.session.close',
  'voice.usage.get',
] as const;
const A_EVENTS = [
  'works.changed',
  'rooms.mail',
  'activity.changed',
  'host.notice',
  'feed.changed',
  'consents.changed',
  'jobs.changed',
  'cards.changed',
  'voice.session.closed',
] as const;

const B_METHODS = [
  'mail.markRead',
  'pty.attach',
  'pty.detach',
  'rooms.usage',
] as const;
const B_NOTIFICATIONS = ['activity.seen'] as const;
const B_EVENTS = [
  'pty.output',
  'pty.resync',
  'pty.exit',
  'providers.limitsChanged',
] as const;

export interface RemoteStageLists<M extends string, N extends string, E extends string> {
  readonly methods: readonly M[];
  readonly notifications: readonly N[];
  readonly events: readonly E[];
}

/** Списки накопительные: этап B содержит этап A. У этапа C методов сверх B нет: `sessions.create` переехал в A. */
export const REMOTE_STAGES = {
  A: { methods: A_METHODS, notifications: [], events: A_EVENTS },
  B: {
    methods: [...A_METHODS, ...B_METHODS],
    notifications: B_NOTIFICATIONS,
    events: [...A_EVENTS, ...B_EVENTS],
  },
  C: {
    methods: [...A_METHODS, ...B_METHODS],
    notifications: B_NOTIFICATIONS,
    events: [...A_EVENTS, ...B_EVENTS],
  },
} as const;

// Текущий этап — A.
export const REMOTE_METHODS = REMOTE_STAGES.A.methods;
export const REMOTE_NOTIFICATIONS = REMOTE_STAGES.A.notifications;
export const REMOTE_EVENTS = REMOTE_STAGES.A.events;

/**
 * Запрещено телефону всегда (спека 4.3). Только для тестов: хост и мост решают по белому списку.
 * Запись с `.*` на конце — префикс (`settings.*`).
 */
export const REMOTE_FORBIDDEN: readonly string[] = [
  'settings.*',
  'host.shutdown',
  'host.profile.*',
  'host.diagnostics',
  'wake.*',
  'pty.input',
  'pty.resize',
  'works.create',
  'works.delete',
  'works.rename',
  'works.setStatus',
  'sessions.delete',
  'sessions.setMode',
  'sessions.setEffort',
  'sessions.setModel',
  'sessions.compact',
  'sessions.cancelCompact',
  'sessions.resumeInterrupted',
  'sessions.rename',
  'rooms.addMember',
  'rooms.setLead',
  'rooms.setOwner',
  'rooms.reopen',
  'rooms.rename',
  'rooms.setMode',
  'worktrees.*',
  'changes.*',
  'providers.setKey',
  'providers.clearKey',
  'providers.check',
  'providers.refreshLimits',
  // Обновление и проверка версий CLI запускают процессы и ходят в сеть от имени хоста: только на Маке.
  'providers.update',
  'providers.checkUpdates',
  // Установка запускает скачанный код вендора от имени человека (спека Qwen, §4.2 п. 9): только на Маке.
  'providers.install',
  'telegram.*',
  'voiceProvider.*',
  'trust.grant',
  'trust.revoke',
  'trust.list',
  'capabilities.*',
  'memory.*',
  'backlog.*',
  'plans.*',
  'assistant.*',
  // Мост делегаций и телеметрия Live острова (T2, T6): только локальные методы хоста, телефону их не дают.
  'requests.*',
  'voice.telemetry.*',
  'browser.agentResult',
];

export function isRemoteForbidden(name: string): boolean {
  return REMOTE_FORBIDDEN.some(entry =>
    entry.endsWith('.*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );
}

function record(params: unknown): Record<string, unknown> | null {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : null;
}

/** `ref` сессии: строго `projectPath`, `workId`, `sessionId` — непустые строки. */
function sessionRef(value: unknown): boolean {
  const ref = record(value);
  return (
    ref !== null &&
    onlyKeys(ref, SESSION_REF_KEYS) &&
    [ref.projectPath, ref.workId, ref.sessionId].every(v => typeof v === 'string' && v.length > 0)
  );
}

/** `projectPath`, `workId`, `roomId` — непустые строки (как `roomId` у `rooms.send`). */
function roomRefStrings(p: Record<string, unknown>): boolean {
  return [p.projectPath, p.workId, p.roomId].every(v => typeof v === 'string' && v.length > 0);
}

/** Параметры — только `ref` сессии. */
function refOnly(params: unknown): boolean {
  const p = record(params);
  return p !== null && onlyKeys(p, REF_ONLY_KEYS) && sessionRef(p.ref);
}

/** Только эти ключи (спека 4.2: лишний ключ → `bad_request`). */
function onlyKeys(p: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(p).every(key => allowed.has(key));
}

function textUpTo(value: unknown, bytes: number): boolean {
  return typeof value === 'string' && utf8Length(value) <= bytes;
}

/** Длина в знаках (кодовых точках), не в единицах UTF-16. */
function charsBetween(value: unknown, min: number, max: number): boolean {
  if (typeof value !== 'string') return false;
  const n = Array.from(value).length;
  return n >= min && n <= max;
}

/**
 * `enabled` у `consents.decide` (A36a): массив не длиннее `REMOTE_MCP_ENABLED_MAX`, у пары строго `name` (1–200) и
 * `fingerprint` (sha256 hex). Совпадение пар с карточкой сверяет хост (`bad_request` на несовпавшую пару).
 */
function mcpPairs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > REMOTE_MCP_ENABLED_MAX) return false;
  return value.every(item => {
    const pair = record(item);
    return (
      pair !== null &&
      onlyKeys(pair, MCP_PAIR_KEYS) &&
      typeof pair.name === 'string' &&
      pair.name.length >= 1 &&
      pair.name.length <= MCP_NAME_MAX &&
      typeof pair.fingerprint === 'string' &&
      MCP_FINGERPRINT.test(pair.fingerprint)
    );
  });
}

const SESSION_CREATE_KEYS: ReadonlySet<string> = new Set([
  'projectPath',
  'workId',
  'provider',
  'label',
  'task',
  'parent',
  'model',
  'role',
  'worktree',
  'trustFolder',
]);
const PTY_SEND_KEYS: ReadonlySet<string> = new Set(['ref', 'text', 'submit', 'requestedAt', 'clientMsgId']);
const REF_ONLY_KEYS: ReadonlySet<string> = new Set(['ref']);
const SESSION_REF_KEYS: ReadonlySet<string> = new Set(['projectPath', 'workId', 'sessionId']);
/** `force` (замена при блокерах) — только из окна (спека 4.2, правки 20). */
const SWITCH_AGENT_KEYS: ReadonlySet<string> = new Set(['ref', 'requestId', 'provider', 'model', 'effort', 'carry']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Тот же токен, что `EFFORT_TOKEN_RE` схемы хоста. */
const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
export const REMOTE_PROVIDER_MAX = 64;
const MODEL_MAX = 200;
const CLIENT_MSG_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CONSENT_DECIDE_KEYS: ReadonlySet<string> = new Set(['id', 'decision', 'enabled', 'revision', 'roleChange']);
/** Пара сервера MCP из карточки `project-mcp` (спека 2026-11-02, 7.2): строго имя и отпечаток. */
const MCP_PAIR_KEYS: ReadonlySet<string> = new Set(['name', 'fingerprint']);
/** Отпечаток сервера MCP — sha256 в hex, как его считает хост. */
const MCP_FINGERPRINT = /^[0-9a-f]{64}$/;
/** Не больше пар, чем принимает схема хоста. */
export const REMOTE_MCP_ENABLED_MAX = 200;
const MCP_NAME_MAX = 200;
/** Номер карточки согласия хоста: `c-NN`. */
const CONSENT_ID = /^c-\d+$/;
const ROLE_CHANGE_KEYS: ReadonlySet<string> = new Set(['from', 'to']);
const ROLE_ID_MAX = 200;
/** Role change acknowledgement of an `agent-switch` card (spec 2026-11-12, 2.4): `{from, to}` only, `to` may be null. */
function roleChangeAck(value: unknown): boolean {
  const r = record(value);
  return r !== null && onlyKeys(r, ROLE_CHANGE_KEYS) && charsBetween(r.from, 1, ROLE_ID_MAX) && (r.to === null || (typeof r.to === 'string' && r.to.length <= ROLE_ID_MAX));
}
const ROOM_CREATE_KEYS: ReadonlySet<string> = new Set([
  'projectPath',
  'workId',
  'title',
  'members',
  'lead',
  'quiet',
  'mode',
]);
const ROOM_SEND_KEYS: ReadonlySet<string> = new Set([
  'projectPath',
  'workId',
  'roomId',
  'to',
  'text',
  'kind',
  'replyTo',
  'requestedAt',
]);
const ROOM_ARCHIVE_KEYS: ReadonlySet<string> = new Set(['projectPath', 'workId', 'roomId', 'stopSessions']);
const ROOM_DELETE_KEYS: ReadonlySet<string> = new Set(['projectPath', 'workId', 'roomId']);
const ROOM_MODES: ReadonlySet<unknown> = new Set(['free', 'checklist', 'verified']);
export const REMOTE_LABEL_MAX = 64;
export const REMOTE_ROOM_TITLE_MAX = 128;
export const REMOTE_ROOM_MEMBERS_MAX = 16;

/** Правило параметров: `true` — пропустить, `false` — `bad_request`. */
export type RemoteParamRule = (params: unknown) => boolean;

export const REMOTE_PARAM_RULES: Readonly<Record<string, RemoteParamRule>> = {
  ...voiceParamRules,
  ...cardsParamRules,
  // Этап A: без `rev` карточку решения можно принять, не видев её текста (спека 4.2).
  'rooms.resolveProposal': params => {
    const p = record(params);
    return p !== null && typeof p.rev === 'number' && Number.isInteger(p.rev) && p.rev >= 0;
  },
  // Запуск с телефона (спека 4.2): дочернюю сессию, `agent`, `effort` и `lean` с телефона не задать.
  'sessions.create': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, SESSION_CREATE_KEYS) &&
      (p.workId === null || (typeof p.workId === 'string' && p.workId.length > 0)) &&
      (p.trustFolder === undefined || typeof p.trustFolder === 'boolean') &&
      p.parent === null &&
      charsBetween(p.label, 1, REMOTE_LABEL_MAX) &&
      textUpTo(p.task, REMOTE_TEXT_LIMIT_BYTES)
    );
  },
  // `autonomous`, `recipe` и `origin` — только из окна: автономный режим и рецепт несут команды проверок.
  'rooms.create': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, ROOM_CREATE_KEYS) &&
      charsBetween(p.title, 1, REMOTE_ROOM_TITLE_MAX) &&
      Array.isArray(p.members) &&
      p.members.length >= 1 &&
      p.members.length <= REMOTE_ROOM_MEMBERS_MAX &&
      p.members.every(member => typeof member === 'string') &&
      (p.mode === undefined || ROOM_MODES.has(p.mode))
    );
  },
  // Только письмо в комнату (прямые письма сессиям — этап B) и без решений.
  'rooms.send': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, ROOM_SEND_KEYS) &&
      typeof p.roomId === 'string' &&
      p.roomId.length > 0 &&
      (p.kind === 'note' || p.kind === 'question') &&
      textUpTo(p.text, REMOTE_TEXT_LIMIT_BYTES)
    );
  },
  // Меню комнаты (спека 4.2, правки 21): ровно проект, работа и комната (непустые строки); у архива ещё `stopSessions`.
  'rooms.archive': params => {
    const p = record(params);
    return p !== null && onlyKeys(p, ROOM_ARCHIVE_KEYS) && roomRefStrings(p) && typeof p.stopSessions === 'boolean';
  },
  'rooms.delete': params => {
    const p = record(params);
    return p !== null && onlyKeys(p, ROOM_DELETE_KEYS) && roomRefStrings(p);
  },
  // Сообщение агенту: `clientMsgId` обязателен — по нему мост не пускает дубль при повторе.
  'pty.send': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, PTY_SEND_KEYS) &&
      typeof p.ref === 'object' &&
      p.ref !== null &&
      typeof p.text === 'string' &&
      p.text.length > 0 &&
      utf8Length(p.text) <= REMOTE_TEXT_LIMIT_BYTES &&
      typeof p.submit === 'boolean' &&
      (p.requestedAt === undefined || typeof p.requestedAt === 'number') &&
      typeof p.clientMsgId === 'string' &&
      CLIENT_MSG_ID.test(p.clientMsgId)
    );
  },
  // Пробуждение спящей сессии (спека 4.2, правки 19): ключ только `ref`, у него строго три непустые строки.
  'sessions.resume': refOnly,
  // Меню сессии (спека 4.2, правки 20): Stop, Put to sleep, Close и цели замены — только `ref`.
  'feed.interrupt': refOnly,
  'sessions.stop': refOnly,
  'sessions.close': refOnly,
  'sessions.switchOptions': refOnly,
  'sessions.switchAgent': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, SWITCH_AGENT_KEYS) &&
      sessionRef(p.ref) &&
      typeof p.requestId === 'string' &&
      UUID.test(p.requestId) &&
      charsBetween(p.provider, 1, REMOTE_PROVIDER_MAX) &&
      (p.model === undefined || p.model === null || textUpTo(p.model, MODEL_MAX)) &&
      (p.effort === undefined || p.effort === null || (typeof p.effort === 'string' && EFFORT_TOKEN.test(p.effort))) &&
      (p.carry === undefined || p.carry === 'handover' || p.carry === 'transcript')
    );
  },
  'consents.decide': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, CONSENT_DECIDE_KEYS) &&
      typeof p.id === 'string' &&
      CONSENT_ID.test(p.id) &&
      (p.decision === 'allow' || p.decision === 'deny') &&
      (p.enabled === undefined || (p.decision === 'allow' && mcpPairs(p.enabled))) &&
      // Ревизия карточки `project-mcp` (ревью s-209): целое от 1, с `allow` и с `deny`; нужна ли она, решает хост.
      (p.revision === undefined || (Number.isSafeInteger(p.revision) && (p.revision as number) >= 1)) &&
      (p.roleChange === undefined || (p.decision === 'allow' && roleChangeAck(p.roleChange)))
    );
  },
  // Лента сессии — да, лента субагента (`agentId`) — нет: для телефона она не решена (спека 4.2, критик s-199 m5).
  'feed.snapshot': params => {
    const p = record(params);
    return p !== null && p.agentId === undefined;
  },
};

/** Нет правила для метода — пропустить. */
export function checkRemoteParams(method: string, params: unknown): boolean {
  const rule = Object.prototype.hasOwnProperty.call(REMOTE_PARAM_RULES, method)
    ? REMOTE_PARAM_RULES[method]
    : undefined;
  return rule === undefined ? true : rule(params);
}
