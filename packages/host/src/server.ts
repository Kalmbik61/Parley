import { createServer as createNetServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { Server, Socket } from 'node:net';
import { startsShellLine } from '@parley/core';
import {
  COMPACT_WORKS_FEATURE,
  FEED_CODEX_FEATURE,
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  ROOMS_MAIL_FEATURE,
  WORKS_SYNC_FEATURE,
  parseIncoming,
} from '@parley/protocol';
import type { MethodName, NotificationName, ResponseMessage, SessionRef } from '@parley/protocol';
import {
  REMOTE_METHODS,
  REMOTE_NOTIFICATIONS,
  REMOTE_POLICY_FEATURE,
  checkRemoteParams,
} from '@parley/protocol/remote';
import { createClient } from './client.js';
import type { Client } from './client.js';
import type { AnyHandler, AnyNotificationHandler, HostContext, RequestInfo } from './context.js';
import { HostError } from './errors.js';
import { resolvePreparedWorksSyncReply } from './works/works-sync.js';

export interface ServerOptions {
  context: HostContext;
  token: string;
  helloTimeoutMs: number;
  methodHandlers: Partial<Record<MethodName, AnyHandler>>;
  notificationHandlers: Partial<Record<NotificationName, AnyNotificationHandler>>;
  registerClient: (client: Client) => void;
  unregisterClient: (client: Client) => void;
  /** Часы для замера запросов (мс); по умолчанию `performance.now`. */
  now?: () => number;
  /**
   * Власть хоста над клиентом `remote` (спека мобильного приложения 4.2, 14): запуск и проекты. Нет — методы запуска
   * закрыты, а проекты вызовов не сверяются (голый сервер в тестах; хост передаёт политику всегда).
   */
  remoteLaunch?: RemoteLaunchPolicy;
  /** «Speak answers» включён на Mac (платный голос с телефона): гейтит только `voice.session.prepare`. Нет — метод закрыт. Ключ OpenAI проверяет сам prepare (`no_key`). */
  phoneVoice?: () => boolean;
}

/** Власть хоста над запуском с телефона (спека 4.2, «Хост — власть»). */
export interface RemoteLaunchPolicy {
  /** Настройка `remoteCreate`: спрашивается на каждом `hello` и на каждом вызове. */
  enabled(): boolean;
  /** `projectPath` — известный хосту проект, `workId` — существующая неархивная работа этого проекта. */
  workOpen(projectPath: string, workId: string): boolean;
  /** Комната этой работы в режиме `autonomous`: письмо с телефона в неё не уходит (спека 4.2, правки 14). */
  roomAutonomous(projectPath: string, workId: string, roomId: string): boolean;
  /** Проект известен хосту (есть хоть одна его работа): чтения без `workId`, например `roles.list`. */
  projectKnown(projectPath: string): boolean;
  /** Работа этого проекта существует, архивная тоже: чтения и решения по ней. */
  workKnown(projectPath: string, workId: string): boolean;
  /**
   * Сессия есть в карте неархивной работы известного проекта: сообщение агенту `pty.send` (спека 4.2, правки 15).
   * Архивная работа закрыта для сообщений явно, как для запуска (критик s-199, нит).
   */
  sessionKnown(projectPath: string, workId: string, sessionId: string): boolean;
  /**
   * `sessions.create` с `trustFolder: true`: доверить папку проекта до запуска тем же путём, что окно (`trust.check`,
   * затем `trust.grant` с `by: 'phone'`). Зовётся только после всех проверок роли `remote`.
   */
  trustFolder(projectPath: string): Promise<void>;
  /**
   * Состояние сессии по свежей карте работы (критик A37a M1): `null` — нет такой работы или сессии. Читается до
   * обработчика вызовов роли `remote` по одной сессии (`REMOTE_SESSION_RULES`).
   */
  sessionState(projectPath: string, workId: string, sessionId: string): Promise<RemoteSessionState | null>;
  /**
   * Состояние комнаты по свежей карте работы (меню комнаты, правки 21): `null` — нет такого проекта, работы или
   * комнаты. Читается до обработчика `rooms.archive` и `rooms.delete` роли `remote`.
   */
  roomState(projectPath: string, workId: string, roomId: string): Promise<RemoteRoomState | null>;
  /**
   * Участники новой комнаты по свежей карте работы (b-023): `null` — нет такой работы. Читается до обработчика
   * `rooms.create` роли `remote`; `autonomous` — кто-то из них в автономном прогоне.
   */
  membersState(projectPath: string, workId: string, members: readonly string[]): Promise<RemoteRoomState | null>;
}

export interface RemoteRoomState {
  workArchived: boolean;
  /** Комната (у `membersState` — кто-то из участников) идущего автономного прогона: телефон её не меняет. */
  autonomous: boolean;
}

export interface RemoteSessionState {
  workArchived: boolean;
  lifecycle: string;
  /** Процесс агента идёт в этом хосте (его PTY). */
  live: boolean;
  /** Сессия автономного движка (`workspace`): телефон в идущий прогон не вмешивается (правки 14, критик A38a m6). */
  engine: boolean;
}

/** Запрос дольше этого пишется в лог хоста строкой `медленный запрос`. */
export const SLOW_REQUEST_MS = 1000;

interface HelloParams {
  token: string;
  protocol: number;
  client: string;
  features?: string[];
}

/**
 * Что хост умеет сверх протокола 1: окно по этому списку знает, что снимок работ компактный, что лента Chat есть у Codex и
 * что письма приходят событием `rooms.mail`, а не вместе со снимком.
 */
const HOST_FEATURES = [COMPACT_WORKS_FEATURE, FEED_CODEX_FEATURE, ROOMS_MAIL_FEATURE, REMOTE_POLICY_FEATURE];

const REMOTE_METHOD_SET: ReadonlySet<string> = new Set(REMOTE_METHODS);
const REMOTE_NOTIFICATION_SET: ReadonlySet<string> = new Set(REMOTE_NOTIFICATIONS);
/** Единственный метод под условием «Speak answers» (`phoneVoice`): он тратит деньги владельца. */
const VOICE_PREPARE_METHOD = 'voice.session.prepare';
/** Методы запуска с телефона: только в существующую неархивную работу (`sessions.create` — ещё и в новую). */
const REMOTE_LAUNCH_METHODS: ReadonlySet<string> = new Set(['sessions.create', 'rooms.create', 'rooms.send']);
/**
 * За одним переключателем `remoteCreate` (спека 4.2, правки 17): запуск, сообщение агенту и согласия — `trustFolder`
 * ключом `sessions.create`, `consents.decide` (Allow — доверие к папке или агент на другом провайдере; критик M2),
 * `sessions.resume` (пробуждение спящей сессии, правки 19) и меню сессии (правки 20: Stop, Put to sleep, Close, замена
 * провайдера); у них цель — известный проект и работа по `ref`.
 * `providers.list`, `roles.list`, `consents.list` и `trust.check` — чтение.
 */
const REMOTE_SWITCHED_METHODS: ReadonlySet<string> = new Set([
  ...REMOTE_LAUNCH_METHODS,
  'pty.send',
  'consents.decide',
  // Решение по карточке помощника с телефона (B3) внутри хоста запускает sessions.close, rooms.create и отправки,
  // поэтому идёт за тем же переключателем; `cards.list` — чтение, он открыт всегда.
  'cards.decide',
  'sessions.resume',
  'feed.interrupt',
  'sessions.stop',
  'sessions.close',
  'sessions.switchOptions',
  'sessions.switchAgent',
  // Меню комнаты (правки 21): Archive и Delete; цель — известный проект, работа и комната (`remoteRoomGate`).
  'rooms.archive',
  'rooms.delete',
]);

/**
 * Состояние сессии, в котором её метод с телефона имеет смысл (критик A37a): будить — только спящую, Stop и Put to
 * sleep — только идущую в этом хосте (A38a). Закрытая сессия, архивная работа и неизвестная сессия отсекаются до
 * правила для всех методов из этого списка.
 */
const anyOpen = (): null => null;
const onlyLive = (state: RemoteSessionState): string | null => (state.live ? null : 'session is not running');
const REMOTE_SESSION_RULES: Readonly<Record<string, (state: RemoteSessionState) => string | null>> = {
  // `active` без PTY этого хоста — второй `claude --resume`; `pending` — запуск раньше движка или терминала.
  'sessions.resume': (state) => (state.lifecycle === 'sleeping' ? null : 'session is not asleep'),
  'feed.interrupt': onlyLive,
  'sessions.stop': onlyLive,
  'sessions.close': anyOpen,
  'sessions.switchOptions': anyOpen,
  // `pending` с процессом вне Parley — второй агент в том же worktree (критик A38a m2): как окно, спящая или идущая.
  'sessions.switchAgent': (state) =>
    state.lifecycle === 'sleeping' || state.live ? null : 'session is neither asleep nor running in this host',
};
/** Чтение: сессию движка можно смотреть, менять — нет. */
const REMOTE_ENGINE_READS: ReadonlySet<string> = new Set(['sessions.switchOptions']);

/** Проверка сессии до обработчика (критик A37a M1, m1, m2): ошибка с кодом протокола, без рассылки `host.notice`. */
async function remoteSessionGate(method: string, params: unknown, policy: RemoteLaunchPolicy): Promise<void> {
  if (!Object.hasOwn(REMOTE_SESSION_RULES, method)) return;
  const rule = REMOTE_SESSION_RULES[method]!;
  // Правило параметров уже проверило `ref`: три непустые строки.
  const { projectPath, workId, sessionId } = (params as { ref: SessionRef }).ref;
  const state = await policy.sessionState(projectPath, workId, sessionId);
  if (state === null) throw new HostError('bad_request', 'unknown session');
  if (state.workArchived) throw new HostError('conflict', 'the work is archived');
  if (state.lifecycle === 'closed') throw new HostError('conflict', 'session is closed');
  if (state.engine && !REMOTE_ENGINE_READS.has(method)) {
    throw new HostError('conflict', 'the phone does not change sessions of an autonomous run');
  }
  const refused = rule(state);
  if (refused !== null) throw new HostError('conflict', refused);
}

/** Методы меню комнаты: проверка комнаты на свежей карте до обработчика. */
const REMOTE_ROOM_METHODS: ReadonlySet<string> = new Set(['rooms.archive', 'rooms.delete']);

/**
 * Проверка комнаты до обработчика (правки 21): неизвестная — `bad_request`, архивная работа и автономный прогон —
 * `conflict`. Архивную комнату удалить можно, повторная архивация — no-op ядра.
 * Принятая гонка (критик A41a m3): карта читается без замка, обработчик берёт свой `updateMap` позже. Состояние комнаты
 * может смениться в этом промежутке (миллисекунды); обработчики окна проверяют только работу, и строгая проверка внутри
 * транзакции потребовала бы менять их. Как у `remoteSessionGate`, остаток принят.
 */
async function remoteRoomGate(params: unknown, policy: RemoteLaunchPolicy): Promise<void> {
  // Правило параметров уже проверило три непустые строки.
  const { projectPath, workId, roomId } = params as { projectPath: string; workId: string; roomId: string };
  const state = await policy.roomState(projectPath, workId, roomId);
  if (state === null) throw new HostError('bad_request', 'unknown room');
  if (state.workArchived) throw new HostError('conflict', 'the work is archived');
  if (state.autonomous) throw new HostError('conflict', 'the phone does not change rooms of an autonomous run');
}

/**
 * Проверка участников `rooms.create` до обработчика (b-023): новая комната уводит участников из прежних (`leaveOtherRooms`),
 * и сессию автономного прогона телефон оттуда не забирает. Та же принятая гонка, что у `remoteRoomGate`: карта читается без
 * замка, обработчик берёт свой `updateMap` позже.
 */
async function remoteRoomCreateGate(params: unknown, policy: RemoteLaunchPolicy): Promise<void> {
  // Правило параметров уже проверило строки `projectPath`, `workId` и непустой список `members`.
  const { projectPath, workId, members } = params as { projectPath: string; workId: string; members: string[] };
  const state = await policy.membersState(projectPath, workId, members);
  if (state === null) throw new HostError('bad_request', 'unknown project or work');
  if (state.workArchived) throw new HostError('conflict', 'the work is archived');
  if (state.autonomous) throw new HostError('conflict', 'the phone does not change sessions of an autonomous run');
}

/**
 * Клиенты, чей сокет уже закрыт: после `await` записи доверия запуск для ушедшего телефона не идёт (критик m9).
 * WeakSet — запись живёт, пока жив сам `Client`.
 */
const closedClients = new WeakSet<Client>();

/** Метод белого списка, открытый клиенту `remote` сейчас: запуск, сообщения и согласия — только при включённом `remoteCreate`. */
function remoteMethodOpen(name: string, options: ServerOptions): boolean {
  if (!REMOTE_METHOD_SET.has(name)) return false;
  // Платный голос: «Speak answers» выключен на Mac — это убирает метод из `hello.methods` и отвергает прямой вызов как неизвестный.
  if (name === VOICE_PREPARE_METHOD) return options.phoneVoice?.() === true;
  return !REMOTE_SWITCHED_METHODS.has(name) || options.remoteLaunch?.enabled() === true;
}
/**
 * Что хост принимает из `hello.features` клиента `remote` (спека мобильного приложения 4.4: мост заявляет ровно их).
 * Прочие признаки меняют поведение хоста для других клиентов: с `browser-agent` мост стал бы «окном» для операций
 * браузера, с `assistant-actions` — тем, кто показывает действия ассистента.
 */
const REMOTE_CLIENT_FEATURES: ReadonlySet<string> = new Set([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);

/** Пишет один кадр напрямую в сокет — до рукопожатия у соединения ещё нет `Client`. */
function writeRaw(socket: Socket, message: ResponseMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export function createHostServer(options: ServerOptions): Server {
  return createNetServer((socket) => {
    handleConnection(socket, options);
  });
}

function handleConnection(socket: Socket, options: ServerOptions): void {
  const decoder = new LineDecoder();
  let client: Client | null = null;
  // Отклонённое рукопожатие — конец соединения: следующий кадр того же или позднего чанка не получает второй попытки.
  let rejected = false;

  // Первое сообщение должно быть `hello` за `helloTimeoutMs`, иначе — закрытие
  // без ответа (клиент ничего не прислал, отвечать нечему).
  const helloTimer = setTimeout(() => socket.destroy(), options.helloTimeoutMs);
  helloTimer.unref();

  socket.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      if (error instanceof LineTooLongError) {
        socket.destroy();
        return;
      }
      throw error;
    }
    for (const raw of messages) {
      if (rejected) return;
      if (!client) {
        client = handleHello(raw, socket, options, helloTimer);
        if (!client) rejected = true;
        continue;
      }
      handleMessage(raw, client, options);
    }
  });

  socket.on('close', () => {
    clearTimeout(helloTimer);
    if (client) {
      closedClients.add(client);
      options.unregisterClient(client);
    }
  });

  // 'error' без обработчика роняет процесс; 'close' придёт следом сам по себе
  // и снимет клиента — здесь достаточно не дать необработанному исключению.
  socket.on('error', () => {});
}

