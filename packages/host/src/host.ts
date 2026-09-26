import { randomBytes } from 'node:crypto';
import { mkdir, chmod, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { harnasHome } from '@harnas/core';
import { createHostContext } from './context.js';
import type { HostContext } from './context.js';
import { createHostServer } from './server.js';
import { createLog } from './log.js';
import { watchIdle } from './idle.js';
import { hostPaths, MAX_SOCKET_PATH_BYTES } from './paths.js';
import type { HostPaths } from './paths.js';
import { createHostHandlers } from './methods/index.js';
import { createWorksService } from './works/works-service.js';
import { createActivityService } from './activity/activity-service.js';
import { createPtyManager } from './pty/pty-manager.js';
import { createSessionsService } from './sessions/sessions-service.js';
import { createWakeService } from './wake/wake-service.js';
import { createWorktreesService } from './worktrees/worktrees-service.js';

export interface HostOptions {
  home?: string;
  idleMs?: number;
  helloTimeoutMs?: number;
  version?: string;
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
  const resolvedHome = options.home ?? harnasHome();
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
  const previousHarnasHome = process.env['HARNAS_HOME'];
  process.env['HARNAS_HOME'] = resolvedHome;

  // 2. Каталог хоста всегда 0700, независимо от того, был он уже или нет.
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);

  // 3. Живой хост на этом сокете — отказ; осколки упавшего — подчищаются.
  if (await socketIsAlive(paths.socket)) {
    restoreHarnasHome(previousHarnasHome);
    throw new HostAlreadyRunning();
  }
  await removeHostFiles(paths);

  // 4. Токен рукопожатия — новый на каждый запуск, права 0600 гарантируются chmod,
  //    а не только `mode` у writeFile (тот режется umask).
  const token = randomBytes(32).toString('hex');
  await writeFile(paths.token, token, { mode: 0o600 });
  await chmod(paths.token, 0o600);

  const log = createLog(paths.log);
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

  // Работы стартуют и останавливаются вместе с хостом: TUI и окно узнают о них
  // через `works.list`/`works.changed`, а на остановке хост снимает свою аренду.
  const worksService = createWorksService(handle.context);
  handle.context.onShutdown(() => worksService.stop());

  // Активность живёт поверх работ: точка статуса и строка метрик окна (1.5).
  // `pty.attach`/`pty.input` (1.6) зовут её `markSeen`.
  const activityService = createActivityService(handle.context, worksService);
  handle.context.onShutdown(() => activityService.stop());

  // Живые PTY сессий (1.6). На остановке хоста добиваются вместе с ним —
  // иначе процесс агента остаётся сиротой без хоста, который бы его закрыл.
  const ptyManager = createPtyManager(handle.context);

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

  const handlers = createHostHandlers({
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
    registerClient: handle.addClient,
    unregisterClient: handle.removeClient,
  });

  // 5. `listen`, затем сокет переводится на 0600 (изначально его создаёт `listen`).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  await chmod(paths.socket, 0o600);

  // 6. pid-файл.
  await writeFile(paths.pid, String(process.pid), { mode: 0o600 });
  await chmod(paths.pid, 0o600);

  // 7. Таймер простоя: ни клиентов, ни занятых ключей — отсчёт стартует сразу.
  idleWatcher.notify(true);

  await worksService.start();
  // Сверка живости уже прошла на первом чтении работ: те, чей журнал оборван
  // посреди хода, прерваны падением прошлого хоста (спека 10).
  await sessionsService.collectInterrupted().catch((error: unknown) => {
    log.error('список прерванных сессий не собрался', { error: String(error) });
  });
  await activityService.start();
  wakeService.start();

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
    await removeHostFiles(paths);
    restoreHarnasHome(previousHarnasHome);
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

async function removeHostFiles(paths: HostPaths): Promise<void> {
  await Promise.all([paths.socket, paths.token, paths.pid].map((file) => rm(file, { force: true })));
}

/** Возвращает `HARNAS_HOME` к тому, чем оно было до `startHost` (см. там же). */
function restoreHarnasHome(previous: string | undefined): void {
  if (previous === undefined) delete process.env['HARNAS_HOME'];
  else process.env['HARNAS_HOME'] = previous;
}
