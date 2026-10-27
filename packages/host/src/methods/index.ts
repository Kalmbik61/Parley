import { parleyHome } from '@parley/core';
import { BROWSER_AGENT_ERROR_CODES } from '@parley/protocol';
import type { BrowserAgentErrorCode, BrowserAgentResult, MethodName, NotificationName, Params, SendResult, SessionRef } from '@parley/protocol';
import type { BrowserEndpoint } from '../agent/browser-endpoint.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { BacklogService } from '../backlog/backlog-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { AnyHandler, AnyNotificationHandler, RequestInfo } from '../context.js';
import type { CompactionService } from '../compaction/compaction-service.js';
import type { ConsentsService } from '../consents/consents-service.js';
import { createCompactionMethods } from '../compaction/compaction-methods.js';
import type { Profiler } from '../diagnostics/profiler.js';
import type { FeedService } from '../feed/feed-service.js';
import type { TelegramService } from '../telegram/service.js';
import { createTelegramHandlers } from './telegram.js';
import type { HealthService } from '../health/health-service.js';
import type { Log } from '../log.js';
import type { PlanEffectsService } from '../rooms/plan-effects.js';
import type { HistoryService } from '../rooms/history-service.js';
import { createRoomsUsage } from '../rooms/room-usage.js';
import type { GlmCheckService } from '../limits/glm-check.js';
import type { AuthService } from '../providers/auth-service.js';
import type { CustomCheckService } from '../providers/custom-check.js';
import type { LimitsService } from '../limits/limits-service.js';
import type { CodexCatalog } from '../providers/codex-catalog.js';
import type { ProviderVersions } from '../providers/versions.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';
import { createCapabilitiesHandlers, createCapabilitiesList } from './capabilities.js';
import { createAssistantHandlers } from './assistant.js';
import { createAuthHandlers } from './auth.js';
import { createBacklogHandlers } from './backlog.js';
import { createConsentHandlers } from './consents.js';
import { contextMessages, contextText } from './context-pages.js';
import { createChangesHandlers } from './changes.js';
import { createDiagnosticsHandlers } from './diagnostics.js';
import { createFeedHandlers } from './feed.js';
import { createHistoryHandlers } from './history.js';
import { createJournalHandlers } from './journal.js';
import { createMemoryHandlers } from './memory.js';
import { hostInfo, hostShutdown } from './host.js';
import { mailMarkRead } from './mail.js';
import { createPtyHandlers } from './pty.js';
import { createCustomProviderHandlers } from './custom-providers.js';
import {
  createProvidersCheck,
  createProvidersClearKey,
  createProvidersList,
  createProvidersRefreshLimits,
  createProvidersSetKey,
} from './providers.js';
import {
  createPlanHandlers,
  createRoomsArchive,
  roomsAddMember,
  roomsCreate,
  roomsDelete,
  roomsRename,
  roomsReopen,
  roomsResolveProposal,
  plansResumeAutonomous,
  roomsSend,
  roomsSetLead,
  roomsSetOwner,
} from './rooms.js';
import { createRolesList } from './roles.js';
import { createRecipesList } from './recipes.js';
import { createCachedCatalog } from './role-catalog-cache.js';
import { createSessionHandlers } from './sessions.js';
import { settingsGet, settingsSet } from './settings.js';
import { createWakeHandlers } from './wake.js';
import { createWorktreesHandlers } from './worktrees.js';
import { worksCreate, createWorksDelete, worksList, worksRename, worksSetStatus } from './works.js';

