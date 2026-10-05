import {
  PageError,
  clampPageBytes,
  messagePage,
  parseCursor,
  readMap,
  textPage,
} from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

/**
 * Страницы переписки для окна (P35). Карта читается с диска, а не из снимка сервиса: страница нужна ровно тогда,
 * когда окно листает историю, и письмо, дописанное за последнюю рассылку, не должно из неё выпадать. Курсор называет
 * номер письма, поэтому расхождение снимка окна и диска ничего не пропускает и не повторяет.
 */
async function mapOf(projectPath: string, workId: string): Promise<WorkMap> {
  const map = await readMap(projectPath, workId).catch(() => null);
  if (map === null) throw new HostError('not_found', `workspace ${workId} does not exist`);
  return map;
}

/** Ошибка запроса страницы — `bad_request` с кодом причины в `data.reason`. */
function badPage(error: unknown): never {
  if (error instanceof PageError) throw new HostError('bad_request', error.message, { reason: error.code });
  throw error;
}

export const contextMessages: Handler<'context.messages'> = async (params) => {
  const map = await mapOf(params.projectPath, params.workId);
  if (params.roomId !== null && !map.rooms.some((room) => room.id === params.roomId)) {
    throw new HostError('not_found', `room ${params.roomId} does not exist`);
  }
  try {
    return messagePage(map, {
      roomId: params.roomId,
      view: (message) => message,
      cursor: parseCursor(params.cursor),
      maxBytes: clampPageBytes(params.maxBytes),
    });
  } catch (error) {
    return badPage(error);
  }
};

export const contextText: Handler<'context.text'> = async (params) => {
  const map = await mapOf(params.projectPath, params.workId);
  const { ref } = params;
  let text: string;
  if (ref.kind === 'goal') text = map.work.goal;
  else if (ref.kind === 'message') {
    const message = map.messages.find((candidate) => candidate.id === ref.id);
    if (message === undefined) throw new HostError('not_found', `message ${ref.id} does not exist`);
    text = message.text;
  } else {
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) throw new HostError('not_found', `session ${ref.sessionId} does not exist`);
    text = ref.field === 'task' ? session.task : (session.summary ?? '');
  }
  try {
    return textPage(text, params.cursor, clampPageBytes(params.maxBytes));
  } catch (error) {
    return badPage(error);
  }
};