function handleHello(
  raw: unknown,
  socket: Socket,
  options: ServerOptions,
  helloTimer: NodeJS.Timeout,
): Client | null {
  const parsed = parseIncoming(raw);

  if (parsed.kind !== 'request' || parsed.message.method !== 'hello') {
    // Уведомление до hello тоже отклоняется, но у него нет id — отвечать нечем.
    const id = parsed.kind === 'notification' ? null : parsed.kind === 'invalid' ? parsed.id : parsed.message.id;
    if (id !== null) {
      writeRaw(socket, { id, error: { code: 'unauthorized', message: 'the first message must be hello' } });
    }
    socket.end();
    return null;
  }

  clearTimeout(helloTimer);
  const { id } = parsed.message;
  const hello = parsed.params as HelloParams;

  if (hello.token !== options.token) {
    writeRaw(socket, { id, error: { code: 'unauthorized', message: 'invalid token' } });
    socket.end();
    return null;
  }

  if (hello.protocol !== PROTOCOL_VERSION) {
    writeRaw(socket, {
      id,
      error: {
        code: 'protocol_mismatch',
        message: `host speaks protocol ${PROTOCOL_VERSION}, client sent ${hello.protocol}`,
        data: { hostVersion: options.context.version, liveSessions: options.context.liveSessions() },
      },
    });
    socket.end();
    return null;
  }

  // Роль — только здесь и один раз: повторный `hello` уходит в handleMessage и получает `unknown_method`.
  const remote = hello.client === 'remote';
  const registered = remote
    ? createClient(socket, hello.client, (hello.features ?? []).filter((name) => REMOTE_CLIENT_FEATURES.has(name)), 'remote')
    : createClient(socket, hello.client, hello.features);
  const methods = supportedMethods(options);
  writeRaw(socket, {
    id,
    result: {
      hostVersion: options.context.version,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      methods: remote
        ? methods.filter((name) => name === 'hello' || remoteMethodOpen(name, options) || REMOTE_NOTIFICATION_SET.has(name))
        : methods,
      features: !remote && options.methodHandlers['works.sync'] !== undefined ? [...HOST_FEATURES, WORKS_SYNC_FEATURE] : HOST_FEATURES,
    },
  });
  options.registerClient(registered);
  return registered;
}

