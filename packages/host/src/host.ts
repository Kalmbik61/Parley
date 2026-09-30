import { randomBytes } from 'node:crypto';
import { mkdir, chmod, link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { uptime } from 'node:os';
import { parleyHome, processStartedAt, START_TOLERANCE_MS } from '@parley/core';
import { createHostContext } from './context.js';
import type { HostContext } from './context.js';
import { createHostServer } from './server.js';
import { HostError } from './errors.js';
import { createLog } from './log.js';
import type { Log } from './log.js';
import { watchIdle } from './idle.js';
import { hostPaths, MAX_SOCKET_PATH_BYTES } from './paths.js';
import type { HostPaths } from './paths.js';
import { HOST_ERROR_REASONS } from '@parley/protocol';
import { createHostHandlers } from './methods/index.js';
import { createWorksService } from './works/works-service.js';
import { createActivityService } from './activity/activity-service.js';
import { linkTerminalActivity } from './activity/terminal-link.js';
import { createLimitsService } from './limits/limits-service.js';
import type { LimitsServiceOptions } from './limits/limits-service.js';
import { startProviderVersions } from './providers/versions.js';
import type { VersionProbe } from './providers/versions.js';
import { createPtyManager } from './pty/pty-manager.js';
import { createSessionsService } from './sessions/sessions-service.js';
import { createWakeService } from './wake/wake-service.js';
import { createWorktreesService } from './worktrees/worktrees-service.js';

export interface HostOptions {
  home?: string;
  idleMs?: number;
  helloTimeoutMs?: number;
  version?: string;
  /**
   * Проба версии CLI провайдеров на старте (`<команда> --version`, одна на команду). Без неё
   * ничего не запускается и `providers.list` отдаёт `version: null`: подключает её только
   * `main.ts`, а тесты, где настоящие claude и codex запускать нельзя, зовут `startHost` без
   * пробы или с подменой.
   */
  probeVersion?: VersionProbe;
  /**
   * Лимиты подписок (спека комнат Organic, 3.5): корень логов Codex, часы и период опроса. Боевой хост
   * не задаёт ничего — опрос раз в 30 секунд, логи в `~/.codex/sessions`; тесты и E2E окна — свои.
   */
  limits?: LimitsServiceOptions;
  /**
   * Срок экранов старта Codex, мс (спека комнат Organic, 3.6): не показал `Ready` и `Working` — сессия «нужен
   * ты». Боевой хост не задаёт — 20 секунд; E2E окна сокращает его переменной `HARNAS_CODEX_STARTUP_MS`.
   */
  startupWaitMs?: number;
}

export interface RunningHost {
  paths: HostPaths;
  context: HostContext;
  /** Разрешается причиной остановки: `'idle' | 'signal' | 'host.shutdown' | ...`. */
  closed: Promise<string>;
}

export class HostAlreadyRunning extends Error {
  constructor() {
    super('хост уже запущен для этого дома');
    this.name = 'HostAlreadyRunning';
  }
}

export class SocketPathTooLong extends Error {
  constructor(socketPath: string) {
    super(`путь сокета длиннее ${MAX_SOCKET_PATH_BYTES} байт: ${socketPath}`);
    this.name = 'SocketPathTooLong';
  }
}

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const resolvedHome = options.home ?? parleyHome();
  const paths = hostPaths(resolvedHome);

  // 1. Слишком длинный путь сокета — отказ до того, как на диске или в
  //    окружении что-то появится.
  if (Buffer.byteLength(paths.socket, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw new SocketPathTooLong(paths.socket);
  }

  // Работы (`readWorksIndex`, `createWork`, …) живут в core и берут дом только
  // из `process.env.HARNAS_HOME` — параметра-оверрайда у них нет. Чтобы список
  // работ хоста совпадал с его же файлами (`options.home` в тестах — не
  // настоящий `~/.harnas`), окружение здесь и приводится к тому же дому,
  // а на остановке возвращается прежним (см. `runShutdown`).
  const previousParleyHome = process.env['HARNAS_HOME'];
  process.env['HARNAS_HOME'] = resolvedHome;

  // 2. Каталог хоста всегда 0700, независимо от того, был он уже или нет.
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);

  // 3. Единственность — замок `host.pid` (спека 3.2, раунд lane-r4): проверка одного сокета
  //    пропускала медленный старт первого хоста (сокета ещё нет), и второй сносил его файлы.
  //    Замок живого pid — отказ без удалений; сокет — дополнительная проверка (хост без замка).
  //    Осколки упавшего (сокет, токен) подчищаются только под своим замком.
  // Журнал заводится до замка: отказ захвата с потерей замка соседа пишет туда причину (fix-lane-post).
  const log = createLog(paths.log);
  if (!(await acquirePidLock(paths.pid, log))) {
    restoreParleyHome(previousParleyHome);
    throw new HostAlreadyRunning();
  }
  if (await socketIsAlive(paths.socket)) {
    await releasePidLock(paths.pid);
    restoreParleyHome(previousParleyHome);
    throw new HostAlreadyRunning();
  }
  await Promise.all([paths.socket, paths.token].map((file) => rm(file, { force: true })));

  // 4. Токен рукопожатия — новый на каждый запуск, права 0600 гарантируются chmod,
  //    а не только `mode` у writeFile (тот режется umask).
  const token = randomBytes(32).toString('hex');
  await writeFile(paths.token, token, { mode: 0o600 });
  await chmod(paths.token, 0o600);

  const hostVersion = options.version ?? '0.0.0';
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });
  const shutdownHooks: Array<() => Promise<void>> = [];
  let shuttingDown = false;

  const idleWatcher = watchIdle(idleMs, () => {
    void runShutdown('idle');
  });

  const handle = createHostContext({
    version: hostVersion,
    paths,
    log,
    onIdleChange: (idle) => idleWatcher.notify(idle),
    registerShutdownHook: (hook) => shutdownHooks.push(hook),
    requestShutdown: (reason) => runShutdown(reason),
  });

  // Работы стартуют и останавливаются вместе с хостом: окно узнаёт о них
  // через `works.list`/`works.changed`, а на остановке хост снимает свою аренду.
  const worksService = createWorksService(handle.context);
  handle.context.onShutdown(() => worksService.stop());

  // Активность живёт поверх работ: точка статуса и строка метрик окна (1.5).
  // `pty.attach`/`pty.input` (1.6) зовут её `markSeen`.
  const activityService = createActivityService(handle.context, worksService, {
    ...(options.startupWaitMs === undefined ? {} : { startupWaitMs: options.startupWaitMs }),
  });
  handle.context.onShutdown(() => activityService.stop());

  // Живые PTY сессий (1.6). На остановке хоста добиваются вместе с ним —
  // иначе процесс агента остаётся сиротой без хоста, который бы его закрыл.
  const ptyManager = createPtyManager(handle.context);

  // Состояние сессий codex — по потоку их терминала, а не по хукам (спека комнат Organic, 3.6): менеджер PTY
  // разбирает заголовок окна и уведомления, сервис активности выводит из них состояние.
  const unlinkTerminal = linkTerminalActivity(ptyManager, activityService);
  handle.context.onShutdown(async () => unlinkTerminal());

  // Создание, запуск и автозапуск сессий (1.7). На остановке хоста гасит все
  // живые PTY сам — той же дорогой, что и явный `sessions.stop`.
  const sessionsService = createSessionsService(
    handle.context,
    worksService,
    ptyManager,
    activityService,
  );
  handle.context.onShutdown(() => sessionsService.stopAll());

  // Будильник (1.8, 3.4): печатает указатель на непрочитанные письма
  // простаивающему агенту без канала и поднимает спящих письмом. Останавливается
  // вместе с хостом — иначе его таймеры Enter/предохранителя пережили бы
  // закрытые PTY.
  const wakeService = createWakeService(
    handle.context,
    worksService,
    activityService,
    ptyManager,
    sessionsService,
  );
  handle.context.onShutdown(async () => wakeService.stop());

  // Дифф, коммит, слияние и отбрасывание worktree сессии (4.2) — «Остановить»
  // при отбрасывании она делит с обычным `sessions.stop`.
  const worktreesService = createWorktreesService(sessionsService);

  // Сокет слушает раньше первого чтения работ (п. 5 ниже, затем `worksService.start()`):
  // методы снимка работ (WORKS_GATED_* в methods/index.ts) ждут его, иначе окно, подключившееся
  // в этот промежуток, видит недочитанный снимок. Отказ первого чтения ворота не держат вечно, а
  // отказывают (раунд lane-r5): методы снимка отвечают ошибкой, а не висят.
  let markWorksReady!: () => void;
  let failWorksReady!: (error: HostError) => void;
  const worksReady = new Promise<void>((resolve, reject) => {
    markWorksReady = resolve;
    failWorksReady = reject;
  });
  // Отказ читают только ожидающие методы; без них он не должен стать необработанным.
  worksReady.catch(() => undefined);

  // Версии CLI пробуются один раз на старте, пока остальное поднимается; `providers.list` их ждёт.
  const providerVersions = startProviderVersions(options.probeVersion, log);

  // Лимиты подписок (спека комнат Organic, 3.5): файлы строки статуса Claude Code и логи Codex, раз в
  // 30 секунд; окну — в `providers.list` и событием `providers.limitsChanged`. Запускается в конце
  // старта, когда снимок работ уже прочитан.
  const limitsService = createLimitsService(handle.context, worksService, options.limits);
  handle.context.onShutdown(async () => limitsService.stop());

  const handlers = createHostHandlers({
    worksReady,
    providerVersions,
    limits: limitsService,
    works: worksService,
    activity: activityService,
    pty: ptyManager,
    sessions: sessionsService,
    wake: wakeService,
    worktrees: worktreesService,
  });
  const server = createHostServer({
    context: handle.context,
    token,
    helloTimeoutMs,
    methodHandlers: handlers.methods,
    notificationHandlers: handlers.notifications,
    // Активность хост шлёт только при изменении, а живёт дольше окна: окно,
    // перезапущенное при живом хосте, до следующего события считало бы
    // ждущую разрешения сессию `idle` — в `blocked` она событий больше не шлёт.
    // Поэтому новому клиенту сразу после ответа на `hello` — повтор текущей.
    registerClient: (client) => {
      handle.addClient(client);
      for (const data of activityService.current()) client.send({ event: 'activity.changed', data });
    },
    unregisterClient: handle.removeClient,
  });

  // 5. `listen`, затем сокет переводится на 0600 (изначально его создаёт `listen`).
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socket, resolve);
    });
  } catch (error) {
    // Не поднялся — замок не держится до выхода процесса (в тестах процесс один на много хостов).
    idleWatcher.stop();
    await releasePidLock(paths.pid);
    restoreParleyHome(previousParleyHome);
    throw error;
  }
  await chmod(paths.socket, 0o600);

  // 6. pid-файл — уже замок из шага 3.

  // 7. Таймер простоя: ни клиентов, ни занятых ключей — отсчёт стартует сразу.
  idleWatcher.notify(true);

  const worksFailure = await worksService.start().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (worksFailure === null) {
    // Сверка живости уже прошла на первом чтении работ: те, чей журнал оборван
    // посреди хода, прерваны падением прошлого хоста (спека 10).
    await sessionsService.collectInterrupted().catch((error: unknown) => {
      log.error('список прерванных сессий не собрался', { error: String(error) });
    });
    // После сбора прерванных, а не сразу после чтения: sessions.interrupted тоже ждёт этих ворот
    // (раунд lane-r4, п. 4) — иначе окно на старте получало пустой список и баннера не было.
    markWorksReady();
  } else {
    // Первое чтение отказало (битый works-index.json — спека 10, «Карта повреждена»): сбой не
    // фатален — хост остаётся, отказывается от снимка и показывает ошибку, а не падает в цикл
    // перезапусков окна. Снимок замораживается пустым (наблюдатели закрыты): ответ методов снимка
    // один и тот же до перезапуска хоста, окно не получит works.changed, противоречащий отказу.
    log.error('первое чтение работ не удалось', { error: worksFailure });
    await worksService.stop();
    failWorksReady(
      new HostError('internal', `работы не прочитаны на старте хоста: ${worksFailure}`, {
        reason: HOST_ERROR_REASONS.worksUnreadable,
      }),
    );
  }
  await activityService.start();
  wakeService.start();
  // Первое чтение лимитов — после чтения работ: файлы сессий ищутся по их картам. Окно, подключившееся
  // раньше, получит лимиты событием.
  await limitsService.start();

  // 8. SIGTERM/SIGINT — обычная остановка.
  const onSignal = (): void => {
    void runShutdown('signal');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  async function runShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    idleWatcher.stop();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);

    for (const hook of shutdownHooks) {
      // Хуки останавливают сессии по очереди, не параллельно — await в цикле намеренный.
      await hook().catch((error: unknown) => {
        log.error('хук остановки упал', { error: String(error) });
      });
    }

    // `server.close()` дожидается закрытия всех соединений — без явного
    // разрыва клиенты, которые сами не отключились, повесили бы остановку.
    for (const client of handle.context.clients()) client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Замок — последним: пока он держится, новый хост не стартует и не застанет сокет и токен
    // уходящего (lane-r4).
    await Promise.all([paths.socket, paths.token].map((file) => rm(file, { force: true })));
    await releasePidLock(paths.pid);
    restoreParleyHome(previousParleyHome);
    log.info('хост остановлен', { reason });
    resolveClosed(reason);
  }

  log.info('хост запущен', { pid: process.pid, version: hostVersion });

  return { paths, context: handle.context, closed };
}

