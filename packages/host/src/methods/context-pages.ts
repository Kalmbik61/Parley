import {
  PageError,
  WINDOW_TEXT_MAX,
  clampPageBytes,
  letterById,
  messagePage,
  parseCursor,
  readMap,
  shrinkText,
  storeLetterReader,
  textPage,
  viewBytes,
  viewMap,
} from '@parley/core';
import type { Message, WorkMap } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

/**
 * Страницы переписки для окна (P35). Письма читаются из базы, а не из снимка сервиса: страница нужна ровно тогда, когда
 * окно листает историю, и письмо, дописанное за последнюю рассылку, не должно из неё выпадать. Курсор называет номер
 * письма, поэтому расхождение снимка окна и диска ничего не пропускает и не повторяет. Карта целиком не читается
 * (спека хранилища 6.2): комнату проверяет `viewMap` без копии, страницу и текст письма отдают запросы.
 */
const goneWork = (workId: string): HostError => new HostError('not_found', `workspace ${workId} does not exist`);

async function mapOf(projectPath: string, workId: string): Promise<WorkMap> {
  const map = await readMap(projectPath, workId).catch(() => null);
  if (map === null) throw goneWork(workId);
  return map;
}

/** Ошибка запроса страницы — `bad_request` с кодом причины в `data.reason`. */
function badPage(error: unknown): never {
  if (error instanceof PageError) throw new HostError('bad_request', error.message, { reason: error.code });
  throw error;
}

export const contextMessages: Handler<'context.messages'> = async (params) => {
  const { projectPath, workId, roomId } = params;
  let entered = false;
  try {
    return viewMap(projectPath, workId, (map) => {
      entered = true;
      if (roomId !== null && !map.rooms.some((room) => room.id === roomId)) {
        throw new HostError('not_found', `room ${roomId} does not exist`);
      }
      return messagePage(
        map,
        { roomId, view: (message) => message, cursor: parseCursor(params.cursor), maxBytes: clampPageBytes(params.maxBytes) },
        storeLetterReader(projectPath, workId),
      );
    });
  } catch (error) {
    // Карта не открылась (работы нет, битая) — `not_found`, как у прежнего чтения; всё, что бросил разбор страницы, — по смыслу.
    if (!entered) throw goneWork(workId);
    return badPage(error);
  }
};

/**
 * Письмо по id (спека rooms.mail 6.9): запросом по номеру, карта целиком не читается. Текст ужат до `WINDOW_TEXT_MAX`, как
 * у письма в событии `rooms.mail`, а у сокращённого назван полный размер (`textBytes`). Письма с таким id в работе нет —
 * `null`, а не отказ: окно цитирует по id, который мог уйти вместе с комнатой.
 */
export const contextLetter: Handler<'context.letter'> = async ({ projectPath, workId, id }) => {
  let message: Message | undefined;
  try {
    message = letterById(projectPath, workId, id);
  } catch {
    throw goneWork(workId);
  }
  if (message === undefined) return { message: null };
  return { message: viewBytes(message) > WINDOW_TEXT_MAX ? shrinkText(message, WINDOW_TEXT_MAX) : message };
};

export const contextText: Handler<'context.text'> = async (params) => {
  const { ref } = params;
  let text: string;
  if (ref.kind === 'message') {
    // Письмо — запросом по номеру: карта целиком для него не нужна (спека хранилища 6.2).
    let message: Message | undefined;
    try {
      message = letterById(params.projectPath, params.workId, ref.id);
    } catch {
      throw goneWork(params.workId);
    }
    if (message === undefined) throw new HostError('not_found', `message ${ref.id} does not exist`);
    text = message.text;
  } else if (ref.kind === 'goal') {
    text = (await mapOf(params.projectPath, params.workId)).work.goal;
  } else {
    const map = await mapOf(params.projectPath, params.workId);
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