/**
 * Всё, что понимает хост (спека 3.2): окно по списку прячет функции, которых у
 * старого хоста нет. `hello` обрабатывается здесь, до таблиц обработчиков, —
 * без него новый хост выглядел бы старым.
 */
function supportedMethods(options: ServerOptions): string[] {
  return [
    'hello',
    ...Object.keys(options.methodHandlers),
    ...Object.keys(options.notificationHandlers),
  ].sort();
}

/**
 * Белый список клиента `remote` (спека 4.1, точка «вызов») — по имени, до разбора схемы: запрещённый метод получает
 * `unknown_method` при любых параметрах, а не текст ошибки своей схемы. Деление на запрос и уведомление — как в
 * `parseIncoming`: числовой `id` — запрос. `true` — кадр обработан здесь (отказ), дальше не идёт.
 */
function rejectedForRemote(raw: unknown, client: Client, options: ServerOptions): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const { id, method } = raw as Record<string, unknown>;
  // Без имени метода `parseIncoming` вернёт invalid, и до обработчика кадр не дойдёт.
  if (typeof method !== 'string') return false;
  if (typeof id === 'number') {
    if (remoteMethodOpen(method, options)) return false;
    client.send({ id, error: { code: 'unknown_method', message: `unknown method: ${method}` } });
    return true;
  }
  if (REMOTE_NOTIFICATION_SET.has(method)) return false;
  options.context.log.warn('уведомление клиента remote вне белого списка отброшено', { method, client: client.name });
  return true;
}