export interface MethodDeps {
  works: WorksService;
  activity: ActivityService;
  pty: PtyManager;
  sessions: SessionsService;
  wake: WakeService;
  worktrees: WorktreesService;
  /** Лента вида «Chat» (`feed.*`); без неё методов ленты у хоста нет. */
  feed?: FeedService;
  /**
   * Кэшированный каталог ролей хоста для `roles.list` и `recipes.list`. Хост отдаёт его же инструментам агентов
   * (`list_roles`), чтобы кэш был один; без него методы заводят свой.
   */
  roleCatalog?: ReturnType<typeof createCachedCatalog>;
  /** Live project backlog subscriptions; manual methods also work without this service. */
  backlog?: BacklogService;
  /** One host authority for durable plan delivery and export retries. */
  planEffects?: PlanEffectsService;
  autonomousEngine?: Pick<import('../rooms/autonomous-engine.js').AutonomousEngine, 'cancel'>;
  /** Selected-checkout derivative history; shared publication stays explicit. */
  history?: HistoryService;
  /** Первое чтение работ хостом и сбор прерванных (их ждут WORKS_GATED_*); без него — сразу. */
  worksReady?: Promise<void>;
  /** Версии CLI из пробы на старте хоста (`providers.list`); без них у провайдеров `version: null`. */
  providerVersions?: ProviderVersions;
  /** Каталог моделей Codex из пробы CLI: `providers.list` просит его обновиться, когда он устарел; без него — не просит. */
  codexCatalog?: CodexCatalog;
  /** Лимиты подписок (`providers.list`); без них у провайдеров `limits: null`. */
  limits?: LimitsService;
  /** Сжатие контекста по клику человека (спека 2026-10-15); без него методов сжатия у хоста нет. */
  compaction?: CompactionService;
  /** Явная проверка ключа Z.ai (`providers.check`); без неё метода нет, а в `providers.list` нет `check`. */
  glmCheck?: GlmCheckService;
  /** Проверка конечной точки своего провайдера (спека 5.5); без неё методы своих провайдеров не проверяют. */
  customCheck?: CustomCheckService;
  /**
   * Служба входа в аккаунты подписки (спека подписок 5.5): `providers.list` берёт у неё `signedIn` и `signingIn`, шесть
   * методов входа (`providers.authStatus`, `signIn`, …) — её команды. Без неё `signedIn: null`, `signingIn: false`, а
   * методов входа у хоста нет.
   */
  auth?: AuthService;
  /** Канал агента к браузеру окна (спека браузера 3.7): ответ окна `browser.agentResult`; без него метода нет. */
  browserAgent?: Pick<BrowserEndpoint, 'resolve'>;
  /** Состояние хоста для `host.diagnostics`; методы диагностики регистрируются, только когда заданы и он, и `profiler`. */
  health?: HealthService;
  /** CPU-профиль по запросу (`host.profile.*`); без него (и без `health`) методов диагностики у хоста нет. */
  profiler?: Profiler;
  /** Журнал хоста для записей задержек, которые пишут не обработчики с `request.host.log` (`pty.clientDropped` в потоке PTY). */
  log?: Log;
  /** Общий отправитель хоста (`createSender`): окно (`pty.send`) и помощник делят «свой Enter в полёте»; без него `pty.*` заводит свой. */
  send?: (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;
  /** Помощник на острове (спека 2026-10-14); без него методов `assistant.*` у хоста нет. */
  assistant?: AssistantService;
  /** Канал Telegram (план B); без него методов `telegram.*` у хоста нет. */
  telegram?: TelegramService;
  /** Согласия человека на папку (спека 2026-10-21, 4.4); без них методов `consents.*` и `trust.*` у хоста нет. */
  consents?: ConsentsService;
}

/** Сколько знаков сообщения окна доходит агенту. */
const AGENT_MESSAGE_MAX = 2000;

/** Код окна, которого хост не знает (окно новее), — `unsupported`; текст окна остаётся. */
const knownAgentCode = (code: string): BrowserAgentErrorCode =>
  (BROWSER_AGENT_ERROR_CODES as readonly string[]).includes(code) ? (code as BrowserAgentErrorCode) : 'unsupported';

/**
 * Методы, которым нужен снимок работ хоста (раунд lane-r4, п. 4): сокет слушает раньше первого
 * чтения работ, и в этот промежуток они видели бы недочитанный снимок — пустой список, not_found
 * по сессии, ещё не сверенную живость или пустой список прерванных. Ждут `worksReady`.
 * Не ждут: pty.input/pty.resize (порядок ввода; до чтения PTY всё равно нет), чтение и запись
 * карт с диска (works.create/delete/rename/setStatus, sessions.rename, rooms.create/addMember/rename/setLead/delete/send,
 * rooms.archive/reopen, mail.*, worktrees.*), host.*, providers.*, settings.*, wake.* — снимка работ они не читают.
 */
export const WORKS_GATED_METHODS = [
  'rooms.resolveProposal',
  'rooms.setMode',
  'plans.update',
  'plans.submit',
  'plans.verify',
  'plans.cancel',
  'plans.retryEffects',
  'works.list',
  'decisions.list',
  'sessions.create',
  'sessions.resume',
  'sessions.stop',
  'sessions.close',
  'sessions.delete',
  'sessions.interrupted',
  'sessions.setMode',
  'sessions.setEffort',
  'sessions.compact',
  'sessions.cancelCompact',
  'sessions.setModel',
  'sessions.resumeInterrupted',
  'pty.attach',
  'pty.detach',
  'pty.send',
  'feed.snapshot',
  'feed.progress',
  'feed.subscribe',
  'feed.unsubscribe',
  'feed.decide',
  'feed.interrupt',
] as const satisfies readonly MethodName[];

/** Уведомления того же рода: activity.seen сверяет сессию со снимком работ. */
export const WORKS_GATED_NOTIFICATIONS = ['activity.seen'] as const satisfies readonly NotificationName[];

export interface HostHandlers {
  methods: Partial<Record<MethodName, AnyHandler>>;
  notifications: Partial<Record<NotificationName, AnyNotificationHandler>>;
  /** Счётчики для строки состояния хоста: таблица подписок PTY живёт в замыкании `createPtyHandlers`. */
  counters: { ptyAttached(): number };
  /** Клиент отключился: снимает его с подписок потока терминалов. */
  dropClient(client: Client): void;
}

/**
 * Реестр обработчиков хоста: методы и уведомления вместе, одной фабрикой.
 * `pty.attach`/`pty.detach` (запрос-ответ) и `pty.input`/`pty.resize`
 * (уведомления) делят одну таблицу подписчиков потока — заводить
 * `createPtyHandlers` дважды означало бы завести и две независимые таблицы,
 * из которых вывод дойдёт только до половины подписавшихся клиентов.
 *
 * Каждый следующий кусок хоста добавляет сюда свою группу методов одной
 * строкой, не трогая соседние: реестр — фабрика, а не статический объект,
 * потому что части методов (`works.list`, `pty.*`) нужен доступ к сервисам
 * хоста, которые заводятся заново на каждый `startHost`.
 */
export function createHostHandlers(deps: MethodDeps): HostHandlers {
  const pty = createPtyHandlers(deps);
  const sessions = createSessionHandlers(deps);
  const wake = createWakeHandlers(deps);
  const worktrees = createWorktreesHandlers(deps);
  const changes = createChangesHandlers(deps);
  const capabilities = createCapabilitiesHandlers();
  // Один кэш на `roles.list` и `recipes.list`: оба просят один и тот же каталог по одному `cwd`. Хост делит его и с
  // инструментами агентов, поэтому берёт готовый из `deps`.
  const roleCatalog = deps.roleCatalog ?? createCachedCatalog();

  const compaction = deps.compaction === undefined ? null : createCompactionMethods(deps.compaction);

  const methods: Partial<Record<MethodName, AnyHandler>> = {
    ...createBacklogHandlers(deps.backlog),
    ...createJournalHandlers(deps.works),
    ...createMemoryHandlers(),
    ...createHistoryHandlers(),
    ...(deps.planEffects ? createPlanHandlers(deps.planEffects, deps.autonomousEngine) : {}),
    'plans.resumeAutonomous': plansResumeAutonomous as AnyHandler,
    ...(deps.assistant === undefined ? {} : createAssistantHandlers(deps.assistant)),
    ...(deps.telegram === undefined ? {} : createTelegramHandlers(deps.telegram)),
    // Снимка работ не читают: не в `WORKS_GATED_METHODS`, окно спрашивает согласие ещё до создания работы.
    ...(deps.consents === undefined ? {} : createConsentHandlers({ consents: deps.consents, home: parleyHome() })),
    'host.info': hostInfo as AnyHandler,
    'host.shutdown': hostShutdown as AnyHandler,
    'works.list': worksList(deps.works) as AnyHandler,
    // Читают карту с диска, снимка работ не ждут: не в `WORKS_GATED_METHODS`.
    'context.messages': contextMessages as AnyHandler,
    'context.text': contextText as AnyHandler,
    'works.create': worksCreate as AnyHandler,
    'works.delete': createWorksDelete(deps.history) as AnyHandler,
    'works.rename': worksRename as AnyHandler,
    'works.setStatus': worksSetStatus as AnyHandler,
    'providers.list': createProvidersList(deps.providerVersions, deps.limits, deps.glmCheck, deps.codexCatalog, deps.customCheck, deps.auth) as AnyHandler,
    'providers.setKey': createProvidersSetKey(deps.limits, deps.glmCheck, deps.customCheck) as AnyHandler,
    'providers.clearKey': createProvidersClearKey(deps.limits, deps.glmCheck, deps.customCheck) as AnyHandler,
    ...(deps.limits === undefined
      ? {}
      : { 'providers.refreshLimits': createProvidersRefreshLimits(deps.limits, deps.providerVersions, deps.auth) as AnyHandler }),
    ...(deps.glmCheck === undefined && deps.customCheck === undefined
      ? {}
      : { 'providers.check': createProvidersCheck(deps.providerVersions, deps.glmCheck, deps.customCheck) as AnyHandler }),
    ...createCustomProviderHandlers(deps.customCheck, deps.auth, (id) => deps.pty.list().some((handle) => handle.provider === id)),
    ...(deps.auth === undefined ? {} : createAuthHandlers(deps.auth)),
    'settings.get': settingsGet as AnyHandler,
    'settings.set': (async (params, request) => {
      const result = await settingsSet(params, request);
      // Настройка записана: канал Telegram включается, выключается или меняет поводы.
      try {
        deps.telegram?.configChanged(result.config);
      } catch (error) {
        // Настройка уже записана: сбой канала не должен превращать её в ошибку метода.
        request.host.log.warn('telegram: configChanged failed', { error: String(error) });
      }
      return result;
    }) as typeof settingsSet as AnyHandler,
    'pty.attach': pty.ptyAttach as AnyHandler,
    'pty.detach': pty.ptyDetach as AnyHandler,
    'pty.send': pty.ptySend as AnyHandler,
    'roles.list': createRolesList(roleCatalog, deps.works) as AnyHandler,
    'recipes.list': createRecipesList(roleCatalog) as AnyHandler,
    'sessions.create': sessions.sessionsCreate as AnyHandler,
    'sessions.resume': sessions.sessionsResume as AnyHandler,
    'sessions.stop': sessions.sessionsStop as AnyHandler,
    'sessions.delete': sessions.sessionsDelete as AnyHandler,
    'sessions.close': sessions.sessionsClose as AnyHandler,
    'sessions.rename': sessions.sessionsRename as AnyHandler,
    'sessions.interrupted': sessions.sessionsInterrupted as AnyHandler,
    'sessions.setMode': sessions.sessionsSetMode as AnyHandler,
    'sessions.setEffort': sessions.sessionsSetEffort as AnyHandler,
    ...(compaction === null
      ? {}
      : {
          'sessions.compact': compaction.compact as AnyHandler,
          'sessions.cancelCompact': compaction.cancel as AnyHandler,
        }),
    'sessions.setModel': sessions.sessionsSetModel as AnyHandler,
    'sessions.resumeInterrupted': sessions.sessionsResumeInterrupted as AnyHandler,
    'wake.pause': wake.wakePause as AnyHandler,
    'wake.resume': wake.wakeResume as AnyHandler,
    'wake.state': wake.wakeState as AnyHandler,
    'rooms.create': roomsCreate as AnyHandler,
    'rooms.addMember': roomsAddMember as AnyHandler,
    'rooms.rename': roomsRename as AnyHandler,
    'rooms.setLead': roomsSetLead as AnyHandler,
    'rooms.setOwner': roomsSetOwner as AnyHandler,
    'rooms.delete': roomsDelete as AnyHandler,
    'rooms.archive': createRoomsArchive(deps.sessions) as AnyHandler,
    'rooms.reopen': roomsReopen as AnyHandler,
    'rooms.usage': createRoomsUsage(deps.works, deps.activity) as AnyHandler,
    'rooms.resolveProposal': (async (params, request) => {
      const result = await roomsResolveProposal(params, request);
      // The decision is committed. Delivery failure retains pending effects and its safe notice.
      await deps.planEffects?.flush(params.projectPath, params.workId).catch(() => undefined);
      return result;
    }) as typeof roomsResolveProposal as AnyHandler,
    'rooms.send': roomsSend as AnyHandler,
    'worktrees.available': worktrees.worktreesAvailable as AnyHandler,
    'worktrees.diff': worktrees.worktreesDiff as AnyHandler,
    'worktrees.commit': worktrees.worktreesCommit as AnyHandler,
    'worktrees.merge': worktrees.worktreesMerge as AnyHandler,
    'worktrees.discard': worktrees.worktreesDiscard as AnyHandler,
    'worktrees.mergeCheck': worktrees.worktreesMergeCheck as AnyHandler,
    'changes.project': changes.changesProject as AnyHandler,
    'changes.commitProject': changes.changesCommitProject as AnyHandler,
    'mail.markRead': mailMarkRead as AnyHandler,
    'capabilities.list': createCapabilitiesList() as AnyHandler,
    'capabilities.get': capabilities.capabilitiesGet as AnyHandler,
    'capabilities.refresh': capabilities.capabilitiesRefresh as AnyHandler,
    'capabilities.skills.share': capabilities.capabilitiesSkillsShare as AnyHandler,
    'capabilities.skills.unshare': capabilities.capabilitiesSkillsUnshare as AnyHandler,
    'capabilities.mcp.add': capabilities.capabilitiesMcpAdd as AnyHandler,
    'capabilities.mcp.remove': capabilities.capabilitiesMcpRemove as AnyHandler,
    'capabilities.mcp.check': capabilities.capabilitiesMcpCheck as AnyHandler,
    'capabilities.plugins.available': capabilities.capabilitiesPluginsAvailable as AnyHandler,
    'capabilities.plugins.details': capabilities.capabilitiesPluginsDetails as AnyHandler,
    'capabilities.plugins.install': capabilities.capabilitiesPluginsInstall as AnyHandler,
    'capabilities.plugins.uninstall': capabilities.capabilitiesPluginsUninstall as AnyHandler,
    'capabilities.plugins.enable': capabilities.capabilitiesPluginsEnable as AnyHandler,
    'capabilities.plugins.disable': capabilities.capabilitiesPluginsDisable as AnyHandler,
    'capabilities.plugins.addMarketplace': capabilities.capabilitiesPluginsAddMarketplace as AnyHandler,
  };
  if (deps.feed !== undefined) {
    const feed = createFeedHandlers({ feed: deps.feed });
    methods['feed.snapshot'] = feed.feedSnapshot as AnyHandler;
    methods['feed.progress'] = feed.feedProgress as AnyHandler;
    methods['feed.subscribe'] = feed.feedSubscribe as AnyHandler;
    methods['feed.unsubscribe'] = feed.feedUnsubscribe as AnyHandler;
    methods['feed.decide'] = feed.feedDecide as AnyHandler;
    methods['feed.interrupt'] = feed.feedInterrupt as AnyHandler;
  }
  if (deps.browserAgent !== undefined) {
    const endpoint = deps.browserAgent;
    methods['browser.agentResult'] = (async (params: Params<'browser.agentResult'>, request: RequestInfo) => {
      const result: BrowserAgentResult = params.ok
        ? { ok: true, result: params.result }
        : { ok: false, error: { code: knownAgentCode(params.error.code), message: params.error.message.slice(0, AGENT_MESSAGE_MAX) } };
      return { accepted: endpoint.resolve(params.opId, result, request.client) };
    }) as AnyHandler;
  }
  if (deps.health !== undefined && deps.profiler !== undefined) {
    // Не в `WORKS_GATED_METHODS`: снимка работ диагностика не читает и должна отвечать, пока хост ещё стартует.
    const diagnostics = createDiagnosticsHandlers({
      health: deps.health,
      profiler: deps.profiler,
      pty: deps.pty,
      activity: deps.activity,
      isAttached: pty.isAttached,
    });
    methods['host.diagnostics'] = diagnostics.hostDiagnostics as AnyHandler;
    methods['host.profile.start'] = diagnostics.profileStart as AnyHandler;
    methods['host.profile.status'] = diagnostics.profileStatus as AnyHandler;
  }
  const notifications: Partial<Record<NotificationName, AnyNotificationHandler>> = {
    'pty.input': pty.ptyInput as AnyNotificationHandler,
    'pty.resize': pty.ptyResize as AnyNotificationHandler,
    'activity.seen': pty.activitySeen as AnyNotificationHandler,
  };

  const ready = deps.worksReady;
  if (ready !== undefined) {
    for (const name of WORKS_GATED_METHODS) {
      const handler = methods[name];
      if (handler !== undefined) methods[name] = async (params, request) => ready.then(() => handler(params, request));
    }
    for (const name of WORKS_GATED_NOTIFICATIONS) {
      const handler = notifications[name];
      // Отказ ворот (lane-r5) уведомлению ответить нечем — оно просто не исполняется. Сбой самого
      // обработчика после ворот уже не ловит try/catch сервера: без catch он стал бы необработанным
      // отказом промиса и уронил хост.
      if (handler !== undefined) {
        notifications[name] = (params, request) => {
          ready
            .then(() => handler(params, request), () => undefined)
            .catch((error: unknown) => {
              request.host.log.warn('обработчик уведомления упал', { method: name, error: String(error) });
            });
        };
      }
    }
  }

  return { methods, notifications, counters: { ptyAttached: pty.attachedCount }, dropClient: pty.dropClient };
}
