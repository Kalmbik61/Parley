import {
  listWorkVersions,
  onMapWritten,
  readMap,
  readWorksIndex,
  storedMapBytes,
  workDataVersion,
  workVersion,
} from './store.js';
import type { WindowWorkMap, WorkMap } from './types.js';

/**
 * Карта работы вместе с проектом, в котором она лежит. Карта хранимая, без писем (спека хранилища 6.2): письма читаются из
 * таблиц (`letter-store.ts`). Для окна — `WindowWorkEntry`.
 */
export interface WorkEntry {
  projectPath: string;
  map: WorkMap;
  /**
   * Сколько байт строк базы разобрано, когда карту собрали заново (`storedMapBytes`), — для счётчиков хоста, без повторного
   * чтения: карта из кэша списка приходит с 0, и счётчик не врёт про «прочитанное».
   */
  bytes?: number;
  /**
   * Версия строки работы в базе, под которой взята карта (спека хранилища 6.9): та же версия — та же карта. Хост по ней
   * узнаёт, что работа не менялась, и не пересобирает её снимок для окна (план 4, задача 5). Номера нет, если запись
   * успела вклиниться между чтением версии и карты, — тогда работу надо считать новой.
   */
  version?: number;
}

/**
 * Работа в снимке для окна и страниц (протокол `WorksSnapshot`): карта с письмами — сжатая `compactWorkMap` у окна с
 * `compact-works` или полная у прежнего окна. Сборка снимка — хост (`works-service.ts`); код окна работает с этим видом.
 */
export interface WindowWorkEntry {
  projectPath: string;
  map: WindowWorkMap;
  /**
   * Версия строки работы в базе, под которой собран этот снимок (`WorkEntry.version`; спека rooms.mail 6.3, 6.5). Окно по
   * ней сверяет события с `prevVersion`: разрыв значит, что оно что-то пропустило, и держимые письма надо перечитать. Нет
   * у снимка, собранного без версии (запись успела вклиниться между чтением версии и карты) и у хоста до `rooms-mail`.
   */
  version?: number;
}

/**
 * В тестах и разработке (`VITEST`, `PARLEY_FREEZE_MAPS=1`) карта списка замораживается: общий объект,
 * который кто-то правит «на месте», в проде тихо портил бы карту всем читателям сразу, а здесь это `TypeError`
 * в месте правки. В проде заморозки нет — обход объекта на каждую сборку лишний.
 */
const freezeMaps = process.env['VITEST'] !== undefined || process.env['PARLEY_FREEZE_MAPS'] === '1';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Карты списка по версии строки работы в базе (спека хранилища 6.9): неизменённая работа стоит одного запроса версии
 * вместо сборки карты. Карту отдаём общим объектом, не копией: читатели (`WorkEntry`) её не меняют — правки идут
 * через `updateMap`. Объект — своя копия (`readMap` выдаёт `structuredClone`), поэтому заморозка выше кэш хранилища
 * не задевает: тот мутируется `updateMap` на месте.
 */
const listedMaps = new Map<string, { version: number; map: WorkMap }>();

const listKey = (projectPath: string, workId: string): string => `${projectPath}\0${workId}`;

/**
 * Читает одну карту. Она может быть такой, что `normalizeMap` её не принимает, — в списке работ это повод
 * пропустить одну строку, а не остаться без списка совсем. Отдельная работа с такой картой отвечает за себя сама
 * (`readMap` по-прежнему бросает).
 *
 * Версию берём до карты: запись другого процесса между ними даст запоздавший ключ и лишнюю сборку при следующем
 * чтении, а не устаревшую карту под свежим ключом. `bytes` — только реальная сборка.
 */
async function readEntry(projectPath: string, workId: string): Promise<WorkEntry | null> {
  const key = listKey(projectPath, workId);
  const version = workVersion(projectPath, workId);
  if (version === undefined) {
    listedMaps.delete(key);
    return null;
  }
  const cached = listedMaps.get(key);
  if (cached !== undefined && cached.version === version) {
    return { projectPath, map: cached.map, bytes: 0, version };
  }
  try {
    const copy = await readMap(projectPath, workId);
    const map = freezeMaps ? deepFreeze(copy) : copy;
    listedMaps.set(key, { version, map });
    // Номер сообщается, только если версия не сдвинулась за время чтения карты: иначе под ним лежит более новая карта.
    const unchanged = workVersion(projectPath, workId) === version;
    return { projectPath, map, bytes: storedMapBytes(projectPath, workId) ?? 0, ...(unchanged ? { version } : {}) };
  } catch {
    listedMaps.delete(key);
    return null;
  }
}

/**
 * Все работы, которые нужно показать: список из таблицы `works` (все проекты базы, в том числе чужие — дизайн TUI,
 * 6.5) и карта каждой из `readMap`. Каталоги проектов не читаются: всё, что Parley про работу знает, лежит в базе.
 * Аргумент-проект принимается и не используется: список один на весь дом, а вызывающие (хост, тесты) его ещё
 * передают — хост уже без него, остались тесты ядра.
 *
 * `archived` здесь не отсеиваются: скрывает их список, а не чтение.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- см. выше: сигнатура остаётся ради вызывающих
export async function readWorks(_projectPath?: string): Promise<WorkEntry[]> {
  const works: WorkEntry[] = [];
  const listed = new Set<string>();

  for (const item of (await readWorksIndex()).works) {
    const key = listKey(item.projectPath, item.id);
    if (listed.has(key)) continue;
    listed.add(key);
    const entry = await readEntry(item.projectPath, item.id);
    if (entry !== null) works.push(entry);
  }

  // Карты работ, которых в списке больше нет (удалены, сняты `prune`), в кэше не держим.
  for (const key of listedMaps.keys()) if (!listed.has(key)) listedMaps.delete(key);
  return works;
}

export interface WatchWorksOptions {
  /** Запись карты — несколько событий подряд (запись самой работы, сверка живости) — склеиваем в одно чтение. */
  debounceMs?: number;
  /** Как часто опрашивать `PRAGMA data_version` — признак записи другого процесса; по умолчанию 500 мс (спека хранилища 6.9). */
  pollMs?: number;
  /** Чтение списка; подменяется в тестах, чтобы считать проходы. */
  read?: () => Promise<WorkEntry[]>;
  onError?: (error: unknown) => void;
}

