import { readMap, updateMap, WorkNotFoundError, workPaths, workSchemaVersion } from './store.js';
import { cancelledPlanLetter, planEffectOwnsLetter } from './plan-effects.js';
import { isRoomArchived } from './rooms.js';
import { addRange, DIRECT_CURSOR_KEY, isRead, mergeByTime, messageSeqs, withCursors } from './journal.js';
import { JOURNAL_SCHEMA_VERSION } from './map.js';
import type { CursorFile, JournalLetter } from './journal.js';
import { HUMAN, type Message, type WorkMap } from './types.js';

/**
 * Адресаты письма: `to`, а у рассылки комнаты (пустой `to`) — все участники,
 * кроме отправителя (спецификация 6.1). Создатель комнаты тоже участник, даже
 * если в `members` его не записали. Человек в адресаты не попадает: он не
 * сессия и читает всё, отметка прочтения ему не нужна. Письма архивной комнаты
 * адресатов не имеют, и с явным `to` тоже: старая лента непрочитанной не считается
 * и сессий не будит (архив комнат, 3.4).
 */
export function recipientsOf(message: Message, map: WorkMap): string[] {
  // Вопрос «кто получает это письмо СЕЙЧАС»: доставка, будильник и непрочитанное. Архивная комната не получает никого.
  if (message.roomId === null) return message.to;
  const room = map.rooms.find((candidate) => candidate.id === message.roomId);
  if (room !== undefined && isRoomArchived(room)) return [];
  return addresseesIn(message, room);
}

/**
 * Вопрос «кто МОГ прочесть это письмо ТОГДА»: адресаты письма без оглядки на архив комнаты. Нужен там, где восстанавливаются
 * отметки прошлого (`readBy` из курсоров при сборке карты-журнала и миграции): отметки поставлены до архивации и остаются
 * историей. Доставку и непрочитанное решает `recipientsOf`, не эта функция.
 */
export function addresseesThen(message: Message, map: WorkMap): string[] {
  if (message.roomId === null) return message.to;
  return addresseesIn(message, map.rooms.find((candidate) => candidate.id === message.roomId));
}

/** Общая часть обоих вопросов: явное `to`, а у рассылки комнаты — её участники без отправителя и человека. */
function addresseesIn(message: Message, room: WorkMap['rooms'][number] | undefined): string[] {
  if (message.to.length > 0) return message.to;
  if (room === undefined) return [];
  const members = new Set([room.creator, ...room.members]);
  members.delete(HUMAN);
  members.delete(message.from);
  return [...members];
}

/** Письмо адресовано сессии, и она его ещё не прочла — отметка у каждого своя. */
export const isUnreadFor = (message: Message, sessionId: string, map: WorkMap): boolean =>
  message.readBy[sessionId] === undefined && !cancelledPlanLetter(map, message) && recipientsOf(message, map).includes(sessionId);

/** Непрочитанные письма сессии в порядке карты. */
export const unreadFor = (map: WorkMap, sessionId: string): Message[] =>
  map.messages.filter((message) => isUnreadFor(message, sessionId, map));

/** Индекс карты v3: всё, кроме писем и решений, которые лежат в журналах. */
export type JournalIndex = Omit<WorkMap, 'messages' | 'decisionExports'>;

/** Письмо журнала по id комнаты и id письма (`findMessage` с путём работы); нет письма — `undefined`. */
export type LetterResolver = (roomId: string, id: string) => Promise<JournalLetter | undefined>;

/**
 * Непрочитанное сессии по журналам (карта v3): письма после её курсора, адресованные ей. `journals` — загруженные
 * письма по комнатам (ключ — id комнаты, прямые — `direct`) в порядке журнала; прочитанным считается письмо, номер
 * строки которого входит в диапазоны `cursors` своего журнала, остальное загруженное — непрочитано (вызывающий грузит
 * хвост журнала с первого разрыва в прочитанном).
 * Исключения те же, что у `unreadFor`: письма архивной комнаты и отменённое письмо плана не в счёт.
 * Результат — по времени письма, при равенстве в порядке ключей `journals`, внутри журнала по `seq` (`mergeByTime`).
 *
 * Письмо-уведомление плана видов `mode` и `completion-returned` проверяется по письму-источнику (`occurrence`), а
 * источник может лежать раньше загруженного хвоста. Отсутствие источника среди загруженных НЕ означает «отменено»:
 * его догружает `resolve` по id. Отменённым письмо считается, только если источника нет и в журнале.
 */
