/**
 * Список работ хоста: сколько их, в каких проектах, кто их держит.
 *
 * Источник — глобальный индекс (`readWorksIndex`) плюс карта каждого известного
 * проекта. Наблюдатель за одним `parleyHome()` ловит только смену самого
 * индекса — содержимое чужого `<проект>/.parley/works/<id>/map.json` (или прежнего `.harnas`) лежит вне его поля
 * зрения, поэтому на каждый известный проект заводится свой `watchWorks`
 * (спецификация 3.3, 4.2, план, кусок 1.4).
 *
 * Карту пишут трое — хост, CLI и MCP-серверы агентов (ревью, пункт 5): таймаут
 * `map.lock` здесь не роняет сервис, а уходит уведомлением `host.notice` и
 * повторяется на следующем изменении. Карту, которая есть на диске, но не
 * разбирается, `readWorks` из core молча пропускает — сервис проверяет это
 * отдельно и жалуется один раз на файл, ничего в него не дописывая.
 *
 * Карта-журнал (v3, спека 2026-10-16, B3–B4): письмо — строка в журнале, индекс при этом не меняется. Наблюдатель называет
 * изменившийся файл; журнал дочитывается хвостом (`journal-tail.ts`), письмо дописывается в собранную карту дельтой
 * (`appendLetters`) и уходит окнам событием `rooms.mail`, без `refresh` и без разбора карт. Индекс — прежний путь: список
 * перечитывается, но карты с тем же mtime и размером не разбираются (`readWorks(…, previous)`).
 */

import path from 'node:path';
import {
  appendLetters,
  applyCursors,
  compactWorkMap,
  derivedEntry,
  finishV2Cleanup,
  gitBranch,
  hasLiveSession,
  hasV2Copy,
  isJournalEntry,
  migrateMapToJournal,
  parleyHome,
  MapLockTimeoutError,
  processStartedAt,
  readCursorFile,
  readIndex,
  readMap,
  readWorkEntry,
  readWorks,
  readWorksIndex,
  reconcileMap,
  removeHostLease,
  watchWorks,
  workPaths,
  workSchemaVersion,
  writeHostLease,
} from '@parley/core';
import type { CursorFile, HostLease, JournalLetter, Message, WorkEntry, WorkFileChange, WorksWatcher } from '@parley/core';
import { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, ROOMS_MAIL_FEATURE, encodeLine } from '@parley/protocol';
import type { EventData, WorksSnapshot } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { createSettler } from '../watch-settle.js';
import type { WindowCounters } from '../health/window-counters.js';
import { createJournalTail, type JournalTail } from './journal-tail.js';

/** Событие `rooms.mail`: в журнал дописаны письма. */
export type RoomMail = EventData<'rooms.mail'>;

export interface WorksServiceOptions {
  /** Сколько подряд изменений склеивается в одну рассылку `works.changed`. */
  debounceMs?: number;
  /** Таймаут `map.lock` для записей сервиса (живость, аренда). */
  lockTimeoutMs?: number;
  /** Счётчики окна строки состояния: один `refresh` — одна запись. */
  windowCounters?: WindowCounters;
  /**
   * true — карты v2 без живых сессий переводятся на журналы (`migrate-map.ts`). По умолчанию выключено; боевой хост
   * (`main.ts`) включает. Тесты миграции задают его явно.
   */
  migrateMaps?: boolean;
  /** Первая задержка повторной проверки работы, ждущей конца живой сессии, мс; каждая следующая вдвое дольше. */
  migrationRetryMs?: number;
}