/**
 * Запуск с телефона — только в существующую неархивную работу известного хосту проекта (спека 4.2); `sessions.create`
 * с `workId: null` — новая работа, но тоже только в известном проекте: произвольную папку с телефона не задать.
 */
function remoteWorkOpen(method: string, params: unknown, options: ServerOptions): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const { projectPath, workId } = params as Record<string, unknown>;
  if (typeof projectPath !== 'string') return false;
  if (method === 'sessions.create' && workId === null) return options.remoteLaunch?.projectKnown(projectPath) === true;
  if (typeof workId !== 'string') return false;
  return options.remoteLaunch?.workOpen(projectPath, workId) === true;
}

/** Сообщение агенту с телефона — только в сессию из карты известного проекта (спека 4.2, правки 15). */
function remoteSessionKnown(params: unknown, options: ServerOptions): boolean {
  const ref = (params as Record<string, unknown>).ref;
  if (typeof ref !== 'object' || ref === null) return false;
  const { projectPath, workId, sessionId } = ref as Record<string, unknown>;
  if (typeof projectPath !== 'string' || typeof workId !== 'string' || typeof sessionId !== 'string') return false;
  return options.remoteLaunch?.sessionKnown(projectPath, workId, sessionId) === true;
}

/** Проект и работа, которые называет вызов: верхний уровень и `ref` сессии (у `roles.list` — оба). */
function remoteTargets(params: unknown): { projectPath: string; workId: string | null }[] {
  const out: { projectPath: string; workId: string | null }[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const { projectPath, workId } = value as Record<string, unknown>;
    if (typeof projectPath !== 'string') return;
    out.push({ projectPath, workId: typeof workId === 'string' ? workId : null });
  };
  add(params);
  if (typeof params === 'object' && params !== null) add((params as Record<string, unknown>).ref);
  return out;
}