export async function unreadFromJournals(
  index: JournalIndex,
  journals: Readonly<Record<string, readonly JournalLetter[]>>,
  cursors: CursorFile,
  sessionId: string,
  resolve: LetterResolver,
): Promise<JournalLetter[]> {
  const asMessage = (letter: JournalLetter): Message => ({ ...letter, readBy: {} }) as Message;
  const messages = Object.values(journals).flat().map(asMessage);
  const map: WorkMap = { ...index, messages };
  const slices = Object.entries(journals).map(([key, letters]) => {
    return letters.filter((letter) => !isRead(cursors, key, letter.seq));
  });
  for (const slice of slices) {
    for (const letter of slice) {
      const message = asMessage(letter);
      for (const effect of index.planEffects ?? []) {
        if ((effect.kind !== 'mode' && effect.kind !== 'completion-returned') || !planEffectOwnsLetter(effect, message)) continue;
        if (messages.some((row) => row.id === effect.occurrence && row.roomId === effect.roomId)) continue;
        const source = await resolve(effect.roomId, effect.occurrence);
        if (source !== undefined) messages.push(asMessage(source));
      }
    }
  }
  const unread = slices.map((slice) =>
    slice.filter((letter) => {
      const message = asMessage(letter);
      return !cancelledPlanLetter(map, message) && recipientsOf(message, map).includes(sessionId);
    }),
  );
  return mergeByTime(unread);
}

/**
 * Письмо, которое человек видит и ещё не прочёл: прямое письмо ему или сообщение
 * комнаты (человек — участник любой комнаты), не от него самого. То же правило, что
 * `humanUnreadLetters` и `roomUnreadForHuman` окна (`attention/derive.ts`): иначе
 * отметка гасила бы не то, что окно считает непрочитанным.
 */
export const unreadForHuman = (message: Message): boolean =>
  message.from !== HUMAN &&
  message.readBy[HUMAN] === undefined &&
  (message.roomId !== null || message.to.includes(HUMAN));

/**
 * Ставит readBy.human = now письмам, которые человек видит: прямым письмам человеку
 * и сообщениям комнат, не от самого человека. Уже прочитанные и чужие id пропускаются.
 * Возвращает, сколько отметок поставлено. work.updatedAt не сдвигается.
 * Подходящих id нет — 0 без updateMap: карта, индекс и .bak не переписываются.
 * Карты нет — WorkNotFoundError, как у updateMap.
 */
export async function markHumanRead(
  projectPath: string,
  workId: string,
  messageIds: string[],
): Promise<number> {
  const wanted = new Set(messageIds);
  const pending = (map: WorkMap): Message[] =>
    map.messages.filter((message) => wanted.has(message.id) && unreadForHuman(message));

  // Сперва чтение без лока: updateMap пишет индекс, .bak и карту всегда, и повтор
  // пачки окна разослал бы works.changed всем клиентам впустую.
  let current: WorkMap;
  try {
    current = await readMap(projectPath, workId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkNotFoundError(`map ${workPaths(projectPath, workId).map} does not exist — workspace ${workId} does not exist`);
    }
    throw error;
  }
  if (pending(current).length === 0) return 0;

  // Карта-журнал: отметка человека — диапазон `human` с первого письма по самое новое отмеченное письмо каждого журнала.
  // Диапазон поэтому гасит и письма журнала старее отмеченного, которых окно не просило (цена спеки, B3) — это явное
  // «прочёл» человека, в отличие от системной строки (там диапазон из одного письма, `letter-sink.ts`). Отбор повторяется
  // ПОД замком курсоров: пачка окна могла быть отобрана до чужой отметки, и устаревший вызов не должен насчитать уже
  // прочитанное. Диапазон только добавляется (`addRange`), назад ничто не идёт.
  if ((await workSchemaVersion(projectPath, workId)) === JOURNAL_SCHEMA_VERSION) {
    const all = messageSeqs(current.messages);
    const seqs = new Map(current.messages.map((message, at) => [message.id, all[at]!]));
    const candidates = pending(current);
    return withCursors(projectPath, workId, HUMAN, async (file) => {
      const fresh = candidates.filter((message) => !isRead(file, message.roomId ?? DIRECT_CURSOR_KEY, seqs.get(message.id)!));
      const newest = new Map<string, number>();
      for (const message of fresh) {
        const key = message.roomId ?? DIRECT_CURSOR_KEY;
        newest.set(key, Math.max(newest.get(key) ?? 0, seqs.get(message.id)!));
      }
      let changed = false;
      for (const [key, seq] of newest) if (addRange(file, key, 1, seq)) changed = true;
      return { changed, value: fresh.length };
    });
  }

  // Под локом отбираем заново: другой клиент мог отметить часть писем между чтениями.
  let marked = 0;
  await updateMap(
    projectPath,
    workId,
    (map) => {
      const at = new Date().toISOString();
      const fresh = pending(map);
      for (const message of fresh) message.readBy[HUMAN] = at;
      marked = fresh.length;
    },
    { touch: false },
  );
  return marked;
}
