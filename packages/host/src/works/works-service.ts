/**
 * Список работ хоста: сколько их, в каких проектах, кто их держит.
 *
 * Источник — таблица `works` базы дома и карта каждой работы (`readWorks`). О переменах сервис узнаёт не из файлов, а
 * от одного `watchWorks`: записи этого процесса приходят событием хранилища, записи других — опросом
 * `PRAGMA data_version` (спека хранилища 6.9). Наблюдателей по проектам больше нет — база одна на весь дом.
 *
 * Карту пишут трое — хост, CLI и MCP-серверы агентов (ревью, пункт 5): таймаут записи в базу (`MapLockTimeoutError`)
 * здесь не роняет сервис, а уходит уведомлением `host.notice` и повторяется на следующем изменении. Работу, которая есть
 * в базе, но не загружается (`normalizeMap` её не принимает), `readWorks` из core молча пропускает — сервис проверяет
 * это отдельно и жалуется один раз на работу, ничего в неё не дописывая.
 *
 * Письма идут мимо списка работ (спека rooms.mail 6.7): запись только писем (`structural === false` в событии хранилища) не
 * запускает `refreshPass` и не зовёт `onChange`. Окно с признаком `rooms-mail` получает её событием `rooms.mail` (пачка по
 * работе, `mail.ts`), окно без признака — `works.changed` по одной перечитанной работе, подписчики хоста — `onMail`. Смешанная
 * запись (карта и письма) идёт прежним полным проходом, а её письма — после публикации снимка, который её включает.
 */

import {
  compactWorkMap,
  gitBranch,
  isDatabaseBusy,
  letterCount,
  mapLetterReader,
  MapLockTimeoutError,
  onMapWritten,
  processStartedAt,
  readLetters,
  readMap,
  readWorks,
  readWorksIndex,
  reconcileMap,
  removeHostLease,
  storeLetterReader,
  viewMap,
  watchWorks,
  withLetterSnapshot,
  WorkNotFoundError,
  workVersion,
  writeHostLease,
} from '@parley/core';
import type { HostLease, MapWrittenEvent, WindowWorkEntry, WindowWorkMap, WorkEntry, WorkMap, WorksWatcher } from '@parley/core';
import { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, ROOMS_MAIL_FEATURE, encodeLine } from '@parley/protocol';
import type { RoomsMailEvent, WorksSnapshot } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import type { WindowCounters } from '../health/window-counters.js';
import {
  MAIL_BATCH_MS,
  MAIL_HOLD_MAX_MS,
  MAIL_SLOW_CLIENT_BYTES,
  buildMailEvent,
  fitMailEvent,
  gluedMailEvent,
  joinBatch,
  journalIsEmpty,
  startBatch,
} from './mail.js';
import type { MailBatch, MailNotice } from './mail.js';

export type { MailNotice } from './mail.js';

export interface WorksServiceOptions {
  /** Сколько подряд изменений склеивается в одну рассылку `works.changed`. */
  debounceMs?: number;
  /** Сколько запись сервиса (живость, аренда) ждёт занятую базу работ, мс. */
  lockTimeoutMs?: number;
  /** Счётчики окна строки состояния: один `refresh` — одна запись. */
  windowCounters?: WindowCounters;
  /**
   * Сколько пачка писем копится до рассылки, мс; по умолчанию `MAIL_BATCH_MS`. Только для тестов: большое значение, чтобы
   * пачку выпускал снимок, а не таймер. Выше `MAIL_HOLD_MAX_MS` потолком ожидания пачки, которую держит снимок, становится
   * само `mailBatchMs`.
   */
  mailBatchMs?: number;
}

/**
 * Снимок работ для сервисов хоста: карты хранимые, без писем (спека хранилища 6.2) — письма читаются из базы через API
 * писем. В кадр к клиенту он не идёт: окно получает `WorksSnapshot` с письмами (`windowSnapshot`, `legacySnapshot`).
 */
export interface WorksView {
  entries: WorkEntry[];
  branches: Record<string, string | null>;
  revision?: number;
}

