import type { MethodName, NotificationName } from '@harnas/protocol';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import { hostInfo, hostShutdown } from './host.js';

/**
 * Реестр обработчиков запросов. Каждый следующий кусок хоста добавляет сюда
 * свою группу методов одной строкой, не трогая соседние.
 */
export const METHOD_HANDLERS: Partial<Record<MethodName, AnyHandler>> = {
  'host.info': hostInfo as AnyHandler,
  'host.shutdown': hostShutdown as AnyHandler,
};

/** Уведомления пока не завела ни одна группа — появятся вместе с `pty.*` в 1.6. */
export const NOTIFICATION_HANDLERS: Partial<Record<NotificationName, AnyNotificationHandler>> = {};
