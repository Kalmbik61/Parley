import { readStoredMap, replaceStoredMap, type WorkMap } from '@parley/core';
// `closeWorkDb` из корня ядра не экспортируется (его зовут хост и тесты ядра), а `exports` пакета подпути не открывает:
// берём из собранного `dist` по относительному пути — это тот же модуль, что грузит `@parley/core` (общий дескриптор).
import { closeWorkDb } from '../../core/dist/work/db.js';

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
    closeWorkDb();
    if (before === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = before;
  }
}

/** Карта работы из базы дома `home` (прошла `normalizeMap`, как при загрузке хостом). Работы нет — `WorkNotFoundError`. */
export function readStoredMapE2E(home: string, projectPath: string, workId: string): WorkMap {
  return inHome(home, () => readStoredMap(projectPath, workId));
}

/**
 * Заменяет строки работы в базе дома `home` произвольной картой, как «чужая запись»: без `normalizeMap`, с подъёмом
 * версии — хост увидит запись и перешлёт окну. Списки заменяются целиком. Работа должна уже существовать
 * (`works.create`): строки с нуля этот вызов не заводит.
 */
export function replaceStoredMapE2E(home: string, projectPath: string, workId: string, map: WorkMap): void {
  inHome(home, () => replaceStoredMap(projectPath, workId, map));
}
