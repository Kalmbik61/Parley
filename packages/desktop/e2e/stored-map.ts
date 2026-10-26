import { closeWorkDb, readStoredMap, replaceStoredMap, type WindowWorkMap, type WorkMap } from '@parley/core';

/**
 * Карты работ лежат в базе `<PARLEY_HOME>/parley.db`, а не в `map.json` (хранилище на SQLite). E2E читают и подменяют
 * карту теми же функциями ядра, что и хост, но мимо окна: хост — отдельный процесс с тем же домом, WAL-журнал SQLite
 * разводит записи двух процессов, а хост замечает чужую запись сам (`PRAGMA data_version`, порядка 500 мс).
 *
 * Дескриптор базы в ядре один на процесс и выбирается по `parleyHome()`, а тот читает `process.env.PARLEY_HOME`. Поэтому
 * на время вызова переменная ставится в дом теста, а после — возвращается, и дескриптор закрывается: процесс Playwright
 * не держит базу чужого дома между тестами и не зависит от того, что поставили другие спеки.
 */
function inHome<T>(home: string, action: () => T): T {
  const before = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  try {
    return action();
  } finally {
    // Переменная возвращается первой: ошибка закрытия не должна оставить чужой дом в окружении Playwright.
    if (before === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = before;
    closeWorkDb();
  }
}

/**
 * Полная карта работы из базы дома `home` (прошла `normalizeMap`, как при загрузке хостом): письма с отметками
 * прочтения собраны из своих таблиц и лежат в `messages` (`WindowWorkMap`, спека хранилища 6.2). Работы нет — `WorkNotFoundError`.
 */
export function readStoredMapE2E(home: string, projectPath: string, workId: string): WindowWorkMap {
  return inHome(home, () => readStoredMap(projectPath, workId));
}

/**
 * Заменяет строки работы в базе дома `home` произвольной картой, как «чужая запись»: без `normalizeMap`, с подъёмом
 * версии — хост увидит запись и перешлёт окну. Списки заменяются целиком. Работа должна уже существовать
 * (`works.create`): строки с нуля этот вызов не заводит.
 *
 * Письма: в карте есть `messages` (полная карта, как её отдаёт `readStoredMapE2E`, или посев писем) — таблицы писем
 * заменяются целиком, вместе с отметками прочтения. Нет — письма работы остаются как были: тесту, который меняет только
 * состояние (сессии, планы), письма, прочитанные раньше, подменять нечем, и он передаёт `withoutLettersE2E(map)`.
 */
export function replaceStoredMapE2E(home: string, projectPath: string, workId: string, map: WorkMap | WindowWorkMap): void {
  inHome(home, () => replaceStoredMap(projectPath, workId, map));
}

/** Карта без писем: подмена `replaceStoredMapE2E` их не трогает, и письма, которые хост записал после чтения карты, не теряются. */
export function withoutLettersE2E(map: WindowWorkMap): WorkMap {
  const rest: Partial<WindowWorkMap> = { ...map };
  delete rest.messages;
  return rest as WorkMap;
}