export interface WorksWatcher {
  close(): void;
}

/**
 * Номер чтения списка — общий для всех наблюдателей процесса и растёт с
 * началом чтения, а не с его концом. Чтения идут параллельно (всплеск событий,
 * несколько наблюдателей), и медленное старое может закончиться позже
 * свежего: по номеру его можно узнать и отбросить.
 */
let readSeq = 0;

const versionKey = (projectPath: string, workId: string): string => `${projectPath}\0${workId}`;

const versionsNow = (): Map<string, number> =>
  new Map(listWorkVersions().map((row) => [versionKey(row.projectPath, row.id), row.version]));

const sameVersions = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, version] of left) if (right.get(key) !== version) return false;
  return true;
};

/**
 * Следит за работами и на изменение перечитывает список целиком: неизменённая работа в нём стоит одного запроса версии
 * (`readWorks`), а «какая именно работа изменилась» читателю знать не нужно.
 *
 * Файлов, за которыми можно следить, больше нет: база пишется журналом WAL без событий файловой системы (спека хранилища
 * 6.9). Источников два. Записи этого процесса приходят событием хранилища `onMapWritten`. Записи других процессов (CLI,
 * MCP агента без канала) видны по `PRAGMA data_version`: его опрос раз в `pollMs` ничего не читает, а когда число
 * сменилось, версии работ сверяются с прошлым снимком — лишнее чтение идёт только при настоящем отличии.
 *
 * Запись этого процесса, менявшая только письма (`structural === false`), чтения не просит: списку работ письма не нужны.
 * Её версию наблюдатель запоминает, и опрос чужих записей на ней не срабатывает.
 *
 * Чтений внахлёст не бывает: пока одно идёт, события лишь помечают список «грязным».
 */
export function watchWorks(
  onWorks: (works: WorkEntry[], seq: number) => void,
  { debounceMs = 300, pollMs = 500, read = readWorks, onError }: WatchWorksOptions = {},
): WorksWatcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let applied = 0;
  /** Чтение идёт, и события за это время просят ровно одно повторное после него, а не чтение на каждое. */
  let reading = false;
  let dirty = false;

  const refresh = (): void => {
    timer = undefined;
    if (closed) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    const seq = ++readSeq;
    // Синхронный бросок подменённого `read` не должен оставить `reading` навсегда.
    Promise.resolve()
      .then(() => read())
      .then((works) => {
        // Чтение, начатое раньше уже отданного, несёт устаревший список.
        if (closed || seq < applied) return;
        applied = seq;
        onWorks(works, seq);
      })
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        reading = false;
        if (dirty && !closed) {
          dirty = false;
          schedule();
        }
      });
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  };

  // Точка отсчёта опроса. Не вышла (база недоступна) — список пуст, и первый удавшийся опрос сам перечитает работы.
  let dataVersion: number | undefined;
  let versions = new Map<string, number>();
  try {
    dataVersion = workDataVersion();
    versions = versionsNow();
  } catch (error) {
    onError?.(error);
  }

  const unsubscribe = onMapWritten((event) => {
    const key = versionKey(event.projectPath, event.workId);
    if (event.removed === true) {
      versions.delete(key);
      schedule();
      return;
    }
    // Версия до записи не та, что известна наблюдателю: между ними легла чужая запись, которую опрос ещё не разобрал.
    // Запомнить новую версию и промолчать значило бы спрятать её от опроса — будим, как для любой записи.
    const unseen = event.prevVersion !== undefined && versions.get(key) !== event.prevVersion;
    versions.set(key, event.version);
    // Запись только писем списка работ не меняет (спека rooms.mail 6.7): письма идут окнам событием хоста. Версию
    // запомнили выше — опрос `data_version` такую запись изменением не сочтёт.
    if (event.structural === false && !unseen) return;
    schedule();
  });

  let failing = false;
  const poll = setInterval(() => {
    try {
      // Сначала число, потом версии: чужая запись между ними даст лишнее чтение, а не потерянное.
      const now = workDataVersion();
      if (now === dataVersion) {
        failing = false;
        return;
      }
      const next = versionsNow();
      failing = false;
      // Число запоминается только после удачного чтения версий: сбой между ними оставит прежнее, и следующий опрос повторит.
      dataVersion = now;
      const changed = !sameVersions(versions, next);
      versions = next;
      if (changed) schedule();
    } catch (error) {
      // Опрос идёт дважды в секунду: об одном и том же сбое сообщаем один раз, до первого удавшегося опроса.
      if (!failing) onError?.(error);
      failing = true;
    }
  }, pollMs);
  poll.unref();

  return {
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    },
  };
}
