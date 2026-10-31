import { AGENT_PROVIDERS_PATH, createProvidersEndpoint, providerRowsOf } from './agent/providers-endpoint.js';
import { AGENT_SESSIONS_PATH, createSessionEndpoint } from './agent/session-endpoint.js';
import { AGENT_SWITCH_PATH, createSwitchEndpoint } from './agent/switch-endpoint.js';
import { AGENT_SWARMS_PATH, createSwarmEndpoint } from './agent/swarm-endpoint.js';
import { AGENT_ATTEMPTS_PATH, createAttemptsEndpoint } from './agent/attempts-endpoint.js';
import { hostToolContext, mapChangeSignal, turnBoundarySource } from './agent/tool-context.js';
import { createToolsEndpoint } from './agent/tools-endpoint.js';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, link, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_TOOLS_PATH,
  ASSISTANT_MIN_VERSIONS,
  bothEnv,
  clearSecret,
  closeWorkDb,
  createWork,
  findRunnerBinary,
  grantTrust,
  isMember,
  isRoomArchived,
  isStaleHostLock,
  loadConfig,
  loadProviders,
  PARLEY,
  providerLabel,
  updateMap,
  migrateMapsToDb,
  migrateProjects,
  parleyHome,
  parseHostLock,
  processStartedAt,
  providerReadiness,
  providerReadinessError,
  readHostLock,
  readMap,
  readSecret,
  rewriteArtifactRefs,
  roleSummaries,
  socketIsAlive,
  versionAtLeast,
  workPaths,
  writeSecret,
  type ProjectMigration,
  type ProviderEntry,
} from '@parley/core';
import { createTelegramService } from './telegram/service.js';
import { createHostContext } from './context.js';
import type { HostContext, RequestInfo } from './context.js';
import { createHostServer } from './server.js';
import { HostError } from './errors.js';
import { createLog } from './log.js';
import type { Log } from './log.js';
import { watchIdle } from './idle.js';
import { startLoopDelayLog } from './loop-delay.js';
import { createHealthService } from './health/health-service.js';
import { createWindowCounters } from './health/window-counters.js';
import { createProfiler } from './diagnostics/profiler.js';
import { hostPaths, MAX_SOCKET_PATH_BYTES } from './paths.js';
import type { HostPaths } from './paths.js';
import { ASSISTANT_ACTIONS_FEATURE, HOST_ERROR_REASONS } from '@parley/protocol';
import type { HostNotice, Result, SessionRef } from '@parley/protocol';
import { createHostHandlers } from './methods/index.js';
import { createCachedCatalog } from './methods/role-catalog-cache.js';
import { createWorksService } from './works/works-service.js';
import { createActivityService } from './activity/activity-service.js';
import { createCapacityFeed } from './capacity/capacity-feed.js';
import { createCapacityService } from './capacity/capacity-service.js';
import { createPressureSensor } from './capacity/memory-pressure.js';
import { createCompactionService, type CompactionService } from './compaction/compaction-service.js';
import { createConsentsService } from './consents/consents-service.js';
import { createHeldLaunchActions } from './consents/held-launches.js';
import { createContextService } from './context/context-service.js';
import { createCodexLogPoller } from './activity/codex-log-poll.js';
import { linkTerminalActivity } from './activity/terminal-link.js';
import { createGlmCheckService } from './limits/glm-check.js';
import type { GlmCheckOptions } from './limits/glm-check.js';
import { createAuthService } from './providers/auth-service.js';
import type { AuthServiceOptions } from './providers/auth-service.js';
import { createCustomCheckService } from './providers/custom-check.js';
import type { CustomCheckOptions } from './providers/custom-check.js';
import { createLimitsService } from './limits/limits-service.js';
import type { LimitsServiceOptions } from './limits/limits-service.js';
import { startCodexCatalog } from './providers/codex-catalog.js';
import type { CatalogProbe } from './providers/codex-catalog.js';
import { startProviderVersions } from './providers/versions.js';
import type { VersionProbe } from './providers/versions.js';
import { createPtyManager } from './pty/pty-manager.js';
import { createSender } from './pty/send.js';
import { createFeedService } from './feed/feed-service.js';
import { ensureCodexHookLauncher } from './feed/codex-hook-launcher.js';
import { createBacklogService } from './backlog/backlog-service.js';
import { createPlanEffectsService } from './rooms/plan-effects.js';
import { autonomousEngineIO, createAutonomousEngine } from './rooms/autonomous-engine.js';
import { swarmMemberOf } from './swarms/spawn.js';
import { createSwarmsService } from './swarms/swarms-service.js';
import { createHistoryService } from './rooms/history-service.js';
import { addRoomMember, createHumanRoom, resolveRoomProposal, sendHumanLetter } from './rooms/rooms-service.js';
import { createAssistantEndpoint } from './assistant/assistant-endpoint.js';
import { createAssistantService, type AssistantService } from './assistant/assistant-service.js';
import { createReminderStore } from './assistant/reminders.js';
import { AGENT_BROWSER_PATH, createBrowserEndpoint } from './agent/browser-endpoint.js';
import { createHookServer } from './hooks/hook-server.js';
import { createSessionsService } from './sessions/sessions-service.js';
import { providerLaunchEnv } from './sessions/provider-env.js';
import { createReadyJournal } from './sessions/ready-journal.js';
import { createAutoSleepService } from './sleep/auto-sleep-service.js';
import { limitAlternatives } from './stuck/limit-alternatives.js';
import { createStuckService, stuckReportFromEnv } from './stuck/stuck-service.js';
import { limitReturnFromEnv } from './wake/limit-return.js';
import { createWakeService } from './wake/wake-service.js';
import { createWorktreesService } from './worktrees/worktrees-service.js';
import { readHostVersion } from './version.js';

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
   * Проба каталога моделей Codex на старте (`codex debug models`, спека нормалайзера, 5.2). Без неё каталога нет и
   * действует встроенный список: подключает её только `main.ts`, а тесты, где настоящий codex запускать нельзя,
   * зовут `startHost` без пробы или с подменой.
   */
  probeCodexCatalog?: CatalogProbe;
  /**
   * Лимиты подписок (спека комнат Organic, 3.5): корень логов Codex, часы и период опроса. Боевой хост
   * не задаёт ничего — опрос раз в 30 секунд, логи в `~/.codex/sessions`; тесты и E2E окна — свои.
   */
  limits?: LimitsServiceOptions;
  /**
   * Явная проверка ключа Z.ai (`providers.check`): сеть, часы и файл исхода. Боевой хост не задаёт ничего;
   * тесты подменяют `fetch`, а E2E окна — исход без сети (`PARLEY_GLM_CHECK_STUB`).
   */
  glmCheck?: GlmCheckOptions;
  /** Подмена сети проверки своего провайдера (спека 5.5); боевой хост не задаёт. */
  customCheck?: CustomCheckOptions;
  /** Подмена команд CLI и PTY службы входа в аккаунты подписки (спека подписок 5.5); боевой хост не задаёт. */
  auth?: AuthServiceOptions;
  /**
   * Срок экранов старта Codex, мс (спека комнат Organic, 3.6): не показал `Ready` и `Working` — сессия «нужен
   * ты». Боевой хост не задаёт — 20 секунд; E2E окна сокращает его переменной `PARLEY_CODEX_STARTUP_MS`.
   */
  startupWaitMs?: number;
  /**
   * Срок ожидания хуков Codex после старта процесса, мс (спека 2026-10-07, 5.7): ни одного хука — подсказка про доверие.
   * Боевой хост не задаёт — 15 секунд; E2E окна сокращает его переменной `PARLEY_CODEX_HOOK_GRACE_MS`.
   */
  codexHookGraceMs?: number;
}

