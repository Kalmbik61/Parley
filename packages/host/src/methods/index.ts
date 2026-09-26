import type { MethodName, NotificationName } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import type { WorksService } from '../works/works-service.js';
import { hostInfo, hostShutdown } from './host.js';
import { providersList } from './providers.js';
import { settingsGet, settingsSet } from './settings.js';
import { worksCreate, worksDelete, worksList } from './works.js';

export interface MethodDeps {
  works: WorksService;
  /** Пока без своего метода: `pty.attach`/`pty.input` куска 1.6 позовут `markSeen`. */
  activity: ActivityService;
}

/**
 * Реестр обработчиков запросов. Каждый следующий кусок хоста добавляет сюда
 * свою группу методов одной строкой, не трогая соседние.
 *
 * Реестр — фабрика, а не статический объект: части методов (`works.list`) нужен
 * доступ к сервисам хоста, которые заводятся заново на каждый `startHost` —
 * следующие куски (PTY, сессии) добавят сюда свои зависимости тем же способом.
 */
export function createMethodHandlers(deps: MethodDeps): Partial<Record<MethodName, AnyHandler>> {
  return {
    'host.info': hostInfo as AnyHandler,
    'host.shutdown': hostShutdown as AnyHandler,
    'works.list': worksList(deps.works) as AnyHandler,
    'works.create': worksCreate as AnyHandler,
    'works.delete': worksDelete as AnyHandler,
    'providers.list': providersList as AnyHandler,
    'settings.get': settingsGet as AnyHandler,
    'settings.set': settingsSet as AnyHandler,
  };
}

/** Уведомления пока не завела ни одна группа — появятся вместе с `pty.*` в 1.6. */
export const NOTIFICATION_HANDLERS: Partial<Record<NotificationName, AnyNotificationHandler>> = {};