/**
 * Только известные хосту проекты (спека 14, критик W11): запуск — в существующую неархивную работу, прочие вызовы с
 * проектом — в известный проект и существующую работу. Вызовы без проекта (`works.list`, `host.info`) не затронуты.
 */
function remoteTargetsKnown(method: string, params: unknown, options: ServerOptions): boolean {
  if (REMOTE_LAUNCH_METHODS.has(method)) return remoteWorkOpen(method, params, options);
  if (method === 'pty.send') return remoteSessionKnown(params, options);
  const policy = options.remoteLaunch;
  // `trust.check {folder}` — ответ только для известного проекта: телефон не узнаёт, доверена ли чужая папка. Без
  // политики известных проектов нет — отказ, а не пропуск.
  if (method === 'trust.check') {
    const { folder } = params as Record<string, unknown>;
    return typeof folder === 'string' && policy?.projectKnown(folder) === true;
  }
  if (policy === undefined) return true;
  return remoteTargets(params).every(({ projectPath, workId }) =>
    workId === null ? policy.projectKnown(projectPath) : policy.workKnown(projectPath, workId),
  );
}

/** Письмо с телефона в идущую автономную комнату (спека 4.2, правки 14). Комнату ищет политика по снимку хоста. */
function remoteRoomAutonomous(params: unknown, options: ServerOptions): boolean {
  const { projectPath, workId, roomId } = params as Record<string, unknown>;
  if (typeof projectPath !== 'string' || typeof workId !== 'string' || typeof roomId !== 'string') return false;
  return options.remoteLaunch?.roomAutonomous(projectPath, workId, roomId) === true;
}