export interface RunningHost {
  paths: HostPaths;
  context: HostContext;
  /** Разрешается причиной остановки: `'idle' | 'signal' | 'host.shutdown' | ...`. */
  closed: Promise<string>;
}

export class HostAlreadyRunning extends Error {
  constructor() {
    super('a host is already running for this Parley home');
    this.name = 'HostAlreadyRunning';
  }
}

export class SocketPathTooLong extends Error {
  constructor(socketPath: string) {
    super(`socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes: ${socketPath}`);
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
  // из окружения (`PARLEY_HOME`) — параметра-оверрайда у них нет. Чтобы список
  // работ хоста совпадал с его же файлами (`options.home` в тестах — не
  // настоящий `~/.parley`), окружение здесь и приводится к тому же дому,
  // а на остановке возвращается прежним (см. `runShutdown`). Дом ставится под обоими
  // именами (R3): агенты и скрипты, которых хост запускает, наследуют окружение, и
  // прежние читают `HARNAS_HOME`.
  const previousHomes = homeEnvOf(process.env);
  Object.assign(process.env, bothEnv({ HOME: resolvedHome }));

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
    restoreHomeEnv(previousHomes);
    throw new HostAlreadyRunning();
  }
  if (await socketIsAlive(paths.socket)) {
    await releasePidLock(paths.pid);
    restoreHomeEnv(previousHomes);
    throw new HostAlreadyRunning();
  }
  await Promise.all([paths.socket, paths.token].map((file) => rm(file, { force: true })));

  // 4. Токен рукопожатия — новый на каждый запуск, права 0600 гарантируются chmod,
  //    а не только `mode` у writeFile (тот режется umask).
  const token = randomBytes(32).toString('hex');
  await writeFile(paths.token, token, { mode: 0o600 });
  await chmod(paths.token, 0o600);

  // 4а. Данные прежней сборки переезжают (R6, спека хранилища 6.6): каталоги состояния проектов `.harnas` → `.parley`,
  //     затем карты `map.json` → база, затем пути артефактов в картах. Под замком хоста, до сокета, службы работ и
  //     автозапуска сессий — ни клиент, ни наблюдатель ещё не держат старый путь, `works.create` не успеет записать в
  //     каталог, который сейчас переименуется, а служба работ первым же чтением увидит уже переехавшие карты.
  const migration = await migrateStorage(log);
  // Работа, что осталась в файле, из списка окна пропадает: окну нужно её назвать. Текст — путь `map.json` (из него окно
  // берёт номер работы и имя проекта) и со следующей строки причина; подробности остаются в журнале хоста.
  const startupNotices = migration.unmoved.map(
    ({ projectPath, workId, reason }): HostNotice => ({
      kind: 'map-migration-failed',
      ref: null,
      text: `${workPaths(projectPath, workId).map}\n${reason}`,
      at: new Date().toISOString(),
    }),
  );

  const hostVersion = options.version ?? readHostVersion();
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
  // Счётчики окна строки состояния: сервисы пишут, health читает и обнуляет.
  const windowCounters = createWindowCounters();
  const worksService = createWorksService(handle.context, {
    windowCounters,
    // `ptyManager` создаётся ниже, поэтому набор берётся лениво, на каждую сверку живости.
    ownedPids: () => new Set(ptyManager.list().map((h) => h.pid)),
  });
  // Сервис зовёт onFailure по разу на каждый код сбоя (конфликт снимка, журнал решения), а у человека одна карточка
  // с одним текстом: повтор для той же работы только вытеснял бы из строки статуса прежние уведомления.
  const planEffectNoticed = new Set<string>();
  const planEffects = createPlanEffectsService(worksService, {
    onFailure: ({ projectPath, workId }) => {
      const key = `${projectPath}\0${workId}`;
      if (planEffectNoticed.has(key)) return;
      planEffectNoticed.add(key);
      handle.context.broadcast('host.notice', {
        kind: 'plan-effect-failed',
        ref: null,
        text: 'Plan delivery or export remains pending. Open the plan and retry after resolving the conflict.',
        at: new Date().toISOString(),
      });
    },
  });
  const history = createHistoryService(worksService, {
    onFailure: ({ count }) => log.warn('history-write-failed', { count }),
  });
  const stopLoopDelay = startLoopDelayLog(handle.context.log);
  handle.context.onShutdown(async () => stopLoopDelay());
  // Строка состояния хоста раз в 30 с. Счётчики читаются лениво при `sample()`, поэтому замыкание вправе
  // ссылаться на сервисы и `handlers`, которые заводятся ниже.
  const health = createHealthService({
    log: handle.context.log,
    windowCounters,
    counters: () => {
      const { entries } = worksService.snapshot();
      return {
        ptys: ptyManager.list().length,
        attached: handlers.counters.ptyAttached(),
        feedSubs: feedService.subscriberCount(),
        works: entries.length,
        rooms: entries.reduce((sum, entry) => sum + entry.map.rooms.length, 0),
        clients: handle.context.clients().length,
      };
    },
  });
  handle.context.onShutdown(async () => planEffects.stop());
  handle.context.onShutdown(async () => history.stop());
  handle.context.onShutdown(() => worksService.stop());

