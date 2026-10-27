import { HUMAN, recipientsOf } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { MailNotice } from './works/works-service.js';

/**
 * Сессии, чьё непрочитанное изменила запись писем (спека rooms.mail 6.7): адресаты новых писем, те, кто отметил прочтение, и
 * участники комнат с `rereadRooms`. Подписчики `onMail`, которым важно число непрочитанного (будильник, активность),
 * пересчитывают только их, а не все сессии работы. Адресатов даёт `recipientsOf` по карте работы: список `to`, а у рассылки
 * комнаты — участники без отправителя.
 *
 * Комнаты с `rereadRooms` — массовая отметка (`reopened`) и письма чужой записи (спека 6.11): отметки поштучно названы не
 * бывают, читателем может оказаться любой участник комнаты, поэтому пересчитываются все её участники.
 *
 * Человек в ответ не входит, как и в `recipientsOf` у рассылки комнаты: он не сессия, подписчикам читать его журнал нечем. Он
 * попадает сюда прямым письмом ему (`to: ['human']`) и своей отметкой прочтения.
 *
 * Удаление писем и снос комнат (`deleted`, `droppedRooms`) в запись только писем не попадают: они идут вместе с записью карты
 * (сессия ушла, комната удалена), а та приходит подписчикам и через `onChange`.
 */
export function mailSessions(notice: Pick<MailNotice, 'journal'>, map: WorkMap): Set<string> {
  const sessions = new Set<string>();
  for (const message of notice.journal.added) for (const sessionId of recipientsOf(message, map)) sessions.add(sessionId);
  for (const read of notice.journal.reads) sessions.add(read.reader);
  for (const roomId of notice.journal.rereadRooms) {
    for (const member of map.rooms.find((room) => room.id === roomId)?.members ?? []) sessions.add(member);
  }
  sessions.delete(HUMAN);
  return sessions;
}
