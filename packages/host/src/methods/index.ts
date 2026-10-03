import type { MethodName, NotificationName } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';
import type { LimitsService } from '../limits/limits-service.js';
import type { ProviderVersions } from '../providers/versions.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';
import { createCapabilitiesHandlers, createCapabilitiesList } from './capabilities.js';
import { createChangesHandlers } from './changes.js';
import { createFeedHandlers } from './feed.js';
import { hostInfo, hostShutdown } from './host.js';
import { mailMarkRead } from './mail.js';
import { createPtyHandlers } from './pty.js';
import { createProvidersList } from './providers.js';
import { roomsAddMember, roomsCreate, roomsResolveProposal, roomsSend } from './rooms.js';
import { createRolesList } from './roles.js';
import { createSessionHandlers } from './sessions.js';
import { settingsGet, settingsSet } from './settings.js';
import { createWakeHandlers } from './wake.js';
import { createWorktreesHandlers } from './worktrees.js';
import { worksCreate, worksDelete, worksList, worksRename, worksSetStatus } from './works.js';

export interface MethodDeps {
  works: WorksService;
  activity: ActivityService;
  pty: PtyManager;
  sessions: SessionsService;
  wake: WakeService;
  worktrees: WorktreesService;
  /** Лента вида «Chat» (`feed.*`); без неё методов ленты у хоста нет. */
  feed?: FeedService;
  /** Первое чтение работ хостом и сбор прерванных (их ждут WORKS_GATED_*); без него — сразу. */
  worksReady?: Promise<void>;
  /** Версии CLI из пробы на старте хоста (`providers.list`); без них у провайдеров `version: null`. */
  providerVersions?: ProviderVersions;
  /** Лимиты подписок (`providers.list`); без них у провайдеров `limits: null`. */
  limits?: LimitsService;
}

/**
 * Методы, которым нужен снимок работ хоста (раунд lane-r4, п. 4): сокет слушает раньше первого
 * чтения работ, и в этот промежуток они видели бы недочитанный снимок — пустой список, not_found
 * по сессии, ещё не сверенную живость или пустой список прерванных. Ждут `worksReady`.
 * Не ждут: pty.input/pty.resize (порядок ввода; до чтения PTY всё равно нет), чтение и запись
 * карт с диска (works.create/delete/rename/setStatus, rooms.*, mail.*, worktrees.*), host.*,
 * providers.*, settings.*, wake.* — снимка работ они не читают.
 */
export const WORKS_GATED_METHODS = [
  'works.list',
  'sessions.create',
  'sessions.resume',
  'sessions.stop',
  'sessions.close',
  'sessions.delete',
  'sessions.interrupted',
  'sessions.setMode',
  'sessions.resumeInterrupted',
  'pty.attach',
  'pty.detach',
  'pty.send',
  'feed.snapshot',
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

  const methods: Partial<Record<MethodName, AnyHandler>> = {
    'host.info': hostInfo as AnyHandler,
    'host.shutdown': hostShutdown as AnyHandler,
    'works.list': worksList(deps.works) as AnyHandler,
    'works.create': worksCreate as AnyHandler,
    'works.delete': worksDelete as AnyHandler,
    'works.rename': worksRename as AnyHandler,
    'works.setStatus': worksSetStatus as AnyHandler,
    'providers.list': createProvidersList(deps.providerVersions, deps.limits) as AnyHandler,
    'settings.get': settingsGet as AnyHandler,
    'settings.set': settingsSet as AnyHandler,
    'pty.attach': pty.ptyAttach as AnyHandler,
    'pty.detach': pty.ptyDetach as AnyHandler,
    'pty.send': pty.ptySend as AnyHandler,
    'roles.list': createRolesList() as AnyHandler,
    'sessions.create': sessions.sessionsCreate as AnyHandler,
    'sessions.resume': sessions.sessionsResume as AnyHandler,
    'sessions.stop': sessions.sessionsStop as AnyHandler,
    'sessions.delete': sessions.sessionsDelete as AnyHandler,
    'sessions.close': sessions.sessionsClose as AnyHandler,
    'sessions.interrupted': sessions.sessionsInterrupted as AnyHandler,
    'sessions.setMode': sessions.sessionsSetMode as AnyHandler,
    'sessions.resumeInterrupted': sessions.sessionsResumeInterrupted as AnyHandler,
    'wake.pause': wake.wakePause as AnyHandler,
    'wake.resume': wake.wakeResume as AnyHandler,
    'wake.state': wake.wakeState as AnyHandler,
    'rooms.create': roomsCreate as AnyHandler,
    'rooms.addMember': roomsAddMember as AnyHandler,
    'rooms.resolveProposal': roomsResolveProposal as AnyHandler,
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
    'capabilities.mcp.add': capabilities.capabilitiesMcpAdd as AnyHandler,
    'capabilities.mcp.remove': capabilities.capabilitiesMcpRemove as AnyHandler,
    'capabilities.mcp.check': capabilities.capabilitiesMcpCheck as AnyHandler,
  };
  if (deps.feed !== undefined) {
    const feed = createFeedHandlers({ feed: deps.feed });
    methods['feed.snapshot'] = feed.feedSnapshot as AnyHandler;
    methods['feed.subscribe'] = feed.feedSubscribe as AnyHandler;
    methods['feed.unsubscribe'] = feed.feedUnsubscribe as AnyHandler;
    methods['feed.decide'] = feed.feedDecide as AnyHandler;
    methods['feed.interrupt'] = feed.feedInterrupt as AnyHandler;
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

  return { methods, notifications };
}