/** Пробует подключиться к существующему файлу сокета: жив ли за ним хост. */
async function socketIsAlive(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Замок единственности хоста — файл `host.pid` (раунд lane-r4): первая строка — pid держателя,
 * вторая — время старта его процесса по ОС (раунд lane-r5; пусто, если ОС его не сообщила).
 * Создаётся ссылкой на уже записанный временный файл: `link` атомарен и падает на существующем,
 * так что читатель никогда не видит пустой замок и не примет его за осколок. true — замок наш.
 *
 * Занят живым держателем — отказ, ничего не удаляется (что считается живым — `isStaleLock`).
 * Осколок переименовывается в свой файл, и если в нём оказался не тот текст, что проверяли
 * (соседний старт успел снять осколок и взять замок), замок возвращается на место — чужой
 * живой замок не удаляется. Не вернулся (замок успел занять третий претендент) — отказ с
 * причиной в журнале, а унесённая копия замка соседа остаётся на диске: стирать единственный след
 * чужого живого замка нельзя (fix-lane-post, п. 1).
 */
async function acquirePidLock(lockPath: string, log: Log): Promise<boolean> {
  const own = String(process.pid);
  const temp = `${lockPath}.${own}.${randomBytes(4).toString('hex')}`;
  await writeFile(temp, `${own}\n${(await processStartedAt(process.pid)) ?? ''}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  try {
    // Два круга: осколок снят — повтор; второй занятый круг значит соседа, успевшего раньше.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temp, lockPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = await readLock(lockPath);
      if (held === null) continue; // замок сняли между link и чтением
      if (!(await isStaleLock(held))) return false;
      const stale = `${lockPath}.stale.${own}`;
      try {
        await rename(lockPath, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const moved = await readLock(stale);
      if (moved !== null && moved.text !== held.text) {
        // Унесли живой замок соседа — вернуть.
        try {
          await link(stale, lockPath);
        } catch (error) {
          log.error('замок соседа не возвращён: старт отказан', {
            lock: lockPath,
            stale,
            neighbour: moved.text,
            code: (error as NodeJS.ErrnoException).code ?? String(error),
          });
          return false;
        }
        await rm(stale, { force: true });
        return false;
      }
      await rm(stale, { force: true });
    }
    return false;
  } finally {
    await rm(temp, { force: true });
  }
}

async function readLock(lockPath: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    return { text, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** pid и записанное время старта из текста замка; прежний формат (только pid) — время `null`. */
function parseLock(text: string): { pid: number; startedAt: string | null } {
  const [pidLine = '', startedLine = ''] = text.split('\n');
  const startedAt = startedLine.trim();
  return { pid: Number(pidLine.trim()), startedAt: startedAt === '' ? null : startedAt };
}

/**
 * Осколок: pid не число или мёртв; замок записан до загрузки системы; или pid жив, но время старта
 * его процесса не совпадает с записанным (раунд lane-r5) — хост упал, а pid до следующего старта
 * достался чужому процессу. Сверка — как у аренды работы (`hostLeaseActive` в core): допуск
 * START_TOLERANCE_MS; время неизвестно (замок прежнего формата или ОС не ответила) — прежнее правило,
 * живой pid держит замок: без второго признака чужой процесс не отличить, а снять живой замок хуже.
 */
async function isStaleLock(lock: { text: string; mtimeMs: number }): Promise<boolean> {
  const { pid, startedAt } = parseLock(lock.text);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // Записан до загрузки системы: держатель мёртв, даже если его pid достался другому процессу.
  if (lock.mtimeMs < Date.now() - uptime() * 1000) return true;
  if (!pidAlive(pid)) return true;
  if (startedAt === null) return false;
  const actual = await processStartedAt(pid);
  if (actual === null) return false;
  const diff = Math.abs(Date.parse(actual) - Date.parse(startedAt));
  return !Number.isNaN(diff) && diff > START_TOLERANCE_MS;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой: жив.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Снимает замок, только если он наш: чужой (новый хост уже взял) не трогается. */
async function releasePidLock(lockPath: string): Promise<void> {
  const held = await readLock(lockPath).catch(() => null);
  if (held !== null && parseLock(held.text).pid === process.pid) await rm(lockPath, { force: true });
}

/** Возвращает `HARNAS_HOME` к тому, чем оно было до `startHost` (см. там же). */
function restoreParleyHome(previous: string | undefined): void {
  if (previous === undefined) delete process.env['HARNAS_HOME'];
  else process.env['HARNAS_HOME'] = previous;
}
