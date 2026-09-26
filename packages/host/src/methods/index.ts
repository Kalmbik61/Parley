import type { MethodName, NotificationName } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { hostInfo, hostShutdown } from './host.js';
import { createPtyHandlers } from './pty.js';
import { providersList } from './providers.js';
import { settingsGet, settingsSet } from './settings.js';
import { worksCreate, worksDelete, worksList } from './works.js';

export interface MethodDeps {
  works: WorksService;
  activity: ActivityService;
  pty: PtyManager;
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

  return {
    methods: {
      'host.info': hostInfo as AnyHandler,
      'host.shutdown': hostShutdown as AnyHandler,
      'works.list': worksList(deps.works) as AnyHandler,
      'works.create': worksCreate as AnyHandler,
      'works.delete': worksDelete as AnyHandler,
      'providers.list': providersList as AnyHandler,
      'settings.get': settingsGet as AnyHandler,
      'settings.set': settingsSet as AnyHandler,
      'pty.attach': pty.ptyAttach as AnyHandler,
      'pty.detach': pty.ptyDetach as AnyHandler,
    },
    notifications: {
      'pty.input': pty.ptyInput as AnyNotificationHandler,
      'pty.resize': pty.ptyResize as AnyNotificationHandler,
    },
  };
}
