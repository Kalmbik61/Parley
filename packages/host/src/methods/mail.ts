/**
 * Методы `mail.*`: отметки прочтения писем человеком.
 *
 * «Прочитано» ставит окно по видимости письма (спека 7.2), а не побочным эффектом
 * подключения: окно копит id пачкой и шлёт одним вызовом.
 */

import { markHumanRead } from '@harnas/core';
import type { Handler } from '../context.js';
import { notFoundOnGone, requireWork } from './works.js';

export const mailMarkRead: Handler<'mail.markRead'> = async (params) => {
  // Работы нет — not_found, как у works.rename; работу удалили, пока запись ждала
  // map.lock, — WorkNotFoundError core, тоже not_found. Пустой итог — не ошибка.
  await requireWork(params.projectPath, params.workId);
  const marked = await markHumanRead(params.projectPath, params.workId, params.messageIds).catch(
    notFoundOnGone,
  );
  return { marked };
};