export interface WorksService {
  start(): Promise<void>;
  /** Полный снимок для сервисов хоста: карты как на диске. В кадр к клиенту он не идёт — для этого `windowSnapshot`. */
  snapshot(): WorksSnapshot;
  /**
   * Снимок для окна с `compact-works` (P35): письма хвостом, длинные тексты сокращены, итоги и счётчики в
   * `map.compact`. `null` — даже он не влезает в кадр; номер `revision` растёт на каждую рассылку.
   */
  windowSnapshot(): WorksSnapshot | null;
  /** Прежний полный снимок для клиента без `compact-works`; `null` — он не влезает в кадр, клиенту нужно обновление. */
  legacySnapshot(): WorksSnapshot | null;
  entry(projectPath: string, workId: string): WorkEntry | undefined;
  /**
   * В журнал карты-журнала дописаны письма (уже в `snapshot()`/`entry()`). Зовётся тем же событием, что уходит окнам с
   * `rooms-mail`: будильнику нужны адресаты, активности — работа. Перечитывание индекса сюда не приходит.
   */
  onMail(listener: (mail: RoomMail) => void): () => void;
  /** Первое чтение этой работы хостом уже было: autoLaunch берёт только новое (1.7). */
  firstReadDone(projectPath: string, workId: string): boolean;
  onChange(listener: (snapshot: WorksSnapshot, previous: WorksSnapshot) => void): () => void;
  /** Проход миграции карт (если идёт) закончился. Без миграции — сразу. */
  migrationSettled(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 100;

/** Бюджет писем в снимке для окна: на все активные работы вместе, не больше на одну и не меньше на одну. */
const WINDOW_MESSAGES_TOTAL_BYTES = 3 * 1024 * 1024;
const WINDOW_MESSAGES_PER_WORK_BYTES = 1024 * 1024;
const WINDOW_MESSAGES_MIN_BYTES = 64 * 1024;
/** Потолок снимка для окна целиком: кадр ограничен 8 МиБ, остальное — запас на события и дописывание. */
const WINDOW_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
/** Тексты в запасном (сжатом) снимке: хвост писем не берётся вовсе, а длинные поля короче. */
const WINDOW_FALLBACK_TEXT_BYTES = 4 * 1024;

const isCompactClient = (client: Client): boolean => client.features.has(COMPACT_WORKS_FEATURE);
const wantsMail = (client: Client): boolean => client.features.has(ROOMS_MAIL_FEATURE);
const lacksMail = (client: Client): boolean => !wantsMail(client);

/** Снимок вместе с кадром `works.changed`, закодированным один раз: по нему меряется размер и он же уходит каждому клиенту. */
interface Framed {
  snapshot: WorksSnapshot;
  line: string;
}
/** Байты кадра вокруг данных снимка (`{"event":"works.changed","data":` + `}` + перевод строки): пределы считаются по снимку, как раньше. */
const FRAME_ENVELOPE_BYTES = Buffer.byteLength('{"event":"works.changed","data":}\n');
const frame = (snapshot: WorksSnapshot): Framed => ({ snapshot, line: encodeLine({ event: 'works.changed', data: snapshot }) });
const snapshotBytes = (framed: Framed): number => Buffer.byteLength(framed.line, 'utf8') - FRAME_ENVELOPE_BYTES;

/** Сколько последних дописанных писем работы помнит сервис, чтобы вернуть их в список, прочитанный с диска чуть раньше. */
const RECENT_LETTERS_KEPT = 200;

/** Повторы проверки работы, ждущей конца живой сессии: сколько раз и с какой первой задержкой (дальше вдвое дольше). */
const MIGRATION_RETRIES = 3;
const MIGRATION_RETRY_MS = 30_000;
/** Проход миграции рассылает снимок не чаще: сотни работ на первом запуске не дают сотни рассылок. */
const MIGRATION_ANNOUNCE_MS = 250;

/** Ключ работы для внутренних карт сервиса: `\u0000` в путях и id не встречается. */
const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

export function createWorksService(
  host: HostContext,
  options: WorksServiceOptions = {},
): WorksService {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const lockOptions =
    options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs };

  const entries = new Map<string, WorkEntry>();
  const branches = new Map<string, string | null>();
  const watchers = new Map<string, WorksWatcher>();
  const listeners = new Set<(next: WorksSnapshot, previous: WorksSnapshot) => void>();
  const leased = new Set<string>();
  const readAlready = new Set<string>();
  const notifiedCorrupt = new Set<string>();
  /** Время старта этого запуска сервиса: в индекс работы ложится как `migratedRun`, и копию v2 убирает только более поздний запуск. */
  const runStartedAt = new Date().toISOString();
  /** Работы, по которым этот запуск уже решал судьбу `map.v2.json` или уже сообщил о сбое миграции: раз за запуск. */
  const migrationHandled = new Set<string>();
  /** Работы на v2 с живой сессией: сколько повторных проверок уже было. Пока работа здесь, в снимке у неё `migrationPending`. */
  const migrationWaiting = new Map<string, number>();
  /** Идущий проход миграции, просьба о ещё одном после него, просьба о повторе ждущих и таймер повтора. */
  let migrationRun: Promise<void> | undefined;
  let migrationAgain = false;
  let migrationRetryDue = false;
  let retryTimer: NodeJS.Timeout | undefined;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let latest: WorkEntry[] = [];
  /** Последний список наблюдателя как пришёл, до дописывания писем: по нему узнаётся повтор того же чтения. */
  let lastRaw: readonly WorkEntry[] = [];
  /** Номер чтения `latest` (`watchWorks`): старое чтение свежее не затирает. */
  let latestSeq = 0;
  /** Идущее обновление снимка (`requestRefresh`) и просьба повторить его, когда закончится. */
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let ownLease: HostLease | null = null;
  /** Номер рассылки снимка; растёт в конце каждого `refresh`, перед рассылкой. */
  let revision = 0;
  /** Снимки для клиентов считаются один раз на номер: `works.list` и рассылка делят одну работу. */
  let windowCache: { revision: number; framed: Framed | null } | null = null;
  let legacyCache: { revision: number; framed: Framed | null } | null = null;
  /** Клиенты, о которых уже записано «нужно обновление», и признак сообщения о слишком большом снимке: не на каждую рассылку. */
  const upgradeNotified = new Set<string>();
  let oversizeNotified = false;

  /** Работы на карте-журнале (v3): только их письма читаются хвостом. Заполняют списки наблюдателя и миграция. */
  const journalWorks = new Set<string>();
  /** Хвосты журналов по файлу (с ключом работы — для очистки, когда работа исчезла); позиция живёт, пока жив сервис. */
  const tails = new Map<string, { tail: JournalTail; key: string }>();
  /**
   * Письма, которые хвост прочитал, а комнаты в собранной карте ещё нет: индекс с комнатой придёт позже письма. Хвост
   * уже сдвинулся, так что заново эти письма не прочитать — их держит сервис, пока `refresh` не принесёт комнату.
   */
  const parked = new Map<string, JournalLetter[]>();
  /** Изменения файлов, ещё не обработанные: на файл одна запись, обработка идёт по одной. */
  const pendingChanges = new Map<string, WorkFileChange>();
  let draining: Promise<void> | undefined;
  /** Последние письма и файлы курсоров, которые сервис уже учёл, по работе: список, прочитанный с диска чуть раньше, не должен их откатить. */
  const recentLetters = new Map<string, JournalLetter[]>();
  const seenCursors = new Map<string, Map<string, CursorFile>>();
  /** Id писем собранной карты работы — для отсева уже известных писем; привязан к объекту карты. */
  const knownIdsCache = new Map<string, { map: WorkEntry['map']; ids: Set<string> }>();
  const mailListeners = new Set<(mail: RoomMail) => void>();

  const buildSnapshot = (): WorksSnapshot => ({
    entries: Array.from(entries.values()),
    branches: Object.fromEntries(branches),
  });

  /**
   * Снимок для окна: каждая работа сжата `compactWorkMap`, бюджет писем делится между активными работами, архивные
   * идут без писем. Размер проверяется до отправки: не влез — запасной вариант без писем и с короткими текстами,
   * не влез и он — `null` (кадр, который декодер окна разорвёт, не уходит никогда).
   */
  function buildWindow(): Framed | null {
    const all = Array.from(entries.values());
    const live = all.filter((entry) => entry.map.work.status !== 'archived').length;
    const share = Math.min(
      WINDOW_MESSAGES_PER_WORK_BYTES,
      Math.max(WINDOW_MESSAGES_MIN_BYTES, Math.floor(WINDOW_MESSAGES_TOTAL_BYTES / Math.max(live, 1))),
    );
    const build = (messagesFor: (archived: boolean) => number, textMax?: number): Framed =>
      frame({
        entries: all.map((entry) => ({
          projectPath: entry.projectPath,
          map: compactWorkMap(entry.map, {
            messageBytes: messagesFor(entry.map.work.status === 'archived'),
            ...(textMax === undefined ? {} : { textMax }),
          }),
          // Только когда миграция ждёт: окно без этого поля (прежнее) его просто не видит.
          ...(entry.migrationPending === true ? { migrationPending: true } : {}),
        })),
        branches: Object.fromEntries(branches),
        revision,
      });
    const normal = build((archived) => (archived ? 0 : share));
    if (snapshotBytes(normal) <= WINDOW_SNAPSHOT_MAX_BYTES) return normal;
    const fallback = build(() => 0, WINDOW_FALLBACK_TEXT_BYTES);
    return snapshotBytes(fallback) <= WINDOW_SNAPSHOT_MAX_BYTES ? fallback : null;
  }

  /**
   * Снимки для клиентов устарели (письмо, курсор, пересборка работы без `refresh`). Номер снимка растёт, как после
   * `refresh`: его сравнивает окно (`store/works.ts`, применяет только снимок новее уже применённого) и по нему же
   * живут оба кэша. Без этого `works.list` отдавал бы снимок до письма окну, открытому после события.
   */
  function invalidateSnapshots(): void {
    revision += 1;
    windowCache = null;
    legacyCache = null;
  }

  const windowFramed = (): Framed | null => {
    if (windowCache?.revision !== revision) windowCache = { revision, framed: buildWindow() };
    return windowCache.framed;
  };
  const windowSnapshot = (): WorksSnapshot | null => windowFramed()?.snapshot ?? null;

  const legacyFramed = (): Framed | null => {
    if (legacyCache?.revision !== revision) {
      const full = frame({ ...buildSnapshot(), revision });
      legacyCache = { revision, framed: snapshotBytes(full) <= LEGACY_SNAPSHOT_MAX_BYTES ? full : null };
    }
    return legacyCache.framed;
  };
  const legacySnapshot = (): WorksSnapshot | null => legacyFramed()?.snapshot ?? null;

  /**
   * Рассылка снимка: окно с `compact-works` получает компактный, прежнее окно — полный, пока тот влезает в кадр. Не
   * влезает — ни одного кадра сверх предела (декодер окна на таком разорвал бы соединение, и оно переподключалось бы
   * по кругу): прежнее окно остаётся с последним снимком, а хост один раз на клиента пишет об этом в журнал.
   * Уведомления `host.notice` прежнему окну не шлются: вида, которого оно не знает, его строка статуса не разберёт.
   */
  function publish(only?: (client: Client) => boolean): void {
    const allowed = (client: Client): boolean => only === undefined || only(client);
    const compact = windowFramed();
    if (compact !== null) {
      host.broadcast('works.changed', compact.snapshot, (client) => isCompactClient(client) && allowed(client), compact.line);
      oversizeNotified = false;
    } else if (!oversizeNotified) {
      oversizeNotified = true;
      notice('snapshot-too-large', 'the workspace snapshot does not fit into one frame even in compact form');
    }

    const legacyClients = host.clients().filter((client) => !isCompactClient(client));
    const stillConnected = new Set(legacyClients.map((client) => client.id));
    for (const id of upgradeNotified) if (!stillConnected.has(id)) upgradeNotified.delete(id);
    if (legacyClients.length === 0) return;
    const legacy = legacyFramed();
    if (legacy !== null) {
      host.broadcast('works.changed', legacy.snapshot, (client) => !isCompactClient(client) && allowed(client), legacy.line);
      return;
    }
    for (const client of legacyClients) {
      if (upgradeNotified.has(client.id)) continue;
      upgradeNotified.add(client.id);
      host.log.warn('карта: полный снимок не влезает в кадр, окну без compact-works нужно обновление', { client: client.name });
    }
  }

  /**
   * Письмо в журнал не меняет индекс: окно с `rooms-mail` получает `rooms.mail` и дочитывает письма само, а окно без
   * признака рассылкой `works.changed` — только оно и только если оно есть. Это не `refresh`: слушатели сервиса не зовутся.
   */
  function publishToWindowsWithoutMail(): void {
    if (!host.clients().some(lacksMail)) return;
    publish(lacksMail);
  }

  const notice = (kind: 'map-lock' | 'map-corrupt' | 'snapshot-too-large', text: string): void => {
    // Вид, добавленный в P35, знает только окно с `compact-works`: прежнее его строка статуса не разберёт.
    host.broadcast('host.notice', { kind, ref: null, text, at: new Date().toISOString() }, kind === 'snapshot-too-large' ? isCompactClient : undefined);
    host.log.warn(`карта: ${kind}`, { text });
  };

  /**
   * Работы, о которых знает глобальный индекс, но которых нет в свежем чтении:
   * либо её каталог переехал или исчез (файла нет — молчим, как и `readWorks`),
   * либо `map.json` есть, но не разбирается — про это, в отличие от `readWorks`,
   * сервис обязан сказать (раздел «На что смотреть на ревью», пункт 5).
   */
  async function checkCorruption(present: ReadonlySet<string>): Promise<void> {
    const index = await readWorksIndex().catch(() => null);
    if (index === null) return;

    for (const item of index.works) {
      const key = workKey(item.projectPath, item.id);
      if (present.has(key)) continue;
      try {
        await readMap(item.projectPath, item.id);
        // Распарсилась — просто гонка со свежим чтением, не карта битая.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (notifiedCorrupt.has(key)) continue;
        notifiedCorrupt.add(key);
        notice('map-corrupt', workPaths(item.projectPath, item.id).map);
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
        const fresh = await readMap(work.projectPath, work.map.work.id);
        setEntry(
          workKey(work.projectPath, work.map.work.id),
          overlayEntry({
            projectPath: work.projectPath,
            map: fresh,
          }),
        );
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

  /**
   * Перевод карт v2 на журналы (задача 7 плана, спека B5) идёт ВНЕ обновления снимка: `refreshPass` только просит проход
   * (`scheduleMigration`) после того, как снимок разослан, и не ждёт его, так что первое соединение окна не ждёт перевода
   * всех карт. Проход идёт по работам по одной (между ними хост отвечает на другие запросы), каждый исход помечает работу
   * разобранной, и позднее обновление её не трогает: сбой, пропуск «не v2» и «карты нет» не повторяются и не пишутся в
   * журнал снова. Исключение одно — работа с живой сессией: она остаётся на v2 с `migrationPending`, и её проверка
   * повторяется по таймеру `MIGRATION_RETRIES` раз с удвоением задержки (30 с, 60 с, 120 с); после этого работа ждёт
   * следующего запуска хоста, пометка остаётся. Сбой одной работы остальных не трогает. Проход пишет в журнал хоста
   * одну итоговую строку.
   * Работа на v3, переведённая более ранним запуском хоста, лишается `map.v2.json` (`finishV2Cleanup`): окно и панели уже
   * читали собранную карту. Копию, сделанную этим запуском, он не трогает; не трогает и тогда, когда миграция что-то
   * отбросила или не воспроизвела: причина с числами идёт в журнал хоста.
   */
  function scheduleMigration(retry = false): void {
    if (options.migrateMaps !== true || stopped) return;
    if (retry) migrationRetryDue = true;
    if (migrationRun !== undefined) {
      migrationAgain = true;
      return;
    }
    migrationRun = (async () => {
      try {
        do {
          migrationAgain = false;
          const retrying = migrationRetryDue;
          migrationRetryDue = false;
          await migrationPass(retrying);
        } while (migrationAgain && !stopped);
      } catch (error) {
        // Журнал хоста мог пропасть вместе с домом: сбой записи в него не должен стать необработанным отказом.
        try {
          host.log.error('миграция карт: проход не удался', { error: String(error) });
        } catch {
          // писать некуда
        }
      }
      armMigrationRetry();
    })().finally(() => {
      migrationRun = undefined;
    });
  }

  /** Следующая проверка работ, ждущих конца живой сессии: один таймер на всех, задержка удваивается с каждым повтором. */
  function armMigrationRetry(): void {
    if (stopped || retryTimer !== undefined) return;
    const attempts = Array.from(migrationWaiting.values()).filter((done) => done < MIGRATION_RETRIES);
    if (attempts.length === 0) return;
    const delay = (options.migrationRetryMs ?? MIGRATION_RETRY_MS) * 2 ** Math.min(...attempts);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      scheduleMigration(true);
    }, delay);
    retryTimer.unref();
  }

  type MigrationOutcome = 'migrated' | 'waiting' | 'failed' | 'skipped' | 'gone';

  /**
   * Запись работы в снимок. Пометка `migrationPending` держится, пока работа ждёт конца живой сессии: список с диска и
   * перечитывание о ней не знают. Работа, уже ставшая журналом (v3), ждать перестаёт.
   */
  function setEntry(key: string, entry: WorkEntry): void {
    if (isJournalEntry(entry)) migrationWaiting.delete(key);
    entries.set(key, migrationWaiting.has(key) ? { ...entry, migrationPending: true } : entry);
  }

  /** Работа остаётся на v2 до конца живой сессии: пометка `migrationPending` ложится в запись и держится в `migrationWaiting`. */
  function holdForSession(key: string): MigrationOutcome {
    if (!migrationWaiting.has(key)) migrationWaiting.set(key, 0);
    const current = entries.get(key);
    if (current !== undefined) setEntry(key, current);
    return 'waiting';
  }

  async function migrateOne(key: string): Promise<MigrationOutcome> {
    const work = entries.get(key);
    if (work === undefined) return 'gone';
    const workId = work.map.work.id;
    try {
      const version = await workSchemaVersion(work.projectPath, workId);
      if (version === 3) {
        migrationHandled.add(key);
        migrationWaiting.delete(key);
        if (!(await hasV2Copy(work.projectPath, workId))) return 'skipped';
        const outcome = await finishV2Cleanup(work.projectPath, workId, runStartedAt);
        if (outcome === 'kept-dropped') {
          const kept = (await readIndex(work.projectPath, workId)).v2Kept;
          host.log.warn('карта: map.v2.json оставлена навсегда, миграция не воспроизвела часть сведений', { projectPath: work.projectPath, workId, ...kept });
        } else {
          host.log.info('карта: копия v2 после миграции', { projectPath: work.projectPath, workId, outcome });
        }
        return 'skipped';
      }
      if (version !== 2) {
        migrationHandled.add(key);
        return 'skipped';
      }
      if (await hasLiveSession((entries.get(key) ?? work).map)) return holdForSession(key);
      const result = await migrateMapToJournal(work.projectPath, workId, { ...lockOptions, run: runStartedAt });
      if (result.status === 'skipped') {
        // `live-session`: сессия ожила между снимком и замком; `locked`: карту держит другой писатель. Оба случая могут пройти.
        if (result.reason === 'locked' || result.reason === 'live-session') return holdForSession(key);
        migrationHandled.add(key);
        return 'skipped';
      }
      migrationHandled.add(key);
      migrationWaiting.delete(key);
      if (result.status === 'failed') {
        host.log.error('миграция карты не удалась, работа остаётся на v2', { projectPath: work.projectPath, workId, step: result.step, detail: result.detail });
        return 'failed';
      }
      host.log.info('карта переведена на журналы', { projectPath: work.projectPath, workId, ...result });
      if (result.orderMismatches > 0 || result.readByMismatches > 0 || result.orphaned > 0 || result.droppedMarks > 0) {
        host.log.warn('миграция карты: часть сведений не воспроизведена сборщиком, map.v2.json останется навсегда', { projectPath: work.projectPath, workId, ...result });
      }
      const assembled = await readMap(work.projectPath, workId);
      if (entries.has(key)) setEntry(key, { projectPath: work.projectPath, map: assembled });
      journalWorks.add(key);
      return 'migrated';
    } catch (error) {
      migrationHandled.add(key);
      host.log.error('миграция карты: проверка не удалась', { projectPath: work.projectPath, workId, error: String(error) });
      return 'failed';
    }
  }

  /** Рассылка снимка после изменения записей вне `refresh`: как конец `refreshPass`, слушатели получают прежний снимок. */
  function announceSnapshot(previous: WorksSnapshot): WorksSnapshot {
    const snapshot = buildSnapshot();
    invalidateSnapshots();
    publish();
    for (const listener of listeners) listener(snapshot, previous);
    return snapshot;
  }

  async function migrationPass(retry: boolean): Promise<void> {
    const startedAt = performance.now();
    const tally = { migrated: 0, waiting: 0, failed: 0, skipped: 0 };
    let previous = buildSnapshot();
    let lastAnnounce = performance.now();
    let changed = false;
    for (const key of Array.from(entries.keys())) {
      if (stopped) break;
      if (retry) {
        const done = migrationWaiting.get(key);
        if (done === undefined || done >= MIGRATION_RETRIES) continue;
        migrationWaiting.set(key, done + 1);
      } else if (migrationHandled.has(key) || migrationWaiting.has(key)) continue;
      // Хост отвечает на другие запросы между работами, а не только на их собственных await.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const outcome = await migrateOne(key);
      if (outcome === 'gone') continue;
      if (outcome === 'waiting' && (migrationWaiting.get(key) ?? 0) >= MIGRATION_RETRIES) {
        migrationHandled.add(key);
        host.log.info('карта: сессия работы всё ещё жива, перевод на журналы отложен до следующего запуска хоста', { workId: key.split('\u0000')[1] });
      }
      tally[outcome] += 1;
      if (outcome === 'migrated' || outcome === 'waiting') changed = true;
      if (changed && performance.now() - lastAnnounce > MIGRATION_ANNOUNCE_MS) {
        previous = announceSnapshot(previous);
        lastAnnounce = performance.now();
        changed = false;
      }
    }
    if (changed) announceSnapshot(previous);
    const visited = tally.migrated + tally.waiting + tally.failed + tally.skipped;
    if (visited === 0) return;
    const ms = Math.round(performance.now() - startedAt);
    host.log.info(
      `карта: миграция завершена: переведено ${tally.migrated}, ждут конца сессий ${tally.waiting}, сбоев ${tally.failed}, без перевода ${tally.skipped}, ${ms} мс${retry ? ' (повтор)' : ''}`,
      { ...tally, ms, retry },
    );
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

  /** Работы списка, собранные из журналов, — те, чьи письма читаются хвостом. */
  function noteJournals(works: readonly WorkEntry[]): void {
    for (const work of works) {
      const key = workKey(work.projectPath, work.map.work.id);
      if (isJournalEntry(work)) journalWorks.add(key);
      else journalWorks.delete(key);
    }
  }

  /**
   * Запись работы с письмами и прочитанным, которые сервис уже учёл по хвосту, но которых нет в только что прочитанной с
   * диска карте: чтение могло начаться раньше, чем письмо легло в журнал, а закончиться позже, чем хвост его принял.
   */
  function overlayEntry(entry: WorkEntry): WorkEntry {
    const key = workKey(entry.projectPath, entry.map.work.id);
    if (!journalWorks.has(key)) return entry;
    const letters = recentLetters.get(key);
    const cursors = seenCursors.get(key);
    if (letters === undefined && cursors === undefined) return entry;
    let map = entry.map;
    if (letters !== undefined) {
      const known = new Set(map.messages.map((message) => message.id));
      const missing = letters.filter((letter) => !known.has(letter.id));
      if (missing.length > 0) map = appendLetters(map, missing, cursors);
    }
    for (const [sessionId, file] of cursors ?? []) map = applyCursors(map, sessionId, file);
    return map === entry.map ? entry : derivedEntry(entry, { map });
  }

  /** `true` — наблюдатель проекта заведён только что. */
  function ensureWatcher(projectPath: string): boolean {
    if (stopped || watchers.has(projectPath)) return false;
    const watcher = watchWorks(
      (works, seq, parsedBytes) => {
        // Разбор уже случился, даже если список ниже отбросим как устаревший. Считаются только карты, разобранные
        // этим чтением: неизменившиеся пришли из прежних записей без чтения.
        options.windowCounters?.mapsParsed(parsedBytes);
        // Наблюдателей несколько (дом и каждый проект), каждый читает список
        // сам, и медленное старое чтение одного может прийти позже свежего
        // чтения другого.
        if (seq < latestSeq) return;
        latestSeq = seq;
        // Второй наблюдатель того же события отдаёт тот же список (карты не изменились, общий разбор): обновлять нечего.
        const same = works.length === lastRaw.length && works.every((work, at) => work === lastRaw[at]);
        lastRaw = works;
        if (same) return;
        noteJournals(works);
        latest = works.map(overlayEntry);
        scheduleRefresh();
      },
      projectPath,
      {
        // Своя склейка на уровне сервиса (см. `scheduleRefresh`): у каждого
        // проекта — свой наблюдатель, и без debounce:0 здесь несколько
        // параллельных таймеров watchWorks независимо дребезжали бы одним
        // и тем же изменением индекса.
        debounceMs: 0,
        onError: (error) =>
          host.log.warn('наблюдение за работами: событие пропущено', { error: String(error) }),
        onChange: onFileChange,
        reuse: () => Array.from(entries.values()),
      },
    );
    watchers.set(projectPath, watcher);
    settler.schedule();
    return true;
  }

  // --- письма карты-журнала: хвост журнала и курсоры (задача 8 плана) ---

  function onFileChange(change: WorkFileChange): void {
    if (stopped) return;
    // Два события одного файла подряд — одна обработка: хвост всё равно читает до конца.
    pendingChanges.set(change.file, change);
    draining ??= drainChanges().finally(() => {
      draining = undefined;
    });
  }

  /** Изменения обрабатываются по одному: хвост журнала и карта работы не должны меняться двумя обработчиками разом. */
  async function drainChanges(): Promise<void> {
    while (!stopped) {
      const next = pendingChanges.entries().next();
      if (next.done === true) return;
      const [file, change] = next.value;
      pendingChanges.delete(file);
      try {
        if (journalWorks.has(workKey(change.projectPath, change.workId))) {
          if (change.kind === 'journal') await applyJournalChange(change);
          else await applyCursorChange(change);
        }
      } catch (error) {
        host.log.warn('письма: изменение файла не обработано', { file, error: String(error) });
      }
    }
  }

  const knownIds = (key: string, map: WorkEntry['map']): Set<string> => {
    const cached = knownIdsCache.get(key);
    if (cached?.map === map) return cached.ids;
    const ids = new Set(map.messages.map((message) => message.id));
    knownIdsCache.set(key, { map, ids });
    return ids;
  };

  function replaceEntry(key: string, next: WorkEntry): void {
    setEntry(key, next);
    latest = latest.map((work) => (workKey(work.projectPath, work.map.work.id) === key ? next : work));
  }

  /** Новая карта той же записи (дельта): список наблюдателя и `entries` вместе, чтобы очередной `refresh` её не откатил. */
  function replaceMap(key: string, entry: WorkEntry, map: WorkEntry['map'], addedIds: readonly string[] = []): void {
    const cached = knownIdsCache.get(key);
    if (cached?.map === entry.map) {
      for (const id of addedIds) cached.ids.add(id);
      cached.map = map;
    }
    replaceEntry(key, derivedEntry(entry, { map }));
  }

  /** Письмо, как его видит `rooms.mail`: и письмо журнала, и письмо собранной карты. */
  type Delivered = Pick<Message, 'id' | 'roomId' | 'from' | 'to' | 'kind' | 'at'>;

  /** Письма приняты картой: окнам и слушателям уходит `rooms.mail` — по событию на комнату, — а снимки для клиентов устаревают. */
  function announce(projectPath: string, workId: string, letters: readonly Delivered[]): void {
    if (letters.length === 0) return;
    invalidateSnapshots();
    const byRoom = new Map<string | null, Delivered[]>();
    for (const letter of letters) byRoom.set(letter.roomId, [...(byRoom.get(letter.roomId) ?? []), letter]);
    for (const [roomId, rows] of byRoom) {
      const mail: RoomMail = {
        projectPath,
        workId,
        roomId,
        appended: rows.map(({ id, from, to, kind, at }) => ({ id, from, to, kind, at })),
      };
      host.broadcast('rooms.mail', mail, wantsMail);
      for (const listener of mailListeners) listener(mail);
    }
    publishToWindowsWithoutMail();
  }

  /**
   * Письма, чьи комнаты в карте есть, встают в неё дельтой (те, что карта уже знает, — не повторно) и объявляются.
   * Комнаты нет — письмо ждёт в `parked`, пока индекс её не принесёт.
   */
  function takeLetters(key: string, entry: WorkEntry, letters: readonly JournalLetter[], announceKnown: boolean): void {
    const rooms = new Set(entry.map.rooms.map((room) => room.id));
    const ready = letters.filter((letter) => letter.roomId === null || rooms.has(letter.roomId));
    const waiting = letters.filter((letter) => !ready.includes(letter));
    if (waiting.length > 0) parked.set(key, [...(parked.get(key) ?? []), ...waiting].slice(-RECENT_LETTERS_KEPT));
    if (ready.length === 0) return;
    const known = knownIds(key, entry.map);
    const missing = ready.filter((letter) => !known.has(letter.id));
    if (missing.length > 0) {
      const map = appendLetters(entry.map, missing, seenCursors.get(key));
      if (map !== entry.map) replaceMap(key, entry, map, missing.map((letter) => letter.id));
      recentLetters.set(key, [...(recentLetters.get(key) ?? []), ...missing].slice(-RECENT_LETTERS_KEPT));
    }
    announce(entry.projectPath, entry.map.work.id, announceKnown ? ready : missing);
  }

  /**
   * После `refresh`: комната, которой не было, когда пришло письмо, теперь есть (сборщик прочёл журнал сам, письмо уже в
   * карте) — письмо объявляется, как объявилось бы дельтой: будильнику и окну оно нужно в любом случае.
   */
  function releaseParked(): void {
    for (const [key, letters] of Array.from(parked)) {
      const entry = entries.get(key);
      if (entry === undefined) {
        parked.delete(key);
        continue;
      }
      const rooms = new Set(entry.map.rooms.map((room) => room.id));
      const waiting = letters.filter((letter) => letter.roomId !== null && !rooms.has(letter.roomId));
      if (waiting.length === 0) parked.delete(key);
      else parked.set(key, waiting);
      const ready = letters.filter((letter) => !waiting.includes(letter));
      if (ready.length > 0) takeLetters(key, entry, ready, true);
    }
  }

  /**
   * Журнал убрали, усекли или заменили (или хвост не сошёлся с картой): дельтой не обойтись, работа собирается с диска заново
   * и объявляется обычным обновлением. Письма, которые сервис помнил по старому журналу, больше не действуют. Письма, которых
   * в прежней карте не было, объявляются как `rooms.mail`: к тому времени карта в `entries` уже новая, и разницы с прежней у
   * следующего `refresh` не будет (его `previous` снимается с `entries`), так что без этого будильник и активность их не увидели бы.
   */
  async function reseed(key: string, projectPath: string, workId: string, tail?: JournalTail): Promise<void> {
    const before = entries.get(key);
    const fresh = await readWorkEntry(projectPath, workId, undefined, { share: false });
    if (fresh === null || stopped) return;
    options.windowCounters?.mapsParsed(fresh.bytes ?? 0);
    recentLetters.delete(key);
    knownIdsCache.delete(key);
    // Хвост начинает заново: прежняя позиция относилась к журналу, которого больше нет (или к окну, не сошедшемуся с картой).
    tail?.forget();
    if (isJournalEntry(fresh)) journalWorks.add(key);
    else journalWorks.delete(key);
    replaceEntry(key, overlayEntry(fresh));
    const appeared = entries.get(key);
    if (before !== undefined && appeared !== undefined) {
      const had = new Set(before.map.messages.map((message) => message.id));
      announce(projectPath, workId, appeared.map.messages.filter((message) => !had.has(message.id)));
    }
    scheduleRefresh();
  }

  async function applyJournalChange(change: Extract<WorkFileChange, { kind: 'journal' }>): Promise<void> {
    const { projectPath, workId, file } = change;
    const key = workKey(projectPath, workId);
    let held = tails.get(file);
    if (held === undefined) {
      held = { tail: createJournalTail(file, { warn: (message) => host.log.warn(message) }), key };
      tails.set(file, held);
    }
    const { tail } = held;
    const read = await tail.read();
    options.windowCounters?.journalBytes(read.bytes);
    const entry = entries.get(key);
    if (entry === undefined || stopped) return;
    if (read.reset) return reseed(key, projectPath, workId, tail);
    const known = knownIds(key, entry.map);
    // Первое чтение большого журнала началось с середины: если в окне нет ни одного письма, которое карта уже знает, между
    // собранной картой и окном могли остаться пропущенные письма.
    if (read.partial && !read.letters.some((letter) => known.has(letter.id))) return reseed(key, projectPath, workId, tail);
    takeLetters(
      key,
      entry,
      read.letters.filter((letter) => !known.has(letter.id)),
      false,
    );
  }

  /**
   * Дочитывание журналов (потерянное событие наблюдателя, `watch-settle.ts`): письмо, о котором событие не пришло, лежит в
   * журнале, а записи списка переиспользуются, пока индекс тот же. На каждый журнал известной работы — один `stat`; читается
   * он, только если размер или файл изменились с прошлого чтения. Журнал, который ещё не читали, читается первый раз
   * (окно хвоста, не больше 256 КиБ), и дальше он на учёте. Чтение идёт через ту же очередь, что и события наблюдателя.
   */
  async function catchUpJournals(): Promise<void> {
    if (stopped) return;
    const stale: WorkFileChange[] = [];
    for (const key of journalWorks) {
      const entry = entries.get(key);
      if (entry === undefined) continue;
      const workId = entry.map.work.id;
      const paths = workPaths(entry.projectPath, workId);
      const rooms: Array<string | null> = [null, ...entry.map.rooms.map((room) => room.id)];
      await Promise.all(
        rooms.map(async (roomId) => {
          const file = roomId === null ? paths.direct : path.join(paths.rooms, roomId, 'messages.jsonl');
          const held = tails.get(file);
          if (held !== undefined && !(await held.tail.changed())) return;
          stale.push({ kind: 'journal', projectPath: entry.projectPath, workId, roomId, file });
        }),
      );
    }
    if (stale.length === 0 || stopped) return;
    for (const change of stale) onFileChange(change);
    await draining;
  }

  /** Курсор сессии: файл маленький, читается целиком; `readBy` в карте пересчитывается на месте и без события (спека B4). */
  async function applyCursorChange(change: Extract<WorkFileChange, { kind: 'cursor' }>): Promise<void> {
    const { projectPath, workId, sessionId } = change;
    const key = workKey(projectPath, workId);
    const file = await readCursorFile(projectPath, workId, sessionId, { warn: (message) => host.log.warn(message) });
    const seen = seenCursors.get(key) ?? new Map<string, CursorFile>();
    seen.set(sessionId, file);
    seenCursors.set(key, seen);
    const entry = entries.get(key);
    if (entry === undefined || stopped) return;
    const map = applyCursors(entry.map, sessionId, file);
    if (map !== entry.map) {
      replaceMap(key, entry, map);
      invalidateSnapshots();
    }
  }

  /**
   * Дочитывание после включения наблюдателя (`watch-settle`): запись карты, попавшая в окно между созданием
   * наблюдателя и его реальным включением, не приходит событием никогда. Список перечитывается заново, и
   * если он отличается от последнего полученного, идёт обычное обновление; без отличий — ничего.
   */
  async function settleRead(): Promise<void> {
    if (stopped) return;
    await catchUpJournals();
    const seq = latestSeq;
    const fresh = await readWorks(parleyHome()).catch(() => null);
    if (fresh !== null) countParsed(fresh);
    // Пока читали, пришло событие наблюдателя: его чтение свежее нашего, следующая пауза сверит ещё раз.
    if (stopped || fresh === null || seq !== latestSeq) return;
    if (JSON.stringify(fresh) === JSON.stringify(latest)) return;
    latest = fresh;
    scheduleRefresh();
  }

  const settler = createSettler(() => void settleRead());

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

  /**
   * Карты проекта, чей наблюдатель заведён только что, перечитываются (fix-tests2): список
   * пришёл от наблюдателя дома, а `updateMap` пишет индекс раньше карты — запись карты,
   * сделанная до наблюдателя проекта, иначе не видна никому (первая сессия нового проекта
   * оставалась pending в снимке). Всё, что запишут после, увидит уже сам наблюдатель.
   */
  async function rereadNewlyWatched(
    works: readonly WorkEntry[],
    projects: ReadonlySet<string>,
  ): Promise<void> {
    if (projects.size === 0) return;
    for (const work of works) {
      if (!projects.has(work.projectPath)) continue;
      try {
        const fresh = await readMap(work.projectPath, work.map.work.id);
        setEntry(
          workKey(work.projectPath, work.map.work.id),
          overlayEntry({
            projectPath: work.projectPath,
            map: fresh,
          }),
        );
      } catch {
        // Карту удалили или переписывают — следующее чтение наблюдателя разберётся.
      }
    }
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

    // `works` — уже полный список: `readWorks` каждый раз перечитывает весь
    // глобальный индекс заново, а не только изменившийся проект, поэтому карту
    // сервиса можно просто заменить целиком, слитую по ключу `projectPath+workId`.
    const seenKeys = new Set<string>();
    const newlyWatched = new Set<string>();
    entries.clear();
    for (const work of works) {
      const key = workKey(work.projectPath, work.map.work.id);
      setEntry(key, work);
      seenKeys.add(key);
      if (isJournalEntry(work)) journalWorks.add(key);
      else journalWorks.delete(key);
      if (ensureWatcher(work.projectPath)) newlyWatched.add(work.projectPath);
    }
    await rereadNewlyWatched(works, newlyWatched);

    const projects = new Set(works.map((work) => work.projectPath));
    await Promise.all(
      Array.from(projects).map(async (projectPath) => {
        branches.set(projectPath, await gitBranch(projectPath));
      }),
    );
    for (const projectPath of Array.from(branches.keys())) {
      if (!projects.has(projectPath)) branches.delete(projectPath);
    }

    // Работы, которых в списке больше нет, забываются вместе с тем, что о них помнил хвост.
    for (const key of Array.from(journalWorks)) if (!seenKeys.has(key)) journalWorks.delete(key);
    for (const map of [recentLetters, seenCursors, knownIdsCache, parked]) for (const key of Array.from(map.keys())) if (!seenKeys.has(key)) map.delete(key);
    for (const [file, held] of Array.from(tails)) if (!seenKeys.has(held.key)) tails.delete(file);

    await reconcileLiveness(works);
    await checkCorruption(seenKeys);
    for (const work of works) await leaseWork(work);

    releaseParked();
    const snapshot = buildSnapshot();
    invalidateSnapshots();
    publish();
    for (const listener of listeners) listener(snapshot, previous);
    for (const key of seenKeys) readAlready.add(key);
    await catchUpJournals();
    // Миграция карт — после рассылки снимка и без ожидания: окно не ждёт перевода всех карт.
    scheduleMigration();
  }

  return {
    async start() {
      ownLease = {
        pid: process.pid,
        startedAtProcess: await processStartedAt(process.pid),
        since: new Date().toISOString(),
      };

      // Наблюдатель за `parleyHome()` ловит появление новых проектов в
      // глобальном индексе, даже если на старте их ещё ни одного нет.
      ensureWatcher(parleyHome());
      const index = await readWorksIndex().catch(() => ({ schemaVersion: 1 as const, works: [] }));
      for (const item of index.works) ensureWatcher(item.projectPath);

      const initial = await readWorks(parleyHome());
      countParsed(initial);
      // Наблюдатель успел отдать своё чтение, пока шло это, — его и берём:
      // номер у начального чтения не спросить, а следующее событие всё равно
      // перечитает список.
      if (latestSeq === 0) {
        latest = initial;
        lastRaw = initial;
      }
      await requestRefresh();
    },
    snapshot: buildSnapshot,
    windowSnapshot,
    legacySnapshot,
    entry: (projectPath, workId) => entries.get(workKey(projectPath, workId)),
    onMail(listener) {
      mailListeners.add(listener);
      return () => mailListeners.delete(listener);
    },
    firstReadDone: (projectPath, workId) => readAlready.has(workKey(projectPath, workId)),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async migrationSettled() {
      while (migrationRun !== undefined) await migrationRun;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      // Работа, которую проход уже начал, доводится: аренды снимаются после неё, а не под её ногами.
      await migrationRun;
      settler.cancel();
      pendingChanges.clear();
      tails.clear();
      parked.clear();
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();

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
