import { recipientsOf } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { MailNotice } from './works/works-service.js';

/**
 * Сессии, чьё непрочитанное изменила запись писем (спека rooms.mail 6.7): адресаты новых писем и те, кто отметил прочтение.
 * Подписчики `onMail`, которым важно число непрочитанного (будильник, активность), пересчитывают только их, а не все сессии
 * работы. Адресатов даёт `recipientsOf` по карте работы: список `to`, а у рассылки комнаты — участники без отправителя.
 *
 * Удаление писем, сносы комнат и массовые отметки (`deleted`, `droppedRooms`, `rereadRooms`) в запись только писем не
 * попадают: они идут вместе с записью карты (сессия ушла, комната удалена или возвращена из архива), а та приходит
 * подписчикам и через `onChange`.
 */
export function mailSessions(notice: Pick<MailNotice, 'journal'>, map: WorkMap): Set<string> {
  const sessions = new Set<string>();
  for (const message of notice.journal.added) for (const sessionId of recipientsOf(message, map)) sessions.add(sessionId);
  for (const read of notice.journal.reads) sessions.add(read.reader);
  return sessions;
}