  // Лимиты подписок (спека комнат Organic, 3.5): файлы строки статуса Claude Code и логи Codex, раз в
  // 30 секунд; окну — в `providers.list` и событием `providers.limitsChanged`. Запускается в конце
  // старта, когда снимок работ уже прочитан. Создаётся до активности: время сброса лимита сессии она берёт
  // у этой службы (спека «Застрявшие сессии», 3.4).
  const limitsService = createLimitsService(handle.context, worksService, options.limits);
  handle.context.onShutdown(async () => limitsService.stop());

  // Активность живёт поверх работ: точка статуса и строка метрик окна (1.5).
  // `pty.attach`/`pty.input` (1.6) зовут её `markSeen`.
  const activityService = createActivityService(handle.context, worksService, {
    windowCounters,
    ...(options.startupWaitMs === undefined ? {} : { startupWaitMs: options.startupWaitMs }),
    limits: limitsService,
  });
  handle.context.onShutdown(() => activityService.stop());

  // Вход в аккаунты подписки (спека подписок 5.5): состояние по команде самого CLI, вход в своём маленьком PTY. Создаётся
  // до сессий и службы «застрял»: обе берут у неё `status`. Проверка на старте (К5) идёт в фоне, старт хоста её не ждёт.
  const authService = createAuthService(handle.context, options.auth);
  handle.context.onShutdown(async () => authService.stop());
  // Вошёл ли аккаунт для запуска сессии и помощника: кэш службы входа, а пока он пуст (старт хоста, первая проверка ещё
  // идёт) — исход самой проверки, общей с фоновой. Иначе вошедший аккаунт отказывал бы первые секунды после старта (спека
  // подписок 10); упавшая проверка пишет `false`, а не оставляет «не знаем» навсегда.
  const accountSignedIn = (id: string): boolean | Promise<boolean> => authService.status(id) ?? authService.refresh(id);

  // Служба «застрял» (спека застрявших 4.4): эпизоды ожидания человека — в карту, в ленту комнаты и письмом ведущему.
  // Альтернативы для письма о лимите (спека подписок 5.8) — другие вошедшие аккаунты того же CLI, подтверждённые службой
  // входа; эпизод `sign-in` у сессии аккаунта просит службу входа проверить вход заново (К5).
  const stuckService = createStuckService(handle.context, worksService, activityService, {
    reportMs: stuckReportFromEnv(process.env),
    alternatives: (provider) => limitAlternatives(provider, { limits: limitsService, signedIn: (id) => authService.status(id) }),
    // Эпизод говорит, что вход слетел: кэш входа (30 с) заведомо устарел, проверка идёт мимо него.
    onSignIn: (provider) => void authService.refresh(provider, true),
  });
  handle.context.onShutdown(async () => stuckService.stop());

  // Живые PTY сессий (1.6). На остановке хоста добиваются вместе с ним —
  // иначе процесс агента остаётся сиротой без хоста, который бы его закрыл.
  const ptyManager = createPtyManager(handle.context, windowCounters);

  // Состояние сессий codex — по потоку их терминала, а не по хукам (спека комнат Organic, 3.6): менеджер PTY
  // разбирает заголовок окна и уведомления, сервис активности выводит из них состояние.
  const unlinkTerminal = linkTerminalActivity(ptyManager, activityService);
  handle.context.onShutdown(async () => unlinkTerminal());

