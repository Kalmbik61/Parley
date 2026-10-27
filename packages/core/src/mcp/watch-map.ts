/** Проба: `null` — условия ещё нет, любое другое значение возвращается вызывающему. */
export type Probe<T> = () => Promise<T | null>;

/**
 * Внешний источник «карта изменилась» (спека хранилища 6.9, этап 1). Хост сам знает о каждой записи карты, и ожидание в
 * его процессе не зависит от тика опроса. Принимает обратный вызов и возвращает отписку: `waitForMap` снимает подписку
 * при любом исходе ожидания. Сигнал должен приходить ПОСЛЕ коммита записи: по каждому сигналу ожидание сначала
 * сверяет личность работы, и сигнал, пришедший раньше записи, видит прежнюю личность и отбрасывается — пробуждение тогда
 * дожидается тика опроса.
 */
export type MapChanges = (onChange: () => void) => () => void;

/**
 * Личность между пробами, как её видит ожидание: `null` — личности нет (работы нет в базе, или сверка не удалась), и
 * проба зовётся, как и раньше. Обычно это `workVersionKey` — версия строки работы.
 */
export type Identity = () => string | null;

/** Сверка, не уронившая ожидание: `identity` ходит в базу и может бросить, а её вызывают из таймера и из чужого сигнала. */
function identityOf(identity: Identity): string | null {
  try {
    return identity();
  } catch {
    return null;
  }
}

/**
 * Ждёт, пока проба по карте не даст результат. Сначала проверяет текущее
 * состояние: условие могло выполниться до вызова.
 *
 * Поводы позвать пробу — тик опроса и внешний сигнал `changes`; файлового наблюдателя нет: карта лежит в базе
 * (спека хранилища 6.9). Опрос идёт всегда, а не только без `changes`: он запасной на случай пропущенного сигнала, и
 * молчаливый вечный `wait_for` хуже лишней сверки версии. Истёк таймаут — `null`, вызывающий отвечает агенту
 * `{state: "running"}`.
 *
 * Повод позвать пробу — не то же, что запись карты: тик опроса приходит, пока карта стоит, а одна запись может дать
 * и сигнал, и тик. Проба разбирает карту целиком, и на каждый повод она слишком дорога (спека хранилища 6.9). Поэтому по
 * любому поводу сначала `identity` — один запрос версии строки, — и проба зовётся, только если личность не та, что при
 * прошлой пробе. Личность берётся ДО пробы: запись, пришедшая посреди неё, оставит другую личность и вызовет пробу
 * ещё раз, а снятая после пробы затёрла бы эту запись. Отсюда условие к пробе: она должна зависеть только от
 * карты. Перемену чего-то другого (флаг остановки, своё состояние) ожидание не заметит, пока карта стоит, —
 * такую перемену будят через `signal`.
 *
 * `signal` — отмена вызова клиентом (агент прервал ход): ждать больше некого, ожидание
 * прекращается сразу и тоже даёт `null` — ответ на отменённый вызов всё равно отбросят.
 */
export async function waitForMap<T>(
  identity: Identity,
  probe: Probe<T>,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
  changes?: MapChanges,
): Promise<T | null> {
  if (signal?.aborted) return null;
  // Личность снимается до первой пробы, а не после: см. выше.
  let probed = identityOf(identity);
  const found = await probe();
  if (found !== null) return found;
  if (signal?.aborted) return null;

  return new Promise<T | null>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;

    const stop = (): void => {
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (done) return;
      stop();
      resolve(null);
    };

    const check = async (): Promise<void> => {
      if (done) return;
      const current = identityOf(identity);
      // Та же личность, что видела прошлая проба, — звать нечего. Одновременные поводы одной записи тоже сходятся
      // здесь: первый запоминает личность до пробы, остальные видят её же.
      if (current !== null && current === probed) return;
      probed = current;
      try {
        const result = await probe();
        if (done || result === null) return;
        stop();
        resolve(result);
      } catch (error) {
        if (done) return;
        stop();
        reject(error as Error);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    const poll = setInterval(() => void check(), pollMs);
    const deadline = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);

    try {
      if (changes !== undefined) unsubscribe = changes(() => void check());
    } catch {
      // Подписка сорвалась — остаётся опрос.
      unsubscribe = undefined;
    }
  });
}