export interface WorksService {
  start(): Promise<void>;
  /** Снимок для сервисов хоста: карты как в базе, без писем. В кадр к клиенту он не идёт — для этого `windowSnapshot`. */
  snapshot(): WorksView;
  /**
   * Снимок для окна с `compact-works` (P35): письма хвостом, длинные тексты сокращены, итоги и счётчики в
   * `map.compact`. `null` — даже он не влезает в кадр; номер `revision` растёт на каждую рассылку.
   */
  windowSnapshot(): WorksSnapshot | null;
  /** Прежний полный снимок для клиента без `compact-works`; `null` — он не влезает в кадр, клиенту нужно обновление. */
  legacySnapshot(): WorksSnapshot | null;
  entry(projectPath: string, workId: string): WorkEntry | undefined;
  /** Первое чтение этой работы хостом уже было: autoLaunch берёт только новое (1.7). */
  firstReadDone(projectPath: string, workId: string): boolean;
  onChange(listener: (snapshot: WorksView, previous: WorksView) => void): () => void;
  /**
   * Каждая запись с письмами (непустой журнал, спека rooms.mail 6.2, 6.7): запись только писем — сразу, после коммита;
   * смешанная — после публикации снимка, который её включает, но не позже `MAIL_HOLD_MAX_MS` от начала пачки: потолок
   * выпускает уведомление вместе с событием и до снимка, если полный проход не дошёл до `publish`. Смешанная запись всё равно
   * доходит до подписчика через `onChange` после прохода, и подписчик, которому нужны письма, пересчитывает и по нему, так что
   * раннее уведомление исправляется. `onChange` запись только писем не зовёт: подписчик, которому нужны письма, слушает это.
   */
  onMail(listener: (notice: MailNotice) => void): () => void;
  stop(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Склейка событий внутри `watchWorks`: записи подряд (письма, сверка живости нескольких работ) приходят с промежутками
 * в десятки миллисекунд, и при 0 каждая запускала бы своё чтение списка.
 */
const WATCH_DEBOUNCE_MS = 75;

/** Бюджет писем в снимке для окна: на все активные работы вместе, не больше на одну и не меньше на одну. */
const WINDOW_MESSAGES_TOTAL_BYTES = 3 * 1024 * 1024;
const WINDOW_MESSAGES_PER_WORK_BYTES = 1024 * 1024;
const WINDOW_MESSAGES_MIN_BYTES = 64 * 1024;
/** Потолок снимка для окна целиком: кадр ограничен 8 МиБ, остальное — запас на события и дописывание. */
const WINDOW_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Сколько писем у всех работ вместе читать для прежнего окна: осторожный предел, а не точная граница. Потолок кадра
 * (`LEGACY_SNAPSHOT_MAX_BYTES`, 6 МиБ) на 40 000 писем даёт около 157 Б на письмо, а самое короткое письмо в JSON весит
 * около 117 Б; живые письма тяжелее, поэтому больше этого числа кадр на деле не влезает, и читать письма ради отказа
 * незачем.
 */
const LEGACY_MAX_LETTERS = 40_000;
/** Тексты в запасном (сжатом) снимке: хвост писем не берётся вовсе, а длинные поля короче. */
const WINDOW_FALLBACK_TEXT_BYTES = 4 * 1024;

/** Сжатая карта одной работы для окна и её размер в кадре (`windowPart`). */
interface WindowPart {
  entry: WorksSnapshot['entries'][number];
  bytes: number;
}

const isCompactClient = (client: Client): boolean => client.features.has(COMPACT_WORKS_FEATURE);
/** Окно с `rooms-mail` получает письма событием; без признака — `works.changed` с хвостами писем, как прежде (спека 6.10). */
const isMailClient = (client: Client): boolean => client.features.has(ROOMS_MAIL_FEATURE);
const lacksMail = (client: Client): boolean => !isMailClient(client);
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Ключ работы для внутренних карт сервиса: `\u0000` в путях и id не встречается. */
const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

export function createWorksService(
  host: HostContext,
  options: WorksServiceOptions = {},
): WorksService {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const mailBatchMs = options.mailBatchMs ?? MAIL_BATCH_MS;
  const lockOptions =
    options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs };

  const entries = new Map<string, WorkEntry>();
  const branches = new Map<string, string | null>();
  let watcher: WorksWatcher | undefined;
  const listeners = new Set<(next: WorksView, previous: WorksView) => void>();
  const leased = new Set<string>();
  const readAlready = new Set<string>();
  const notifiedCorrupt = new Set<string>();
  /** Работа → версия, на которой она не загрузилась: до следующей записи её не перечитываем. */
  const corruptAt = new Map<string, number>();

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let latest: WorkEntry[] = [];
  /** Номер чтения `latest` (`watchWorks`): старое чтение свежее не затирает. */
  let latestSeq = 0;
  /** Идущее обновление снимка (`requestRefresh`) и просьба повторить его, когда закончится. */
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let ownLease: HostLease | null = null;
  /** Номер рассылки снимка; растёт в конце каждого `refresh`, перед рассылкой. */
  let revision = 0;
  /**
   * Снимок каждой работы для окна по версии её карты и бюджету писем (спека хранилища 6.2, план 4, задача 5): запись в одну
   * работу не заставляет сжимать остальные. Ключ — работа; в записи версия и по снимку на каждый бюджет (обычный,
   * архивный, запасной); после каждой сборки в слоте остаются только запрошенные ею варианты (`buildWindow`): простаивающая
   * работа не копит по варианту на каждое число живых работ, которое когда-то было.
   */
  const windowParts = new Map<string, { version: number; parts: Map<string, WindowPart> }>();
  /** Снимки для клиентов считаются один раз на номер: `works.list` и рассылка делят одну работу. */
  let windowCache: { revision: number; snapshot: WorksSnapshot | null } | null = null;
  let legacyCache: { revision: number; snapshot: WorksSnapshot | null } | null = null;
  /** Клиенты, о которых уже записано «нужно обновление», и признак сообщения о слишком большом снимке: не на каждую рассылку. */
  const upgradeNotified = new Set<string>();
  let oversizeNotified = false;

  const buildSnapshot = (): WorksView => ({
    entries: Array.from(entries.values()),
    branches: Object.fromEntries(branches),
  });

  /**
   * Сжатая карта одной работы для окна и её размер в кадре. Берётся из `windowParts`, пока не сменилась версия карты
   * (`WorkEntry.version`: та же версия — та же карта) и бюджет; у работы без версии кэша нет. Письма читаются запросами из
   * таблиц (`storeLetterReader`); живые правила непрочитанного идут по карте сервиса, а не по карте из базы (спека хранилища 6.2).
   * `asked` — какие варианты слота просила эта сборка окна: по нему `buildWindow` потом убирает остальные.
   */
  function windowPart(
    work: WorkEntry,
    messageBytes: number,
    asked: Map<string, Set<string>>,
    textMax?: number,
  ): WindowPart {
    const key = workKey(work.projectPath, work.map.work.id);
    const variant = `${messageBytes}:${textMax ?? ''}`;
    let wanted = asked.get(key);
    if (wanted === undefined) asked.set(key, (wanted = new Set()));
    wanted.add(variant);
    const slot = windowParts.get(key);
    const version = work.version;
    if (version !== undefined && slot?.version === version) {
      const cached = slot.parts.get(variant);
      if (cached !== undefined) return cached;
    }
    const options = { messageBytes, ...(textMax === undefined ? {} : { textMax }) };
    let map: WindowWorkMap;
    try {
      // Один снимок базы на все чтения писем этой работы: чужая запись между ними не рассогласует итоги и хвосты.
      map = withLetterSnapshot(work.projectPath, work.map.work.id, () =>
        compactWorkMap(work.map, options, storeLetterReader(work.projectPath, work.map.work.id, { map: work.map })),
      );
    } catch (error) {
      // Работу сняли между чтением списка и сборкой снимка: до следующего обновления она без писем, остальное окно не страдает.
      if (!(error instanceof WorkNotFoundError)) throw error;
      map = compactWorkMap(work.map, options, mapLetterReader({ ...work.map, messages: [] }));
    }
    // Версия работы едет в записи снимка (спека rooms.mail 6.3): по ней окно сверяет события писем с `prevVersion`.
    const entry = { projectPath: work.projectPath, map, ...(version === undefined ? {} : { version }) };
    const part = { entry, bytes: jsonBytes(entry) };
    if (version !== undefined) {
      if (slot?.version === version) slot.parts.set(variant, part);
      else windowParts.set(key, { version, parts: new Map([[variant, part]]) });
    }
    return part;
  }

  /**
   * Снимок для окна: каждая работа сжата `compactWorkMap`, бюджет писем делится между активными работами, архивные
   * идут без писем. Размер проверяется до отправки: не влез — запасной вариант без писем и с короткими текстами,
   * не влез и он — `null` (кадр, который декодер окна разорвёт, не уходит никогда). Размер кадра складывается из
   * размеров частей: каркас без работ, сами работы и запятые между ними — столько же, сколько дал бы `JSON.stringify`
   * всего снимка, но без повторной сериализации работ, которые не менялись.
   */
  function buildWindow(): WorksSnapshot | null {
    const asked = new Map<string, Set<string>>();
    const all = Array.from(entries.values());
    const live = all.filter((entry) => entry.map.work.status !== 'archived').length;
    const share = Math.min(
      WINDOW_MESSAGES_PER_WORK_BYTES,
      Math.max(WINDOW_MESSAGES_MIN_BYTES, Math.floor(WINDOW_MESSAGES_TOTAL_BYTES / Math.max(live, 1))),
    );
    const build = (messagesFor: (archived: boolean) => number, textMax?: number): WorksSnapshot | null => {
      const parts = all.map((work) => windowPart(work, messagesFor(work.map.work.status === 'archived'), asked, textMax));
      const snapshot: WorksSnapshot = {
        entries: parts.map((part) => part.entry),
        branches: Object.fromEntries(branches),
        revision,
      };
      const bytes =
        jsonBytes({ ...snapshot, entries: [] }) +
        parts.reduce((sum, part) => sum + part.bytes, 0) +
        Math.max(parts.length - 1, 0);
      return bytes <= WINDOW_SNAPSHOT_MAX_BYTES ? snapshot : null;
    };
    const snapshot = build((archived) => (archived ? 0 : share)) ?? build(() => 0, WINDOW_FALLBACK_TEXT_BYTES);
    // В слотах остаётся то, что просила эта сборка: слот пропавшей работы (её ключа в `asked` нет) уходит целиком, у
    // остальных — только запрошенные варианты. Запасной проход тоже в счёт: при снимке выше потолка просят оба варианта,
    // и пересобирать их каждый раз незачем.
    for (const [key, slot] of windowParts) {
      const wanted = asked.get(key);
      if (wanted === undefined) windowParts.delete(key);
      else for (const variant of slot.parts.keys()) if (!wanted.has(variant)) slot.parts.delete(variant);
    }
    return snapshot;
  }

  const windowSnapshot = (): WorksSnapshot | null => {
    if (windowCache?.revision !== revision) windowCache = { revision, snapshot: buildWindow() };
    return windowCache.snapshot;
  };

  /** Полные карты с письмами для прежнего окна; `null` — писем слишком много, чтобы читать их ради заведомого отказа. */
  const legacyEntries = (): WindowWorkEntry[] | null => {
    const all = Array.from(entries.values());
    const counts = all.map((work) => {
      try {
        return letterCount(work.projectPath, work.map.work.id, {});
      } catch (error) {
        if (error instanceof WorkNotFoundError) return 0;
        throw error;
      }
    });
    if (counts.reduce((sum, count) => sum + count, 0) > LEGACY_MAX_LETTERS) return null;
    return all.map((work, at) => {
      let messages: WindowWorkMap['messages'] = [];
      try {
        messages = readLetters(work.projectPath, work.map.work.id, { limit: counts[at] ?? 0 });
      } catch (error) {
        if (!(error instanceof WorkNotFoundError)) throw error;
      }
      return {
        projectPath: work.projectPath,
        map: { ...work.map, messages },
        ...(work.version === undefined ? {} : { version: work.version }),
      };
    });
  };

  const legacySnapshot = (): WorksSnapshot | null => {
    if (legacyCache?.revision !== revision) {
      const legacy = legacyEntries();
      const full: WorksSnapshot | null =
        legacy === null ? null : { entries: legacy, branches: Object.fromEntries(branches), revision };
      legacyCache = { revision, snapshot: full !== null && jsonBytes(full) <= LEGACY_SNAPSHOT_MAX_BYTES ? full : null };
    }
    return legacyCache.snapshot;
  };

  /** Рассылка снимка окнам: кадр кодируется один раз на рассылку, а не на клиента, и считается в счётчиках окна (спека rooms.mail 6.12). */
  function broadcastWorks(snapshot: WorksSnapshot, to: (client: Client) => boolean): void {
    const line = host.clients().some(to) ? encodeLine({ event: 'works.changed', data: snapshot }) : undefined;
    host.broadcast('works.changed', snapshot, to, line);
    if (line !== undefined) options.windowCounters?.worksChanged(Buffer.byteLength(line));
  }

  /**
   * Рассылка снимка: окно с `compact-works` получает компактный, прежнее окно — полный, пока тот влезает в кадр. Не
   * влезает — ни одного кадра сверх предела (декодер окна на таком разорвал бы соединение, и оно переподключалось бы
   * по кругу): прежнее окно остаётся с последним снимком, а хост один раз на клиента пишет об этом в журнал.
   * Уведомления `host.notice` прежнему окну не шлются: вида, которого оно не знает, его строка статуса не разберёт.
   *
   * `only` — кому слать: запись только писем перечитывает одну работу и шлёт снимок окнам без `rooms-mail` (спека
   * rooms.mail 6.10); снимки при этом не собираются, пока такого окна нет. Без `only` — полная рассылка, и вслед за снимком
   * уходят письма смешанных записей, которые он включает (`releaseMail`).
   */
  function publish(only?: (client: Client) => boolean): void {
    if (only !== undefined && !host.clients().some(only)) return;
    const wanted = only ?? ((): boolean => true);
    const toCompact = (client: Client): boolean => isCompactClient(client) && wanted(client);
    const toLegacy = (client: Client): boolean => !isCompactClient(client) && wanted(client);

    const compact = windowSnapshot();
    if (compact !== null) {
      broadcastWorks(compact, toCompact);
      oversizeNotified = false;
    } else if (!oversizeNotified) {
      oversizeNotified = true;
      notice('snapshot-too-large', 'the workspace snapshot does not fit into one frame even in compact form');
    }

    publishLegacy(toLegacy);
    if (only === undefined) {
      published.clear();
      for (const [key, work] of entries) if (work.version !== undefined) published.set(key, work.version);
      releaseMail();
    }
  }

  function publishLegacy(to: (client: Client) => boolean): void {
    const legacyClients = host.clients().filter(to);
    const stillConnected = new Set(legacyClients.map((client) => client.id));
    for (const id of upgradeNotified) if (!stillConnected.has(id)) upgradeNotified.delete(id);
    if (legacyClients.length === 0) return;
    const legacy = legacySnapshot();
    if (legacy !== null) {
      broadcastWorks(legacy, to);
      return;
    }
    for (const client of legacyClients) {
      if (upgradeNotified.has(client.id)) continue;
      upgradeNotified.add(client.id);
      host.log.warn('карта: полный снимок не влезает в кадр, окну без compact-works нужно обновление', { client: client.name });
    }
  }

  const notice = (kind: 'map-lock' | 'map-corrupt' | 'snapshot-too-large', text: string): void => {
    // Вид, добавленный в P35, знает только окно с `compact-works`: прежнее его строка статуса не разберёт.
    host.broadcast('host.notice', { kind, ref: null, text, at: new Date().toISOString() }, kind === 'snapshot-too-large' ? isCompactClient : undefined);
    host.log.warn(`карта: ${kind}`, { text });
  };

  /**
   * Работы, о которых знает таблица `works`, но которых нет в свежем чтении: либо её только что сняли (строки нет —
   * молчим, как и `readWorks`), либо строки есть, но `normalizeMap` работу не принимает — про это, в отличие от
   * `readWorks`, сервис обязан сказать (раздел «На что смотреть на ревью», пункт 5).
   */
  async function checkCorruption(present: ReadonlySet<string>): Promise<void> {
    const index = await readWorksIndex().catch(() => null);
    if (index === null) return;

    for (const item of index.works) {
      const key = workKey(item.projectPath, item.id);
      if (present.has(key)) {
        // Работа читается: следующая поломка — новая, о ней скажем снова.
        notifiedCorrupt.delete(key);
        corruptAt.delete(key);
        continue;
      }
      // Та же версия, что уже не загрузилась, не загрузится и сейчас: полная загрузка большой карты стоит десятых долей
      // секунды цикла хоста, а проход идёт на каждую запись любой работы. Грузим один раз на версию.
      let version: number | undefined;
      try {
        version = workVersion(item.projectPath, item.id);
      } catch {
        continue; // База не ответила: проверим на следующем проходе.
      }
      if (version === undefined) {
        corruptAt.delete(key);
        continue;
      }
      if (corruptAt.get(key) === version) continue;
      try {
        await readMap(item.projectPath, item.id);
        // Загрузилась — просто гонка со свежим чтением, не работа битая.
        notifiedCorrupt.delete(key);
        corruptAt.delete(key);
      } catch (error) {
        if (error instanceof WorkNotFoundError) continue;
        // База занята — не повреждение: молчим и пробуем на следующем проходе.
        if (isDatabaseBusy(error)) continue;
        corruptAt.set(key, version);
        if (notifiedCorrupt.has(key)) continue;
        notifiedCorrupt.add(key);
        const reason = error instanceof Error ? error.message : String(error);
        notice('map-corrupt', `workspace ${item.id} in ${item.projectPath} cannot be loaded: ${reason}`);
      }
    }
  }

  /**
   * Сверяет живость сессий с pid и подставляет в снимок уже пересчитанную карту.
   * Спящая с pid тоже кандидат: её процесс может оказаться жив (бывшая `done`
   * из карты v1), и сверка вернёт её в `active`.
   */
  async function reconcileLiveness(works: readonly WorkEntry[]): Promise<void> {
    for (const work of works) {
      const hasLiveCandidate = work.map.sessions.some(
        (session) =>
          (session.lifecycle === 'active' || session.lifecycle === 'sleeping') &&
          session.pid !== null,
      );
      if (!hasLiveCandidate) continue;

      try {
        await reconcileMap(work.projectPath, work.map.work.id, lockOptions);
        // Карта перечитывается всегда, а не только когда эта сверка нашла мёртвых: список
        // наблюдателя мог быть прочитан до записи прошлой сверки (sleeping уже на диске,
        // мёртвых больше нет), и без перечитывания снимок откатился бы к active мёртвой
        // сессии навсегда (fix-tests2, host-disconnect:127).
        // Версия — до карты и после неё: совпали, значит запись между ними не вклинилась и номер точен
        // (по нему снимок окна узнаёт, что работа не менялась; спека хранилища 6.9); не совпали — работа считается новой.
        const before = workVersion(work.projectPath, work.map.work.id);
        const fresh = await readMap(work.projectPath, work.map.work.id);
        const exact = before !== undefined && workVersion(work.projectPath, work.map.work.id) === before;
        entries.set(workKey(work.projectPath, work.map.work.id), {
          projectPath: work.projectPath,
          map: fresh,
          ...(exact ? { version: before } : {}),
        });
      } catch (error) {
        if (error instanceof MapLockTimeoutError) {
          notice('map-lock', error.message);
          continue;
        }
        host.log.error('живость работы не сверилась', {
          projectPath: work.projectPath,
          workId: work.map.work.id,
          error: String(error),
        });
      }
    }
  }

  /** Пишет аренду новой работе; уже арендованные пропускаются. */
  async function leaseWork(work: WorkEntry): Promise<void> {
    if (ownLease === null) return;
    const key = workKey(work.projectPath, work.map.work.id);
    if (leased.has(key)) return;
    try {
      await writeHostLease(work.projectPath, work.map.work.id, ownLease);
      leased.add(key);
    } catch (error) {
      host.log.error('аренда работы не записалась', {
        projectPath: work.projectPath,
        workId: work.map.work.id,
        error: String(error),
      });
    }
  }

  /** Байты карт считаются там, где список прочитан и разобран, а не в `refresh`: тот бывает на кэшированном списке. */
  function countParsed(works: readonly WorkEntry[]): void {
    options.windowCounters?.mapsParsed(works.reduce((sum, work) => sum + (work.bytes ?? 0), 0));
  }

  /** Пачки писем по работам, ждущие рассылки (спека rooms.mail 6.6): одна пачка на работу, живёт `MAIL_BATCH_MS`. */
  const batches = new Map<string, MailBatch>();
  /**
   * Работа → версия последней записи этого процесса, менявшей карту; запись сервиса может её ещё не содержать: полный проход
   * впереди (его запросил `watchWorks`). Письма, записанные после неё, уходят окнам с признаком только после снимка с этой
   * структурой — иначе окно с прежней версией получило бы `prevVersion`, которой не держит (спека 6.5). Устаревшие записи
   * убирает `pendingStructural`, когда `published` показывает версию не ниже. Проход, у которого записи работы нет точной
   * версии (чтение вклинилось в запись), `published` не заполняет и запись не снимает: его карта могла лечь до структурной
   * записи, и пачка за ней ждёт следующего снимка (чтение без версии `watchWorks` повторяет сам) или `MAIL_HOLD_MAX_MS`.
   */
  const mapAhead = new Map<string, number>();
  /** Работа → версия, с которой её последний раз разослал полный `publish`: запись сервиса меняется в начале прохода, а снимок уходит позже. */
  const published = new Map<string, number>();
  const mailListeners = new Set<(mail: MailNotice) => void>();
  let unsubscribeWritten: (() => void) | undefined;

  function notify(mail: MailNotice): void {
    for (const listener of [...mailListeners]) {
      try {
        listener(mail);
      } catch (error) {
        host.log.warn('письма: подписчик onMail упал', { workId: mail.workId, error: String(error) });
      }
    }
  }

  /** Версия структурной записи этого процесса, которой в уже разосланном снимке ещё нет; `undefined` — окна её видели. */
  function pendingStructural(key: string): number | undefined {
    const ahead = mapAhead.get(key);
    if (ahead === undefined) return undefined;
    const held = published.get(key);
    if (held !== undefined && held >= ahead) {
      mapAhead.delete(key);
      return undefined;
    }
    return ahead;
  }

  /**
   * Запись работы в сервисе после записи только писем: версия и `updatedAt` свежие, кэш снимка этой работы пересоберётся по
   * новой версии, номер рассылки растёт (спека rooms.mail 6.10). Ни веток, ни живости, ни аренд: от письма они не меняются,
   * и полный проход не нужен. `true` — запись заменена.
   *
   * Перечитывает только при непрерывности версий: запись сервиса не старше начала пачки и уже содержит её структурные записи,
   * а работа в базе — ровно на версии пачки. Иначе между записью сервиса и пачкой лежит запись, которой полный проход ещё не
   * видел (структурная этого процесса, чужая), — перечитав, мы втянули бы её в запись сервиса, `previous` следующего прохода
   * уже нёс бы её, и подписчики `onChange` (будильник, Telegram, активность) никогда не увидели бы переход. Тогда письма
   * дойдут до окон без признака вместе с этим проходом.
   */
  function refreshEntry(batch: MailBatch): boolean {
    const { projectPath, workId } = batch;
    const key = workKey(projectPath, workId);
    const current = entries.get(key);
    // Работы нет в списке сервиса (её создание или первое чтение ещё впереди) или у записи нет точной версии: обновит полный проход.
    if (current?.version === undefined) return false;
    // Запись сервиса уже не старше: полный проход прочёл работу после письма и разослал её всем окнам.
    if (current.version >= batch.version) return false;
    if (current.version < batch.prevVersion || current.version < batch.structuralVersion) return false;
    let fresh: WorkEntry;
    try {
      const before = workVersion(projectPath, workId);
      if (before !== batch.version) return false;
      const map = viewMap(projectPath, workId, (view) => structuredClone(view) as WorkMap);
      // Версия — до карты и после неё, как в `reconcileLiveness`: совпали — номер точен.
      if (workVersion(projectPath, workId) !== before) return false;
      fresh = { projectPath, map, version: before };
    } catch (error) {
      if (!(error instanceof WorkNotFoundError)) host.log.warn('письма: запись работы не перечиталась', { workId, error: String(error) });
      return false;
    }
    entries.set(key, fresh);
    // Следующий полный проход берёт список `latest`: без этого он вернул бы запись к версии, прочитанной до письма.
    const at = latest.findIndex((work) => work.projectPath === projectPath && work.map.work.id === workId);
    if (at >= 0) latest = latest.with(at, fresh);
    revision += 1;
    windowCache = null;
    legacyCache = null;
    return true;
  }

  /** Одно событие окнам с признаком: кадр кодируется один раз, медленным клиентам уходит склеенный вариант (спека 6.6). */
  function sendMail(batch: MailBatch): void {
    const targets = host.clients().filter(isMailClient);
    if (targets.length === 0) return;
    const event = fitMailEvent(buildMailEvent(batch));
    const slow = new Set(targets.filter((client) => client.writableLength() > MAIL_SLOW_CLIENT_BYTES).map((client) => client.id));
    const fast = new Set(targets.filter((client) => !slow.has(client.id)).map((client) => client.id));
    const send = (data: RoomsMailEvent, to: ReadonlySet<string>): void => {
      const line = encodeLine({ event: 'rooms.mail', data });
      host.broadcast('rooms.mail', data, (client) => to.has(client.id), line);
      options.windowCounters?.mail(Buffer.byteLength(line));
    };
    if (fast.size > 0) send(event, fast);
    if (slow.size > 0) send(gluedMailEvent(event), slow);
  }

  /**
   * Рассылает пачку работы. Письма уходят окнам с признаком; после записи только писем работа ещё перечитывается и
   * `works.changed` идёт окнам без признака (спека 6.10) — `onChange` и полный проход при этом не нужны. У смешанной записи
   * карта и снимок ушли полным проходом: подписчики узнают о ней здесь, вслед за снимком.
   */
  function flushMail(key: string): void {
    const batch = batches.get(key);
    if (batch === undefined) return;
    batches.delete(key);
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    try {
      for (const mail of batch.notices) notify(mail);
      const refreshed = refreshEntry(batch);
      try {
        sendMail(batch);
      } catch (error) {
        // Работу сняли, пока пачка ждала: письма слать некому.
        if (!(error instanceof WorkNotFoundError)) throw error;
      }
      if (refreshed) publish(lacksMail);
    } catch (error) {
      // Событие не ушло: следующее покажет окну разрыв по версии (`prevVersion`), и оно дочитает письма (спека 6.5).
      host.log.warn('письма: событие не ушло', { workId: batch.workId, error: String(error) });
    }
  }

  /** Снимок со структурой ушёл: письма смешанных записей, которые он включает, идут вслед за ним (спека 6.5). */
  function releaseMail(): void {
    for (const [key, batch] of batches) {
      if (batch.structuralVersion === 0) continue;
      // Работы ещё нет в списке или в нём версия старее записи — снимка с её структурой пока не было, а проход впереди.
      // Версии у записи нет (чтение вклинилось между записями) — карта в снимке могла лечь до структурной записи, и событие
      // обогнало бы её (спека 6.5): пачка ждёт повторного чтения, которое `watchWorks` теперь просит само (спека 6.10), или
      // `MAIL_HOLD_MAX_MS`.
      const entry = entries.get(key);
      if (entry?.version === undefined || entry.version < batch.structuralVersion) continue;
      flushMail(key);
    }
  }

  /** Запись этого процесса с письмами в журнале (спека 6.2); остальные записи окну писем не дают. */
  function onWritten(event: MapWrittenEvent): void {
    if (stopped) return;
    const key = workKey(event.projectPath, event.workId);
    if (event.removed === true) {
      const gone = batches.get(key);
      if (gone?.timer !== undefined) clearTimeout(gone.timer);
      batches.delete(key);
      mapAhead.delete(key);
      published.delete(key);
      return;
    }
    // Запись без признака `structural` (создание работы, замена карты) считается структурной, как у `watchWorks`.
    const structural = event.structural !== false;
    if (structural) mapAhead.set(key, event.version);
    const { journal } = event;
    if (journal === undefined || journalIsEmpty(journal)) return;
    const mail: MailNotice = {
      projectPath: event.projectPath,
      workId: event.workId,
      version: event.version,
      prevVersion: event.prevVersion ?? event.version - 1,
      journal,
      foreign: false,
    };
    let batch = batches.get(key);
    if (batch === undefined) batches.set(key, (batch = startBatch(event.projectPath, event.workId, mail.prevVersion)));
    joinBatch(batch, { version: event.version, journal, structural });
    // Запись только писем — подписчикам сразу; смешанная ждёт снимка, в котором есть её структура.
    if (structural) batch.notices.push(mail);
    else {
      // Структурная запись без писем (статус, план) ещё не в записи сервиса: письма за ней ждут снимка с ней, как смешанная
      // пачка, иначе окно получило бы событие раньше снимка и увидело разрыв по версии.
      const ahead = pendingStructural(key);
      if (ahead !== undefined) batch.structuralVersion = Math.max(batch.structuralVersion, ahead);
      notify(mail);
    }
    if (batch.timer === undefined) {
      const waiting = batch;
      waiting.timer = setTimeout(() => {
        waiting.timer = undefined;
        // Пачку со структурной записью выпускает `releaseMail` после публикации снимка, а не этот таймер, но ждёт она не дольше
        // `MAIL_HOLD_MAX_MS` от начала пачки: снимок может не выйти (проход упал, работу сняли, у записи нет версии).
        const rest = waiting.structuralVersion === 0 ? 0 : MAIL_HOLD_MAX_MS - (Date.now() - waiting.startedAt);
        if (rest <= 0) {
          flushMail(key);
          return;
        }
        waiting.timer = setTimeout(() => {
          waiting.timer = undefined;
          flushMail(key);
        }, rest);
      }, mailBatchMs);
    }
  }

  /** Источник перемен списка — `watchWorks` на всю базу, источник писем — `onMapWritten`; заводятся на `start`. */
  function ensureWatcher(): void {
    if (stopped || watcher !== undefined) return;
    watcher = watchWorks(
      (works, seq) => {
        // Разбор уже случился, даже если список ниже отбросим как устаревший.
        countParsed(works);
        // Чтение, начатое раньше уже принятого, может прийти позже свежего.
        if (seq < latestSeq) return;
        latestSeq = seq;
        latest = works;
        scheduleRefresh();
      },
      {
        debounceMs: WATCH_DEBOUNCE_MS,
        onError: (error) =>
          host.log.warn('наблюдение за работами: событие пропущено', { error: String(error) }),
      },
    );
    unsubscribeWritten = onMapWritten(onWritten);
  }

  function scheduleRefresh(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void requestRefresh();
    }, debounceMs);
  }

  /**
   * Обновления идут по одному (разбор 2026-10-14): записи самой сверки живости будят наблюдатель, и новое обновление
   * внахлёст повторяло ту же работу — разбор логов провайдеров, запись карт, — а старт хоста на копии настоящих карт
   * растягивался до 15–30 с. Просьбы, пришедшие во время обновления, склеиваются в одно следующее — со свежим списком.
   */
  function requestRefresh(): Promise<void> {
    if (refreshing !== undefined) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        await refresh(latest);
      } while (refreshAgain && !stopped);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  /** Счётчик окна: проход `refresh` считается и при сбое в `publish` или слушателе, и при раннем выходе из-за `stopped`. */
  async function refresh(works: readonly WorkEntry[]): Promise<void> {
    const startedAt = performance.now();
    try {
      if (stopped) return;
      await refreshPass(works);
    } finally {
      options.windowCounters?.refresh(performance.now() - startedAt);
    }
  }

  async function refreshPass(works: readonly WorkEntry[]): Promise<void> {
    if (stopped) return;
    const previous = buildSnapshot();

    // `works` — уже полный список: `readWorks` каждый раз берёт всю таблицу `works`
    // (неизменённая работа — из кэша по версии), поэтому карту сервиса можно просто
    // заменить целиком, слитую по ключу `projectPath+workId`.
    const seenKeys = new Set<string>();
    entries.clear();
    for (const work of works) {
      const key = workKey(work.projectPath, work.map.work.id);
      entries.set(key, work);
      seenKeys.add(key);
    }

    const projects = new Set(works.map((work) => work.projectPath));
    await Promise.all(
      Array.from(projects).map(async (projectPath) => {
        branches.set(projectPath, await gitBranch(projectPath));
      }),
    );
    for (const projectPath of Array.from(branches.keys())) {
      if (!projects.has(projectPath)) branches.delete(projectPath);
    }

    await reconcileLiveness(works);
    await checkCorruption(seenKeys);
    for (const work of works) await leaseWork(work);

    const snapshot = buildSnapshot();
    revision += 1;
    windowCache = null;
    legacyCache = null;
    publish();
    for (const listener of listeners) listener(snapshot, previous);
    for (const key of seenKeys) readAlready.add(key);
  }

  return {
    async start() {
      ownLease = {
        pid: process.pid,
        startedAtProcess: await processStartedAt(process.pid),
        since: new Date().toISOString(),
      };

      // Источник заводится до первого чтения: запись между ними он заметит и пошлёт повторное.
      ensureWatcher();

      const initial = await readWorks();
      countParsed(initial);
      // Наблюдатель успел отдать своё чтение, пока шло это, — его и берём:
      // номер у начального чтения не спросить, а следующее событие всё равно
      // перечитает список.
      if (latestSeq === 0) latest = initial;
      await requestRefresh();
    },
    snapshot: buildSnapshot,
    windowSnapshot,
    legacySnapshot,
    entry: (projectPath, workId) => entries.get(workKey(projectPath, workId)),
    firstReadDone: (projectPath, workId) => readAlready.has(workKey(projectPath, workId)),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMail(listener) {
      mailListeners.add(listener);
      return () => mailListeners.delete(listener);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
      unsubscribeWritten?.();
      unsubscribeWritten = undefined;
      for (const batch of batches.values()) if (batch.timer !== undefined) clearTimeout(batch.timer);
      batches.clear();

      const pid = process.pid;
      await Promise.all(
        Array.from(entries.values()).map((work) =>
          removeHostLease(work.projectPath, work.map.work.id, pid).catch((error: unknown) => {
            host.log.error('снятие аренды не удалось', {
              projectPath: work.projectPath,
              workId: work.map.work.id,
              error: String(error),
            });
          }),
        ),
      );
    },
  };
}
