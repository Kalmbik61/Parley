import type { MethodName, NotificationName } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';
import type { WorktreesService } from '../worktrees/worktrees-service.js';
import { hostInfo, hostShutdown } from './host.js';
import { createPtyHandlers } from './pty.js';
import { providersList } from './providers.js';
import { roomsCreate, roomsSend } from './rooms.js';
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
}

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

  return {
    methods: {
      'host.info': hostInfo as AnyHandler,
      'host.shutdown': hostShutdown as AnyHandler,
      'works.list': worksList(deps.works) as AnyHandler,
      'works.create': worksCreate as AnyHandler,
      'works.delete': worksDelete as AnyHandler,
      'works.rename': worksRename as AnyHandler,
      'works.setStatus': worksSetStatus as AnyHandler,
      'providers.list': providersList as AnyHandler,
      'settings.get': settingsGet as AnyHandler,
      'settings.set': settingsSet as AnyHandler,
      'pty.attach': pty.ptyAttach as AnyHandler,
      'pty.detach': pty.ptyDetach as AnyHandler,
      'sessions.create': sessions.sessionsCreate as AnyHandler,
      'sessions.resume': sessions.sessionsResume as AnyHandler,
      'sessions.stop': sessions.sessionsStop as AnyHandler,
      'sessions.delete': sessions.sessionsDelete as AnyHandler,
      'sessions.close': sessions.sessionsClose as AnyHandler,
      'sessions.interrupted': sessions.sessionsInterrupted as AnyHandler,
      'sessions.resumeInterrupted': sessions.sessionsResumeInterrupted as AnyHandler,
      'wake.pause': wake.wakePause as AnyHandler,
      'wake.resume': wake.wakeResume as AnyHandler,
      'wake.state': wake.wakeState as AnyHandler,
      'rooms.create': roomsCreate as AnyHandler,
      'rooms.send': roomsSend as AnyHandler,
      'worktrees.available': worktrees.worktreesAvailable as AnyHandler,
      'worktrees.diff': worktrees.worktreesDiff as AnyHandler,
      'worktrees.commit': worktrees.worktreesCommit as AnyHandler,
      'worktrees.merge': worktrees.worktreesMerge as AnyHandler,
      'worktrees.discard': worktrees.worktreesDiscard as AnyHandler,
    },
    notifications: {
      'pty.input': pty.ptyInput as AnyNotificationHandler,
      'pty.resize': pty.ptyResize as AnyNotificationHandler,
    },
  };
}