  // Лента вида «Chat» (план 2026-10-01, Task 2): служба ленты и приёмник HTTP-хуков Claude Code. Приёмник
  // заводится до сервиса сессий — запуск сессии берёт у него адрес и токен (`register`/`unregister`,
  // подкусок 2c), — а слушает с шага 5а, до первого чтения работ и автозапуска.
  const feedService = createFeedService({
    host: handle.context,
    works: worksService,
    activity: activityService,
    pty: ptyManager,
  }, options.codexHookGraceMs === undefined ? {} : { codexHookGraceMs: options.codexHookGraceMs });
  // Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): путь `/agent/browser` на сервере хуков и свой
  // реестр токенов — у всех провайдеров. Операцию исполняет окно с возможностью `browser-agent`.
  const browserEndpoint = createBrowserEndpoint({
    log,
    clients: () => handle.context.clients(),
    // Комнаты сессии — из карты в памяти службы работ (спека 3.7: чтения с диска на пути операции нет).
    roomsOf: (ref) =>
      worksService
        .entry(ref.projectPath, ref.workId)
        ?.map.rooms.filter((room) => isMember(room, ref.sessionId) && !isRoomArchived(room))
        .map((room) => room.id) ?? [],
  });
  // Журнал задержек (спека диагностики хоста, A4): «сессия готова» по первому хуку или сигналу ready Codex.
  const readyJournal = createReadyJournal({ log, pty: ptyManager });
  handle.context.onShutdown(async () => readyJournal.stop());
  // Сжатие контекста (спека 2026-10-15, 5): создаётся после будильника, но хук-сервер и будильник видят его уже сейчас.
  // eslint-disable-next-line prefer-const -- поздняя привязка: замыкания хук-сервера и будильника читают её раньше присваивания
  let compactionService: CompactionService | undefined;
  // Приёмник инструментов помощника (задача 8) нужен серверу хуков при создании, сам сервис — после сессий.
  // eslint-disable-next-line prefer-const -- поздняя привязка: замыкание приёмника читает её раньше присваивания
  let assistantService: AssistantService | undefined;
  const assistantEndpoint = createAssistantEndpoint({
    log,
    tool: (name, args) =>
      assistantService === undefined
        ? Promise.resolve({ status: 503, body: { error: 'the assistant is not ready' } })
        : assistantService.tool(name, args),
  });
  const sessionEndpoint = createSessionEndpoint({
    authenticate: (req) => browserEndpoint.authenticate(req),
    create: (input) => sessionsService.create(input),
  });
  // Просьба агента продолжить сессию на другом провайдере (спека замены агента, 5.5): только карточка согласия.
  const switchEndpoint = createSwitchEndpoint({
    authenticate: (req) => browserEndpoint.authenticate(req),
    readMap: (ref) => readMap(ref.projectPath, ref.workId),
    providerLabel: async (provider) => {
      const entry = (await loadProviders())[provider];
      return entry === undefined ? null : providerLabel(entry);
    },
    request: (input) => {
      consentsService.requestSwitch(input);
    },
  });
  const swarmEndpoint = createSwarmEndpoint({
    authenticate: (req) => browserEndpoint.authenticate(req),
    create: (input) => sessionsService.create(input),
    memberOf: swarmMemberOf,
  });
  const autonomousEngine = createAutonomousEngine(autonomousEngineIO({
    create: input => sessionsService.create(input),
    launch: (ref, mode, choice) => sessionsService.launch(ref, mode, choice),
    stop: ref => sessionsService.stop(ref),
    close: ref => sessionsService.close(ref),
  }), { provider: 'codex', verifier: { provider: 'claude', model: 'sonnet' }, works: worksService,
    onFailure: error => log.error('autonomous engine failed', { error: String(error) }),
  });
  handle.context.onShutdown(() => autonomousEngine.stop());
  const attemptsEndpoint = createAttemptsEndpoint({ authenticate: req => browserEndpoint.authenticate(req), engine: autonomousEngine });
  // Строки провайдеров для агента (спека подписок 5.8, К7): тот же `providers.list`, что у окна, без ключа и проверок.
  // Обработчик собирается ниже, когда готовы службы проверки ключей, поэтому привязка поздняя.
  let listProviders: (() => Promise<Result<'providers.list'>>) | undefined;
  const listProviderRows = async () => {
    if (listProviders === undefined) throw new Error('the host is still starting');
    return providerRowsOf(await listProviders());
  };
  const providersEndpoint = createProvidersEndpoint({
    authenticate: (req) => browserEndpoint.authenticate(req),
    list: listProviderRows,
  });
  // Каталог ролей хоста один на окно (`roles.list`, `recipes.list`) и агентов (`list_roles`): без общего кэша каждый
  // `list_roles` агента заново читал бы конфигурацию Codex (`codex app-server`, до 8 с) — так хост уже подвисал.
  const roleCatalog = createCachedCatalog();
  // Инструменты агента исполняются здесь, в процессе хоста (спека хранилища 6.3, 6.9): карту работы открывает только хост.
  // Строки провайдеров для `get_map {field: "providers"}` — те же, что у `/agent/providers`: ходить к себе по HTTP
  // незачем; `wait_for` будит изменение работ службы, а не `fs.watch`; `list_roles` берёт общий кэш каталога. Токен
  // тот же, что у остальных маршрутов агента.
  const toolsEndpoint = createToolsEndpoint({
    authenticate: (req) => browserEndpoint.authenticate(req),
    contextFor: (ref, launch) =>
      hostToolContext(ref, launch, {
        providerRows: listProviderRows,
        onWorksChange: mapChangeSignal(worksService),
        roleCatalog: (cwd) => roleCatalog(cwd, { codex: true }),
        attempts: (ref, request) => attemptsEndpoint.perform(ref, request, () => browserEndpoint.isRegistered(ref)),
        turnBoundary: turnBoundarySource(worksService, activityService),
        // Лента ёмкости заведена ниже по файлу; вызов поздний, как у `sessionsService`. Сбой снимка не должен ронять
        // инструмент: `null` — в ответе `machine: null`.
        capacity: async (ref) => {
          try {
            const live = activityService.get(ref)?.activity;
            return {
              machine: (await capacityFeed.snapshot()).machine,
              activity: live === undefined ? null : { subagents: live.subagents, background: live.runningBackground },
            };
          } catch {
            return null;
          }
        },
      }),
    log,
  });
  const hookServer = createHookServer({
    log,
    onHook: (request) => {
      readyJournal.onHook(request.ref);
      try {
        compactionService?.onHook(request.ref, request.body);
      } catch (error) {
        log.warn(`compaction hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      feedService.onHook(request);
    },
    routes: { [AGENT_ATTEMPTS_PATH]: (req, res) => attemptsEndpoint.handle(req, res), [AGENT_SESSIONS_PATH]: (req, res) => sessionEndpoint.handle(req, res), [AGENT_SWITCH_PATH]: (req, res) => switchEndpoint.handle(req, res), [AGENT_SWARMS_PATH]: (req, res) => swarmEndpoint.handle(req, res), [AGENT_PROVIDERS_PATH]: (req, res) => providersEndpoint.handle(req, res), [AGENT_TOOLS_PATH]: (req, res) => toolsEndpoint.handle(req, res), [AGENT_BROWSER_PATH]: (req, res) => browserEndpoint.handle(req, res), ...assistantEndpoint.routes() },
  });

  // Версии CLI пробуются один раз на старте, пока остальное поднимается; `providers.list` их ждёт, а
  // запуск сессии — для порога ленты (`feedSupported`), поэтому проба заводится до сервиса сессий.
  const providerVersions = startProviderVersions(options.probeVersion, log);

  // Каталог моделей Codex (спека нормалайзера, 5.2) — проба на старте, в фоне: `providers.list` её не ждёт, а
  // новый каталог хост пишет в `codex-models.json` (его читает `loadProviders` — и окно, и MCP агента) и сообщает
  // окну событием `providers.changed`.
  const codexCatalog = startCodexCatalog(options.probeCodexCatalog, log, () => {
    handle.context.broadcast('providers.changed', { provider: 'codex' });
  });

  // Создание, запуск и автозапуск сессий (1.7). На остановке хоста гасит все
  // живые PTY сам — той же дорогой, что и явный `sessions.stop`. Сессии `claude` с лентой получают
  // адрес приёмника и свой токен (подкусок 2c).
  // Запускатель хука Codex заводится при первой надобности (режим `parley` настройки `codexWriteApprovals`), а не при каждом старте хоста.
  // Не записался — запуск идёт без хуков (Codex спросит одобрение в терминале), а следующий запуск пробует снова.
  let codexHookCommand: Promise<string | undefined> | undefined;
  const codexHookCommandOnce = (): Promise<string | undefined> => {
    codexHookCommand ??= ensureCodexHookLauncher(
      parleyHome(),
      process.execPath,
      fileURLToPath(new URL('./feed/codex-hook-bin.js', import.meta.url)),
    ).catch((error: unknown) => {
      log.warn('хуки Codex: запускатель не записан, запуск без хуков', { error: String(error) });
      codexHookCommand = undefined;
      return undefined;
    });
    return codexHookCommand;
  };
  // Согласия человека на папку (спека 2026-10-21, 4.2 и 4.4): запуск Codex без согласия на проект ждёт здесь. Служба
  // заводится до сессий и будильника, а продолжает запуски через них — привязка поздняя, замыкания читают их позже.
  /* eslint-disable prefer-const -- поздняя привязка: продолжение запусков читает сервисы, созданные ниже */
  let sessionsService!: ReturnType<typeof createSessionsService>;
  let wakeService!: ReturnType<typeof createWakeService>;
  /* eslint-enable prefer-const */
  const consentsService = createConsentsService({
    home: parleyHome(),
    host: handle.context,
    trust: { grant: (folder, by) => grantTrust(folder, by) },
    ...createHeldLaunchActions({
      launch: (ref, mode, launchOptions) => sessionsService.launch(ref, mode, launchOptions),
      close: (ref) => sessionsService.close(ref),
      retry: (ref) => wakeService.retry(ref),
      switched: (ref) => wakeService.switched(ref),
    }),
    // `allow` карточки `agent-switch`: замена от имени человека; ошибка уходит просившему письмом и окну уведомлением.
    switchAgent: (ref, request) => sessionsService.switchAgent(ref, request),
    tellRequester: async (ref, to, text) => {
      await updateMap(ref.projectPath, ref.workId, (map, letters) => {
        if (!map.sessions.some((session) => session.id === to && session.lifecycle !== 'closed')) return;
        letters.add({ roomId: null, from: PARLEY, to: [to], text, kind: 'note', at: new Date().toISOString() });
      });
    },
    noticeFailure: (ref, text) => {
      handle.context.broadcast('host.notice', { kind: 'launch-failed', ref, text, at: new Date().toISOString() });
    },
    // Держать больше нечего: процесс уже идёт, сессия закрыта, запущена другим путём или исчезла вместе с работой.
    isLive: async (ref: SessionRef): Promise<boolean> => {
      if (ptyManager.get(ref) !== undefined) return true;
      try {
        const session = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);
        return session === undefined || session.lifecycle === 'closed' || session.lifecycle === 'active';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    },
  });
  handle.context.onShutdown(async () => consentsService.stop());
  // Датчик давления памяти (спека 2026-10-30, 4.2): раз в 10 с читает уровень. По нему сервис ёмкости пускает запуски или
  // держит их в очереди, а сервис сна решает, пора ли усыплять простаивающих. Читать начинает перед будильником (ниже).
  const pressureSensor = createPressureSensor();
  handle.context.onShutdown(async () => pressureSensor.stop());
  // Потолок машины (спека 2026-10-30, 4.2): допуск запусков, резерв слота и очередь. Заводится до сессий, они зовут его на
  // каждом `launch`; продолжение очереди (`launch`, `retry`) и сон ради слота читают сервисы, созданные ниже, — привязка
  // поздняя, как у согласий. Останавливается раньше `stopAll`, чтобы выходы процессов при остановке хоста не продвигали
  // очередь.
  const capacityService = createCapacityService(handle.context, {
    pty: ptyManager,
    works: worksService,
    pressure: pressureSensor,
    config: async () => (await loadConfig()).config,
    launch: (ref, mode, choice) => sessionsService.launch(ref, mode, choice),
    retry: (ref) => wakeService.retry(ref),
    sleep: () => autoSleepService,
  });
  handle.context.onShutdown(async () => capacityService.stop());
  // Числа ёмкости для окна (спека 2026-10-30, 4.5): снимок по запросу и рассылка `capacity.changed`.
  const capacityFeed = createCapacityFeed(handle.context, {
    capacity: capacityService,
    pressure: pressureSensor,
    works: worksService,
    pty: ptyManager,
    config: async () => (await loadConfig()).config,
  });
  handle.context.onShutdown(async () => capacityFeed.stop());
  sessionsService = createSessionsService(
    handle.context,
    worksService,
    ptyManager,
    activityService,
    {
      capacity: capacityService,
      consents: consentsService,
      hooks: hookServer,
      providerVersions,
      signedIn: accountSignedIn,
      codexHookCommand: codexHookCommandOnce,
      agent: {
        url: () => {
          const origin = hookServer.origin();
          return origin === null ? null : `${origin}${AGENT_BROWSER_PATH}`;
        },
        register: (ref) => browserEndpoint.register(ref),
        // Токен снят — и исполнитель сессии с памятью её вызовов уходит вместе с ним.
        unregister: (ref) => {
          browserEndpoint.unregister(ref);
          toolsEndpoint.forget(ref);
        },
      },
      // Замена агента (спека 2026-10-30): эпизод «застрял» закрывается молча, будильник (создан ниже) забывает прежний
      // подъём, подсказка цели — те же вошедшие аккаунты и лимиты, что в письме о лимите.
      takeover: {
        stuck: stuckService,
        wake: () => wakeService,
        alternatives: (provider) => limitAlternatives(provider, { limits: limitsService, signedIn: (id) => authService.status(id) }),
        limits: (provider) => limitsService.get(provider),
      },
    },
  );
  handle.context.onShutdown(() => sessionsService.stopAll());
  // Жизненный цикл роёв (спека роя v1, 3): сверка на каждом снимке работ и раз в 30 с; стартует после чтения работ.
  // Королеву завершённого роя усыпляет сервис сна: он создаётся ниже, замыкание читает его позже.
  const swarmsService = createSwarmsService(handle.context, worksService, sessionsService, {}, {
    requestSleep: (ref, reason) => autoSleepService.requestSleep(ref, reason),
  });
  handle.context.onShutdown(() => swarmsService.stop());
  // После остановки сессий: их `SessionEnd` ещё доходят до ленты и получают ответ. Потом всем
  // висящим хукам — `{}`, и приёмник закрывается.
  handle.context.onShutdown(async () => {
    // Висящим операциям агента — `window_not_connected`, а не обрыв соединения.
    browserEndpoint.close();
    await feedService.stop();
    await hookServer.close();
  });

  // Будильник (1.8, 3.4): печатает указатель на непрочитанные письма
  // простаивающему агенту без канала и поднимает спящих письмом. Останавливается
  // вместе с хостом — иначе его таймеры Enter/предохранителя пережили бы
  // закрытые PTY.
  wakeService = createWakeService(
    handle.context,
    worksService,
    activityService,
    ptyManager,
    sessionsService,
    {
      compacting: (ref) => compactionService?.holds(ref) === true,
      windowCounters,
      // Возврат после сброса лимита (спека застрявших 6.3): окно провайдера из службы лимитов, сроки — рычаги E2E.
      limits: limitsService,
      limitReturn: limitReturnFromEnv(process.env),
    },
  );
  handle.context.onShutdown(async () => wakeService.stop());

  // Сон агентов (спека 2026-10-30, 4.1): усыпляет простаивающих агентов Claude Code, а письмо поднимает их будильником.
  // Сжатие создаётся ниже: замыкание читает его позже, как у будильника.
  const autoSleepService = createAutoSleepService(handle.context, {
    works: worksService,
    activity: activityService,
    pty: ptyManager,
    sessions: sessionsService,
    wake: wakeService,
    compacting: (ref) => compactionService?.holds(ref) === true,
    config: async () => (await loadConfig()).config,
    // Сон по давлению памяти и ради слота очереди (спека, 4.2) читает тот же датчик, что и сервис ёмкости.
    pressure: pressureSensor,
  });
  handle.context.onShutdown(async () => autoSleepService.stop());

  compactionService = createCompactionService({
    host: handle.context,
    pty: ptyManager,
    activity: activityService,
    exclusive: sessionsService.exclusive,
    wake: wakeService,
  });
  compactionService.start();
  handle.context.onShutdown(async () => compactionService?.stop());

  // Один отправитель на хост: окно (`pty.send`) и помощник делят «свой Enter в полёте» по сессии.
  const send = createSender({
    pty: ptyManager,
    activity: activityService,
    wake: wakeService,
    switching: (ref: SessionRef) => sessionsService.exclusive.held(ref),
  });
  const secretOf = (entry: ProviderEntry): Promise<string | null> =>
    entry.runner.secret === undefined ? Promise.resolve(null) : readSecret(entry.runner.secret);
  // Готовность провайдера к запуску агента: ключ, версия CLI для окна, вход аккаунта подписки. Версия для помощника — в `ready`.
  const sessionReady = async (entry: ProviderEntry): Promise<string | null> => {
    await providerVersions.ready;
    const key = await secretOf(entry);
    const readiness = await providerReadiness(entry, {
      keyPresent: key !== null,
      probeVersion: (command) => providerVersions.fresh(command),
      // Аккаунт подписки готов только со входом (спека подписок 5.5): без этого помощник отказывал бы и вошедшему.
      signedIn: entry.account === undefined ? null : await accountSignedIn(entry.id),
    });
    if (readiness.needs !== null || readiness.error !== null) return providerReadinessError(entry, readiness) ?? `${entry.label} is not ready`;
    return null;
  };
  const reminders = createReminderStore({ home: parleyHome(), log: (line) => log.info(line) });
  assistantService = createAssistantService({
    broadcast: (event, data) => handle.context.broadcast(event, data),
    works: worksService,
    activity: activityService,
    feed: feedService,
    send,
    launch: async (ref, mode, options) => {
      const outcome = await sessionsService.launch(ref, mode, options);
      // Запуск Codex ждёт согласия человека на папку: письмо ассистента не доставлено, он скажет об этом и не отметит «sent».
      if (outcome === 'held') {
        throw new HostError('conflict', 'The session waits for the human to trust the folder. Send the message again after it is allowed.');
      }
      // Машине тесно: сессия стоит в очереди и стартует сама, а письмо ей пока уйти не может — так же.
      if (outcome === 'queued') {
        throw new HostError('conflict', 'This machine is at its agent limit: the session is queued and starts by itself when a slot frees. Send the message again after it starts.');
      }
    },
    sendLetter: (input) => sendHumanLetter(input, { via: 'assistant' }),
    createRoom: (input) => createHumanRoom(input),
    resolveRoomProposal: (input) => resolveRoomProposal(input),
    endpoint: { origin: () => hookServer.origin(), setToken: (token) => assistantEndpoint.setToken(token) },
    // Шаги плана карточки `actions` (спека 2026-10-28, 6.1): те же функции хоста, что зовёт окно.
    createWork: async (input) => (await createWork(input.projectPath, { title: input.title, goal: input.goal })).work.id,
    // `exactOptionalPropertyTypes`: zod даёт `role?: … | undefined`, а `CreateSessionInput` явного `undefined` ключом не принимает —
    // как в `sessionsCreate` (methods/sessions.ts). Отсутствующая `model` остаётся без ключа, явный `null` доходит.
    createSession: (input) => {
      const { worktree, model, effort, role, agent, lean, ...rest } = input;
      return sessionsService.create({
        ...rest,
        ...(role === undefined ? {} : { role }),
        ...(agent === undefined ? {} : { agent }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(lean === undefined ? {} : { lean }),
      });
    },
    resume: (ref, prompt) => sessionsService.launch(ref, 'resume', { by: 'human', ...(prompt === null ? {} : { prompt }) }),
    interrupt: (ref) => feedService.interrupt(ref),
    stopSession: (ref) => sessionsService.stop(ref),
    closeSession: (ref) => sessionsService.close(ref),
    addRoomMember: (input) => addRoomMember(input),
    roles: async (projectPath) => roleSummaries(await roleCatalog(projectPath, { codex: true })).roles,
    leanAgents: async () => (await loadConfig()).config.leanAgents,
    providerReady: sessionReady,
    // `telegram` создаётся ниже, но зовётся уже после запуска, как `onReminderWhileOff`.
    actionsShown: () =>
      handle.context.clients().some((client) => client.features.has(ASSISTANT_ACTIONS_FEATURE)) ||
      (telegram.status().enabled && telegram.status().owner !== null),
    providers: () => loadProviders(),
    ready: async (entry) => {
      const notReady = await sessionReady(entry);
      if (notReady !== null) return notReady;
      const min = ASSISTANT_MIN_VERSIONS[entry.runner.command];
      const version = providerVersions.get(entry.runner.command);
      return min !== undefined && version !== null && !versionAtLeast(version, min)
        ? `Update the ${entry.label} CLI to ${min} or newer to use the assistant`
        : null;
    },
    launchEnv: async (entry) => providerLaunchEnv(entry, process.env, {}, await secretOf(entry)),
    binary: (command) => findRunnerBinary(command, process.env),
    reminders,
    home: parleyHome(),
    log: (line) => log.info(line),
    onReminderWhileOff: (reminder) => telegram.reminderWhileOff(reminder),
  });
  const reminderTarget = assistantService;

  // Канал Telegram (план B): опрос бота, карточки и письма; остановка раньше помощника, чтобы мост отписался первым.
  const telegram = createTelegramService({
    home: parleyHome(),
    host: handle.context,
    works: worksService,
    activity: activityService,
    feed: feedService,
    providers: () => loadProviders(),
    assistant: assistantService,
    // `by: 'telegram'` называет канал решения в trust.json: кто выдал доверие папке.
    consents: {
      list: () => consentsService.list(),
      decide: (id, decision) => consentsService.decide(id, decision, 'telegram'),
      onChange: (listener) => consentsService.onChange(listener),
    },
    sendLetter: (input) => sendHumanLetter(input, { via: 'telegram' }),
    resolveRoomProposal: (input) => resolveRoomProposal(input),
    config: async () => (await loadConfig()).config,
    secret: {
      read: () => readSecret('telegram'),
      write: (value) => writeSecret('telegram', value),
      clear: () => clearSecret('telegram'),
    },
    fetch: globalThis.fetch,
    ...(process.env.PARLEY_TELEGRAM_API === undefined ? {} : { apiBase: process.env.PARLEY_TELEGRAM_API }),
    engine:
      process.env.PARLEY_WHISPER_BIN !== undefined && process.env.PARLEY_WHISPER_VAD !== undefined
        ? { bin: process.env.PARLEY_WHISPER_BIN, vadModel: process.env.PARLEY_WHISPER_VAD }
        : null,
    macName: os.hostname(),
    log: (line) => log.info(line),
  });
  handle.context.onShutdown(async () => telegram.stop());
  handle.context.onShutdown(async () => reminders.stop());
  handle.context.onShutdown(async () => assistantService?.stop());

  // Заполненность контекста Claude/GLM (спека 2026-10-15, 4.3): опрос файлов строки статуса раз в 5 секунд.
  const contextService = createContextService({ pty: ptyManager, activity: activityService });
  contextService.start();
  handle.context.onShutdown(async () => contextService.stop());

  // Индекс логов Codex: `fs.watch` на macOS дозаписи rollout не доставляет — перечитываем файлы запущенных сессий сами.
  const codexLogPoller = createCodexLogPoller({ pty: ptyManager, activity: activityService });
  codexLogPoller.start();
  handle.context.onShutdown(async () => codexLogPoller.stop());

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

  // Явная проверка ключа Z.ai: тестовое сообщение только по запросу окна; старт хоста в сеть не ходит.
  const glmCheck = createGlmCheckService(handle.context, options.glmCheck);
  const customCheck = createCustomCheckService(handle.context, options.customCheck);

  const backlogService = createBacklogService();
  handle.context.onShutdown(async () => backlogService.close());

  // Профиль CPU по запросу: файлы в `~/.parley/host/diagnostics`; идущая запись на остановке хоста дописывается.
  const profiler = createProfiler({ dir: path.join(paths.dir, 'diagnostics'), log: handle.context.log });
  handle.context.onShutdown(async () => profiler.stop());

  const handlers = createHostHandlers({
    roleCatalog,
    backlog: backlogService,
    planEffects,
    autonomousEngine,
    history,
    worksReady,
    providerVersions,
    codexCatalog,
    limits: limitsService,
    glmCheck,
    customCheck,
    auth: authService,
    works: worksService,
    activity: activityService,
    pty: ptyManager,
    sessions: sessionsService,
    swarms: swarmsService,
    wake: wakeService,
    consents: consentsService,
    capacityFeed,
    compaction: compactionService,
    worktrees: worktreesService,
    feed: feedService,
    browserAgent: browserEndpoint,
    send,
    assistant: assistantService,
    telegram,
    health,
    profiler,
    log: handle.context.log,
  });
  // `providers.list` не читает ни параметры, ни запрос: заглушки только для типа обработчика.
  const providersListHandler = handlers.methods['providers.list'];
  if (providersListHandler !== undefined) {
    listProviders = () => providersListHandler({} as never, {} as RequestInfo) as Promise<Result<'providers.list'>>;
  }
  health.start();
  handle.context.onShutdown(async () => health.stop());
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
      // Карты, не переехавшие в базу на старте: клиентов в тот момент ещё не было, поэтому уведомление повторяется каждому
      // подключившемуся (оно уходит ему, а не всем, чтобы переподключение одного окна не заливало остальные).
      for (const data of startupNotices) client.send({ event: 'host.notice', data });
    },
    // Ушедший клиент снимается и с подписок ленты: иначе его `Client` жил бы в них до следующей дельты.
    unregisterClient: (client) => {
      handle.removeClient(client);
      feedService.dropClient(client);
      browserEndpoint.dropClient(client);
      handlers.dropClient(client);
      backlogService.removeClient(client.id);
    },
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
    health.stop();
    await releasePidLock(paths.pid);
    restoreHomeEnv(previousHomes);
    throw error;
  }
  await chmod(paths.socket, 0o600);

  // 5а. Приёмник хуков ленты — до запуска сессий. Не поднялся — хост живёт без ленты: сессии
  //     запускаются без HTTP-хуков (`hookServer.url()` — null), окно показывает терминал.
  await hookServer.listen().catch((error: unknown) => {
    log.error('приёмник хуков ленты не поднялся', { error: String(error) });
  });

  // 6. pid-файл — уже замок из шага 3.

  // 7. Таймер простоя: ни клиентов, ни занятых ключей — отсчёт стартует сразу.
  idleWatcher.notify(true);

  const startFailure = await worksService.start().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  // Прежний индекс, который не разобрался, — тот же отказ первого чтения, что и раньше: переезд карт его не пропускает, а
  // пустая таблица иначе сошла бы за «работ нет» и окно не показало бы причину (`works-unreadable`).
  const worksFailure = migration.unreadable ?? startFailure;
  if (worksFailure === null) {
    // Сверка живости уже прошла на первом чтении работ: те, чей журнал оборван
    // посреди хода, прерваны падением прошлого хоста (спека 10).
    await sessionsService.collectInterrupted().catch((error: unknown) => {
      log.error('список прерванных сессий не собрался', { error: String(error) });
    });
    // Замена агента, оборванная прежним хостом: `switching` в карте снимается до того, как будильник начнёт будить.
    await sessionsService.clearStaleSwitches().catch((error: unknown) => {
      log.error('оборванные замены агента не снялись', { error: String(error) });
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
      new HostError('internal', `workspaces could not be read at host start: ${worksFailure}`, {
        reason: HOST_ERROR_REASONS.worksUnreadable,
      }),
    );
  }
  // Напоминания — после ворот работ и приёмника хуков: раньше ход помощника упёрся бы в «хоста ещё нет».
  reminders.start((reminder, late) => reminderTarget.onReminder(reminder, late));
  // Сбой канала не должен останавливать хост.
  await telegram.start().catch((error: unknown) => {
    log.error('telegram не запустился', { error: String(error) });
  });
  // До активности: сверка эпизодов с картой идёт по первому изменению каждой сессии (спека застрявших 4.4), а оно
  // приходит из самого `activityService.start()`.
  stuckService.start();
  // Состояние входа аккаунтов (К5): в фоне, `providers.changed` придёт, когда ответы CLI будут разобраны.
  void authService.refreshAll();
  await activityService.start();
  planEffects.start();
  autonomousEngine.start();
  swarmsService.start();
  history.start();
  // Датчик начинает читать раньше будильника и сна, очередь стартует после них: уже первый проход насоса может и
  // перепроверить письма (будильник), и усыпить простаивающего ради слота (сон).
  pressureSensor.start();
  wakeService.start();
  autoSleepService.start();
  // Очередь собирается из карт работ, прочитанных выше: запуски, что ждали слота до перезапуска хоста, продолжаются.
  capacityService.start();
  capacityFeed.start();
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
    // База работ — после всех хуков, службу работ (опрос базы) в их числе: журнал WAL сводится в файл базы здесь, а не
    // восстанавливается следующим стартом (спека хранилища 6.1).
    try {
      closeWorkDb();
    } catch (error) {
      log.error('база работ не закрылась', { error: String(error) });
    }

    // `server.close()` дожидается закрытия всех соединений — без явного
    // разрыва клиенты, которые сами не отключились, повесили бы остановку.
    for (const client of handle.context.clients()) client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Замок — последним: пока он держится, новый хост не стартует и не застанет сокет и токен
    // уходящего (lane-r4).
    await Promise.all([paths.socket, paths.token].map((file) => rm(file, { force: true })));
    await releasePidLock(paths.pid);
    restoreHomeEnv(previousHomes);
    log.info('хост остановлен', { reason });
    resolveClosed(reason);
  }

  log.info('хост запущен', { pid: process.pid, version: hostVersion });

  return { paths, context: handle.context, closed };
}

/**
 * Перенос `<проект>/.harnas` → `<проект>/.parley` у проектов из индекса работ (R6, `migrateProjects` в core):
 * только когда у работ проекта нет живого процесса и блокировки записи и git не отслеживает прежний каталог,
 * иначе проект остаётся при нём и перенос пробуется на следующем старте. Сбой переноса хост не останавливает:
 * читатели знают оба имени.
 */
async function moveProjectStateDirs(log: Log): Promise<ProjectMigration[]> {
  try {
    const migrations = await migrateProjects();
    for (const { projectPath, ...result } of migrations) {
      if (result.status === 'moved') {
        log.info('каталог состояния проекта перенесён', { projectPath, from: result.from, to: result.to });
      } else if (result.reason !== 'no-legacy') {
        // Живая сессия и блокировка — обычное дело (перенос позже), закоммиченный `.harnas` — выбор человека
        // (каталог остаётся, пока он его отслеживает); остальное человеку стоит увидеть.
        const expected = result.reason === 'live-session' || result.reason === 'locked' || result.reason === 'tracked';
        log[expected ? 'info' : 'warn']('каталог состояния проекта не перенесён', { projectPath, ...result });
      }
    }
    return migrations;
  } catch (error) {
    log.error('перенос каталогов состояния проектов не выполнен', { error: String(error) });
    return [];
  }
}

/**
 * Первый старт на данных прежней сборки, три шага строго по порядку (спека хранилища 6.6): (1) каталоги состояния на
 * уровне файлов, (2) карты `map.json` → база (`migrateMapsToDb`), (3) пути артефактов в картах переехавших проектов:
 * они правятся через `updateMap`, и строки работ к этому моменту должны быть в базе. Сбой одного шага остальные не
 * останавливает и хост не роняет: что не переехало, остаётся в прежних файлах, и следующий старт пробует снова.
 * Возвращает карты, которые не переехали (окно узнает о них уведомлением), и причину, если сам переезд не смог начаться:
 * тогда первое чтение работ считается отказавшим (`works-unreadable`).
 */
async function migrateStorage(log: Log): Promise<{
  /** Работы, что остались в файле: не вышло (`failed`) или заняты процессом прежней сборки (`skipped`) — окну нужны обе. */
  unmoved: Array<{ projectPath: string; workId: string; reason: string }>;
  unreadable: string | null;
}> {
  const moved = await moveProjectStateDirs(log);
  let unmoved: Array<{ projectPath: string; workId: string; reason: string }> = [];
  let unreadable: string | null = null;
  try {
    const result = await migrateMapsToDb({ log: (line) => log.info(line) });
    unmoved = [
      ...result.failed,
      ...result.skipped.map(({ projectPath, workId }) => ({
        projectPath,
        workId,
        reason: 'busy: map.lock is held by a running process',
      })),
    ];
  } catch (error) {
    // Прежний индекс не разобрался (или база не читается): карт не назвать, и список работ пуст не потому, что работ нет.
    unreadable = error instanceof Error ? error.message : String(error);
    log.error('переезд карт в базу не выполнен', { error: unreadable });
  }
  await rewriteArtifactRefs(moved).catch((error: unknown) => {
    log.error('пути артефактов в переехавших каталогах не поправлены', { error: String(error) });
  });
  return { unmoved, unreadable };
}

/**
 * Замок единственности хоста — файл `host.pid` (раунд lane-r4): первая строка — pid держателя,
 * вторая — время старта его процесса по ОС (раунд lane-r5; пусто, если ОС его не сообщила).
 * Создаётся ссылкой на уже записанный временный файл: `link` атомарен и падает на существующем,
 * так что читатель никогда не видит пустой замок и не примет его за осколок. true — замок наш.
 *
 * Занят живым держателем — отказ, ничего не удаляется (что считается живым — `isStaleHostLock` в core).
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
      const held = await readHostLock(lockPath);
      if (held === null) continue; // замок сняли между link и чтением
      if (!(await isStaleHostLock(held))) return false;
      const stale = `${lockPath}.stale.${own}`;
      try {
        await rename(lockPath, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const moved = await readHostLock(stale);
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

/** Снимает замок, только если он наш: чужой (новый хост уже взял) не трогается. */
async function releasePidLock(lockPath: string): Promise<void> {
  const held = await readHostLock(lockPath).catch(() => null);
  if (held !== null && parseHostLock(held.text).pid === process.pid) await rm(lockPath, { force: true });
}

/** Имена дома в окружении — новое и прежнее. */
const HOME_ENV_NAMES = Object.keys(bothEnv({ HOME: '' }));

/** Значения обоих имён дома как они были до `startHost`. */
function homeEnvOf(env: NodeJS.ProcessEnv): Array<[string, string | undefined]> {
  return HOME_ENV_NAMES.map((name) => [name, env[name]]);
}

/** Возвращает `PARLEY_HOME` и `HARNAS_HOME` к тому, чем они были до `startHost` (см. там же). */
function restoreHomeEnv(previous: ReadonlyArray<[string, string | undefined]>): void {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
