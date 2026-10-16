import {
  JOURNAL_SCHEMA_VERSION,
  PAGE_MAX_ITEMS,
  PageError,
  clampPageBytes,
  findMessageWithin,
  journalRoomPage,
  messagePage,
  parseCursor,
  readMap,
  readMapLazy,
  textPage,
  workSchemaVersion,
} from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

/**
 * Страницы переписки для окна (P35). Карта читается с диска, а не из снимка сервиса: страница нужна ровно тогда,
 * когда окно листает историю, и письмо, дописанное за последнюю рассылку, не должно из неё выпадать. Курсор называет
 * номер письма, поэтому расхождение снимка окна и диска ничего не пропускает и не повторяет.
 */
async function mapOf(projectPath: string, workId: string, whole = true): Promise<WorkMap> {
  const map = await (whole ? readMap : readMapLazy)(projectPath, workId).catch(() => null);
  if (map === null) throw new HostError('not_found', `workspace ${workId} does not exist`);
  return map;
}

/** Сколько байт журналов самое большее просматривает поиск письма по id без имени комнаты (`m-NN`): с хвоста, по всем журналам вместе. */
export const ID_SCAN_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Письмо по id на карте-журнале: ищется в журналах по одному, сначала в том, чьё имя стоит в id (`m-r01-5`, `m-d-3`),
 * с хвоста и без разбора чужих строк. Собирать все журналы ради одного письма не нужно. Письма прежнего вида (`m-07`)
 * имени комнаты в id не несут — тогда журналы идут в порядке индекса, а просмотр ограничен `ID_SCAN_BUDGET_BYTES` на все
 * журналы вместе: `exhausted` — письма не нашли, а непросмотренный хвост остался.
 */
async function journalMessage(
  projectPath: string,
  workId: string,
  map: WorkMap,
  id: string,
): Promise<{ text?: string; exhausted: boolean }> {
  const keys: Array<string | null> = [null, ...map.rooms.map((room) => room.id)];
  const named = (key: string | null): boolean => id.startsWith(key === null ? 'm-d-' : `m-${key.replaceAll('-', '')}-`);
  let left = ID_SCAN_BUDGET_BYTES;
  for (const key of [...keys.filter(named), ...keys.filter((candidate) => !named(candidate))]) {
    const found = await findMessageWithin(projectPath, workId, key, id, left);
    if (found.letter !== undefined) return { text: found.letter.text, exhausted: false };
    left -= found.scanned;
    if (found.truncated || left <= 0) return { exhausted: true };
  }
  return { exhausted: false };
}

/** Ошибка запроса страницы — `bad_request` с кодом причины в `data.reason`. */
function badPage(error: unknown): never {
  if (error instanceof PageError) throw new HostError('bad_request', error.message, { reason: error.code });
  throw error;
}

export const contextMessages: Handler<'context.messages'> = async (params) => {
  // Комнаты и участники — из индекса; письма карты-журнала читаются страницей журнала этой комнаты, а не сборкой всех.
  const map = await mapOf(params.projectPath, params.workId, false);
  if (params.roomId !== null && !map.rooms.some((room) => room.id === params.roomId)) {
    throw new HostError('not_found', `room ${params.roomId} does not exist`);
  }
  try {
    const maxBytes = clampPageBytes(params.maxBytes);
    const cursor = parseCursor(params.cursor);
    if ((await workSchemaVersion(params.projectPath, params.workId)) === JOURNAL_SCHEMA_VERSION) {
      // Курсор журнала — номер строки журнала, а не `m-NN`; `readBy` не вычисляется (курсоры не читаются), как на странице MCP.
      return await journalRoomPage(params, params.roomId, { cursor, maxBytes, maxItems: PAGE_MAX_ITEMS, view: (message) => message });
    }
    return messagePage(await mapOf(params.projectPath, params.workId), {
      roomId: params.roomId,
      view: (message) => message,
      cursor,
      maxBytes,
    });
  } catch (error) {
    return badPage(error);
  }
};

export const contextText: Handler<'context.text'> = async (params) => {
  // Одно письмо, цель или поле сессии — вопрос ограниченный: журналы писем целиком читает только карта v2.
  const map = await mapOf(params.projectPath, params.workId, false);
  const { ref } = params;
  let text: string;
  if (ref.kind === 'goal') text = map.work.goal;
  else if (ref.kind === 'message') {
    const journal = (await workSchemaVersion(params.projectPath, params.workId)) === JOURNAL_SCHEMA_VERSION;
    const found = journal
      ? await journalMessage(params.projectPath, params.workId, map, ref.id)
      : { text: map.messages.find((candidate) => candidate.id === ref.id)?.text, exhausted: false };
    if (found.text === undefined) {
      throw new HostError(
        'not_found',
        found.exhausted
          ? `message ${ref.id} was not found in the newest ${ID_SCAN_BUDGET_BYTES / (1024 * 1024)} MiB of the journals; older letters were not searched`
          : `message ${ref.id} does not exist`,
      );
    }
    text = found.text;
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
