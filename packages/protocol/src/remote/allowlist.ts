// Белые списки роли `remote` по этапам (спека 4.2), запретный список (4.3) и правила параметров.
// Значения из корня протокола не импортируются: сверку с METHODS делает тест.

export const REMOTE_PROTOCOL = 1;
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
] as const;
const A_EVENTS = ['works.changed', 'rooms.mail', 'activity.changed', 'host.notice'] as const;

const B_METHODS = [
  'mail.markRead',
  'sessions.resume',
  'sessions.stop',
  'pty.send',
  'feed.subscribe',
  'feed.unsubscribe',
  'feed.interrupt',
  'pty.attach',
  'pty.detach',
  'consents.list',
  'consents.decide',
  'rooms.usage',
] as const;
const B_NOTIFICATIONS = ['activity.seen'] as const;
const B_EVENTS = [
  'feed.changed',
  'pty.output',
  'pty.resync',
  'pty.exit',
  'consents.changed',
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
  'sessions.close',
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
  'rooms.delete',
  'rooms.archive',
  'rooms.reopen',
  'rooms.rename',
  'rooms.setMode',
  'worktrees.*',
  'changes.*',
  'providers.setKey',
  'providers.clearKey',
  'providers.check',
  'providers.refreshLimits',
  'telegram.*',
  'trust.*',
  'capabilities.*',
  'memory.*',
  'backlog.*',
  'plans.*',
  'assistant.*',
  'browser.agentResult',
];

export function isRemoteForbidden(name: string): boolean {
  return REMOTE_FORBIDDEN.some(entry =>
    entry.endsWith('.*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );
}

export const REMOTE_TEXT_LIMIT_BYTES = 16 * 1024;

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function record(params: unknown): Record<string, unknown> | null {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : null;
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
]);
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
const ROOM_MODES: ReadonlySet<unknown> = new Set(['free', 'checklist', 'verified']);
export const REMOTE_LABEL_MAX = 64;
export const REMOTE_ROOM_TITLE_MAX = 128;
export const REMOTE_ROOM_MEMBERS_MAX = 16;

/** Правило параметров: `true` — пропустить, `false` — `bad_request`. */
export type RemoteParamRule = (params: unknown) => boolean;

export const REMOTE_PARAM_RULES: Readonly<Record<string, RemoteParamRule>> = {
  // Этап A: без `rev` карточку решения можно принять, не видев её текста (спека 4.2).
  'rooms.resolveProposal': params => {
    const p = record(params);
    return p !== null && typeof p.rev === 'number' && Number.isInteger(p.rev) && p.rev >= 0;
  },
  // Запуск с телефона (спека 4.2): новую работу, дочернюю сессию, `agent`, `effort` и `lean` с телефона не задать.
  'sessions.create': params => {
    const p = record(params);
    return (
      p !== null &&
      onlyKeys(p, SESSION_CREATE_KEYS) &&
      typeof p.workId === 'string' &&
      p.workId.length > 0 &&
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
  // Этап B.
  'pty.send': params => {
    const p = record(params);
    return p !== null && typeof p.text === 'string' && utf8Length(p.text) <= REMOTE_TEXT_LIMIT_BYTES;
  },
};

/** Нет правила для метода — пропустить. */
export function checkRemoteParams(method: string, params: unknown): boolean {
  const rule = Object.prototype.hasOwnProperty.call(REMOTE_PARAM_RULES, method)
    ? REMOTE_PARAM_RULES[method]
    : undefined;
  return rule === undefined ? true : rule(params);
}