function handleMessage(raw: unknown, client: Client, options: ServerOptions): void {
  if (client.role === 'remote' && rejectedForRemote(raw, client, options)) return;
  const parsed = parseIncoming(raw);
  const request: RequestInfo = { client, host: options.context };

  if (parsed.kind === 'invalid') {
    if (parsed.id !== null) {
      client.send({ id: parsed.id, error: parsed.error });
    } else {
      options.context.log.warn('нераспознанное уведомление', { error: parsed.error.message });
    }
    return;
  }

  if (parsed.kind === 'notification') {
    const handler = options.notificationHandlers[parsed.message.method];
    // Ответить на уведомление нечем, а исключение отсюда уходит в обработчик
    // 'data' сокета и роняет весь хост: `pty.resize` терминала, чей PTY остался
    // у прежнего хоста, валил каждый новый хост сразу после подключения окна.
    try {
      handler?.(parsed.params as never, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.context.log.warn('обработчик уведомления упал', { method: parsed.message.method, error: message });
    }
    return;
  }

  const { id, method } = parsed.message;
  // Правила роли `remote` смотрят на параметры кадра, а не на разобранные схемой: схема отбрасывает незнакомые ключи, и
  // правило не увидело бы ни обязательного `clientMsgId` у `pty.send`, ни `trustFolder` у `sessions.create`, ни лишнего
  // ключа (спека 4.2: лишний ключ → `bad_request`). Так же проверяет мост.
  if (client.role === 'remote' && !checkRemoteParams(method, parsed.message.params)) {
    client.send({ id, error: { code: 'bad_request', message: `params are not allowed for remote clients: ${method}` } });
    return;
  }
  if (client.role === 'remote' && !remoteTargetsKnown(method, parsed.params, options)) {
    client.send({ id, error: { code: 'bad_request', message: 'unknown project or work' } });
    return;
  }
  if (client.role === 'remote' && method === 'rooms.send' && remoteRoomAutonomous(parsed.params, options)) {
    client.send({ id, error: { code: 'bad_request', message: 'the phone cannot write into an autonomous room' } });
    return;
  }
  // Строка оболочки (`!…`) с телефона исполнилась бы в терминале сессии; `checkRemoteParams` уже проверил, что `text` — строка.
  if (client.role === 'remote' && method === 'pty.send' && startsShellLine((parsed.message.params as { text: string }).text)) {
    client.send({ id, error: { code: 'bad_request', message: 'Shell commands cannot be sent from the phone' } });
    return;
  }
  const handler = options.methodHandlers[method];
  if (!handler) {
    // Схема метода известна протоколу (иначе parseIncoming вернул бы invalid),
    // но этот кусок хоста ещё не завёл для него обработчик — появится позже.
    client.send({ id, error: { code: 'unknown_method', message: `method is not implemented yet: ${method}` } });
    return;
  }

  const now = options.now ?? (() => performance.now());
  const begin = now();
  // Уведомление о медленном запросе — после `client.send`, чтобы `queuedBytes` показывал очередь с ответом.
  // Сбой лога (или JSON.stringify) не должен попасть в `.catch` ниже: ответ уже отправлен, и второй ответ с тем же id был бы ложным.
  const logIfSlow = (outcome: { ok: true; result: unknown; bytes?: number } | { ok: false; code: string }): void => {
    try {
      const ms = now() - begin;
      if (ms < SLOW_REQUEST_MS) return;
      options.context.log.warn('медленный запрос', {
        method,
        ms: Math.round(ms),
        client: client.name,
        queuedBytes: client.writableLength(),
        ...(outcome.ok
          ? { bytes: outcome.bytes ?? Buffer.byteLength(JSON.stringify(outcome.result) ?? '', 'utf8') }
          : { error: outcome.code }),
      });
    } catch {
      // диагностика не важнее ответа
    }
  };

  // `trustFolder: true` с телефона (спека 4.2): запись доверия — после всех проверок роли и до запуска. Схема хоста ключ
  // не знает и отбрасывает, поэтому он читается из кадра; правило параметров уже проверило, что это boolean.
  const trustFirst =
    client.role === 'remote' && method === 'sessions.create' && (parsed.message.params as Record<string, unknown>).trustFolder === true
      ? (parsed.params as { projectPath: string }).projectPath
      : null;
  const policy = options.remoteLaunch;
  const roomGated = client.role === 'remote' && policy !== undefined && REMOTE_ROOM_METHODS.has(method);
  const createGated = client.role === 'remote' && policy !== undefined && method === 'rooms.create';
  const gated = client.role === 'remote' && policy !== undefined && (roomGated || createGated || Object.hasOwn(REMOTE_SESSION_RULES, method));
  // Без доверия и проверки сессии обработчик зовётся синхронно, как раньше: порядок с уведомлениями того же чанка не
  // меняется.
  const pending = gated
    ? (roomGated
        ? remoteRoomGate(parsed.params, policy)
        : createGated
          ? remoteRoomCreateGate(parsed.params, policy)
          : remoteSessionGate(method, parsed.params, policy)).then(() => {
        if (!policy.enabled()) throw new HostError('unknown_method', `unknown method: ${method}`);
        if (closedClients.has(client)) throw new HostError('conflict', 'the phone disconnected');
        return handler(parsed.params as never, request);
      })
    : trustFirst === null || policy === undefined
    ? Promise.resolve(handler(parsed.params as never, request))
    : policy.trustFolder(trustFirst).then(() => {
        // Пока писалось доверие, переключатель могли выключить, а телефон — уйти (критик m9): тогда запуска нет.
        // Доверие уже записано, как у окна при отказе запуска после согласия (критик m7, спека 4.2).
        if (!policy.enabled()) throw new HostError('unknown_method', `unknown method: ${method}`);
        if (closedClients.has(client)) throw new HostError('conflict', 'the phone disconnected before the launch');
        return handler(parsed.params as never, request);
      });
  pending
    .then(async (result) => {
      const prepared = await resolvePreparedWorksSyncReply(result, id);
      if (prepared !== undefined) {
        // false означает возможную уже поставленную в очередь запись: не повторять через send.
        try {
          const writable = client.sendLine !== undefined ? client.sendLine(prepared.line) : client.send({ id, result: prepared.result });
          prepared.sent(writable);
        } catch {
          // Попытка записи могла уже отправить кадр; второй ответ с тем же id запрещён.
          prepared.sent(false);
        }
        logIfSlow({ ok: true, result: prepared.result, bytes: prepared.resultBytes });
        return;
      }
      client.send({ id, result });
      logIfSlow({ ok: true, result });
    })
    .catch((error: unknown) => {
      // `HostError` несёт свой код протокола (`conflict`, `bad_request`, …) —
      // остальное считаем неожиданным сбоем и заворачиваем в `internal`.
      if (error instanceof HostError) {
        const errorField = error.data === undefined
          ? { code: error.code, message: error.message }
          : { code: error.code, message: error.message, data: error.data };
        client.send({ id, error: errorField });
        logIfSlow({ ok: false, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      options.context.log.error('обработчик метода упал', { method, error: message });
      client.send({ id, error: { code: 'internal', message } });
      logIfSlow({ ok: false, code: 'internal' });
    });
}
