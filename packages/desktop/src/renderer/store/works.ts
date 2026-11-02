/**
 * Список работ: legacy — `works.list`/`works.changed`; opt-in sync — bounded batches
 * и атомарный commit общего reducer. Production activation остаётся отдельной задачей P4/P7.
 *
 * Снимок компактный (P35): письма комнаты — хвостом, старше — страницами (`addMessages`). Снимок несёт номер
 * `revision`, и применяется только новее уже применённого: поздно пришедший ответ `works.list` не откатывает
 * свежее событие. Номер считается от подключения — после переподключения (новый `init`) отсчёт начинается заново,
 * хост мог быть другим процессом. Письма, что окно уже показывало, остаются в новом снимке (`keepHeld`): у хоста с
 * признаком `rooms-mail` снимок писем не несёт, и окно переносит свои, у прежнего хоста — тех, что ушли из хвоста.
 *
 * Письма и отметки прочтения приходят событием `rooms.mail` (спека rooms.mail 6.3-6.5), если хост объявил признак
 * `rooms-mail`: без него события нет, и окно живёт по `works.changed`, как прежде. Окно помнит версию каждой работы —
 * из снимка и из последнего применённого события — и сверяет с ней версии события. Версия события не больше версии окна —
 * это повтор или обогнавший событие снимок: письма сливаются, а числа не трогаются, но `reread` комнат и отставание их верха
 * дочитываются и у такого события (его комнаты урезаны потолком кадра, а снимок писем не несёт). Открытая комната (или Mail),
 * что до события ничего не держала, при `reread` дочитывается и на пути разрыва: склеенное или урезанное событие кладёт в неё
 * одни письма человеку, и дыра между ними иначе не закрылась бы. Читается она вниз от вершины до наименьшего из этих писем
 * (`rereadRoom`: пачка урезанной комнаты — больше страницы), а если событие письма не положило — последней страницей, как при
 * открытии. Снимок старее версии окна
 * структуру берёт, а числа и кандидатов в упоминания оставляет от события. `prevVersion` не больше версии окна —
 * событие применяется: спека говорит «не равной», но смысл тот же — окно что-то упустило, только если событие начинается
 * после того, что оно держит, а пачка смешанной записи хоста держит `prevVersion` первой записи, пока в неё вливаются
 * следующие, и снимок мог выйти внутри неё (событие несёт письма и отметки всего `(prevVersion, version]`). `prevVersion`
 * больше версии окна, а равно и неизвестная версия — разрыв: держимые письма перечитываются (`repairWork`), по одной починке
 * на работу, после сбоя — с отступом. Событие про комнату, которой нет в снимке, ждёт снимка этой работы: структура
 * смешанной записи может прийти позже события. Версии держатся на одно подключение: после переподключения (новый `init`)
 * первый снимок чинит каждую работу со снимком без писем, у которой окно ещё держит письма (открытые комнаты и Mail), —
 * одна починка по тому же пути, письма, написанные при обрыве связи, иначе не появились бы до следующего события комнаты.
 */

import { create } from 'zustand';
import type { Message, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE, WorksSyncReducer, WorksMailStateAssembler, type WorksMailState, type WorksSyncSurfaceStatus, type RoomsMailEvent, type WorksSnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError, encodeIpcError } from '../../shared/ipc-error.js';
import { hostFeatures } from '../lib/capabilities.js';
import { heldRanges, keepHeld, withMail, withMessages } from '../lib/window-merge.js';
import { invalidateWorkPages, followRoom, heldPolicy, openRoom, repairWork, rereadRoom, retireWorkPages, stopOpenRetries } from './room-pages.js';

export { WINDOW_ROOM_KEEP, keepHeld } from '../lib/window-merge.js';

/** Отказ `works.list`: код протокола и причина хоста (`works-unreadable`, раунд lane-r5). */
export interface WorksLoadError {
  code: string;
  reason: string | null;
}

export interface WorksState {
  entries: WindowWorkEntry[];
  branches: Record<string, string | null>;
  /** Снимка работ ещё нет: `works.list` не ответил или отказал. */
  loading: boolean;
  /**
   * Хост ответил на `works.list`: снимок работ дочитан и сверен (ворота `worksReady`), методы снимка больше не ждут.
   * Рассылка `works.changed` приходит и до ворот, поэтому `loading: false` готовности хоста не означает.
   */
  ready: boolean;
  error: WorksLoadError | null;
  /** Подписывается на бридж и один раз запрашивает `works.list`; возвращает отписку. */
  init: (bridge: Pick<ParleyBridge, 'call' | 'on' | 'onStatus'> & Partial<Pick<ParleyBridge, 'worksSync'>>, options?: { sync?: boolean }) => () => void;
  syncStatus: WorksSyncSurfaceStatus | null;
  retrySync: () => void;
  /** Потерянное звено очереди требует authoritative mail repair после коммита. */
  mailRepairPending: number;
  mailRepairFailed: boolean;
  /** Письма, пришедшие страницей (`context.messages`), встают в карту работы по номеру. */
  addMessages: (projectPath: string, workId: string, messages: readonly Message[]) => void;
  /**
   * Слушатель событий `rooms.mail`: зовётся после того, как событие применено к стору, — в том числе событие, которое
   * ждало снимка, и повтор, обогнанный снимком. Событие, выброшенное целиком (комнаты нет в снимке), слушателей не будит.
   * Слушатель живёт, пока его не сняли: переподключение `init` его не сбрасывает. Возвращает отписку.
   */
  onMail: (listener: (event: RoomsMailEvent) => void) => () => void;
}

/** Слушатели `onMail`: общие для всех `init`, чтобы уведомления и очередь отправки не подписывались заново на каждое подключение. */
const mailListeners = new Set<(event: RoomsMailEvent) => void>();

/** Событий одной работы, ждущих снимка, и работ с такими событиями не больше: потерянное звено цепочки окно чинит как разрыв версии. */
const WAITING_EVENTS_MAX = 32;
const WAITING_WORKS_MAX = 16;

/** Отступ после сбоя починки работы: первый, удвоение за каждый сбой подряд, потолок. Успешная починка счёт обнуляет. */
const REPAIR_BACKOFF_MS = 1000;
const REPAIR_BACKOFF_MAX_MS = 30_000;
const MAIL_REPAIR_CONCURRENCY = 1;

/** Починки одной работы (`init`): одна в пути, остальные разрывы помнятся флагом, после сбоя — отступ. */
interface RepairState {
  /** `repairWork` в пути. */
  running: boolean;
  /** Пока он шёл или длился отступ, пришёл ещё разрыв: после — одна починка по тогдашней карте. */
  again: boolean;
  /** Сбоев подряд. */
  failures: number;
  /** Отступ после сбоя: до его конца новая починка не стартует. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface MailRepairState {
  running: boolean;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  captured?: WorksMailState;
}

const mailKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

function notifyMail(event: RoomsMailEvent): void {
  // Событие без комнат и без `droppedRooms` — выброшенное целиком: сообщать слушателям нечего.
  if (event.rooms.length === 0 && event.droppedRooms.length === 0) return;
  for (const listener of [...mailListeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[parley] rooms.mail listener', error);
    }
  }
}

export const useWorksStore = create<WorksState>((set, get) => ({
  addMessages: (projectPath, workId, messages) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.projectPath === projectPath && entry.map.work.id === workId ? withMessages(entry, messages) : entry,
      ),
    })),
  onMail: (listener) => {
    mailListeners.add(listener);
    return () => {
      mailListeners.delete(listener);
    };
  },
  entries: [],
  branches: {},
  loading: true,
  ready: false,
  error: null,
  syncStatus: null,
  retrySync: () => {},
  mailRepairPending: 0,
  mailRepairFailed: false,
  init: (bridge, options = {}) => {
    const sync = options.sync === true;
    const surface = sync ? bridge.worksSync : undefined;
    if (sync && surface === undefined) throw new Error('works sync bridge unavailable');
    const reducer = new WorksSyncReducer();
    let consumerFailed = false;
    let disposed = false;
    let applied = -1;
    /**
     * Версия каждой работы, которой располагает окно: из снимка (`max`) и из последнего применённого события. Нет записи —
     * окно не знает, чем располагает (снимок без версии, сбой починки), и первое событие считает разрывом: безопасный путь,
     * цена — одна лишняя починка.
     */
    const held = new Map<string, number>();
    // Покрытие структуры берётся только из committed entry.version, никогда из писем/глобальной revision.
    const structural = new Map<string, number>();
    const lives = new Map<string, object>();
    const appliedMail = new Map<string, number>();
    const openRepairs = new Map<string, Set<{ failed: boolean; retry(): void }>>();
    const mailFloors = new Map<string, number>();
    const sourceEntries = new Map<string, WindowWorkEntry>();
    const mailRepairs = new Map<string, MailRepairState>();
    let mailRunning = 0;
    let mailConnectionFailed = false;
    const knownMail = (key: string): number | undefined => {
      const version = Math.max(held.get(key) ?? -1, sync ? appliedMail.get(key) ?? -1 : -1);
      return version < 0 ? undefined : version;
    };
    let acceptingMail = !sync;
    const repairAfterCommit = new Set<string>();
    let repairAllAfterCommit = false;
    const rangePending = (state: RepairState): boolean => state.running || state.again || state.timer !== null;
    const pendingRepairs = (): number => {
      const keys = new Set([...repairAfterCommit, ...openRepairs.keys()]);
      if (sync) for (const [key, state] of repairs) if (lives.has(key) && rangePending(state)) keys.add(key);
      return keys.size + Number(repairAllAfterCommit);
    };
    const publishRepairs = (): void => {
      if (pendingRepairs() === 0) mailConnectionFailed = false;
      if (!disposed) set({ mailRepairPending: pendingRepairs(),
        mailRepairFailed: pendingRepairs() > 0 && (mailConnectionFailed || [...mailRepairs.values()].some(state => state.failures > 0)
          || [...openRepairs.values()].some(jobs => [...jobs].some(job => job.failed))
          || (sync && [...repairs.values()].some(state => state.failures > 0 && rangePending(state)))) });
    };
    const markRepair = (key: string, minimum?: number): void => {
      // Неограниченный поток неизвестных work IDs не расширяет память сверх committed карты.
      if (lives.has(key)) {
        repairAfterCommit.add(key);
        if (minimum !== undefined) mailFloors.set(key, Math.max(mailFloors.get(key) ?? 0, minimum));
      }
      else repairAllAfterCommit = true;
      publishRepairs();
      pumpMail();
    };
    /** События, что ждут снимка своей работы (или комнаты в нём), в порядке прихода: следующее не обгоняет первое. */
    const waiting = new Map<string, RoomsMailEvent[]>();
    const repairs = new Map<string, RepairState>();
    // Новое подключение — возможно, к только что запущенному хосту: готовность считается заново.
    set({ ready: false, ...(sync ? { loading: true } : {}), syncStatus: null, mailRepairPending: 0, mailRepairFailed: false, retrySync: () => {} });

    const guardedBridge = (entry: WindowWorkEntry): Pick<ParleyBridge, 'call'> => {
      const key = mailKey(entry.projectPath, entry.map.work.id);
      const life = lives.get(key);
      const alive = (): boolean => !disposed && life !== undefined && lives.get(key) === life;
      const expired = (): Error => encodeIpcError({ code: 'not_found', message: 'work lifetime ended' });
      return { call: async (method, params) => {
        if (!alive()) throw expired();
        try {
          const result = await bridge.call(method, params);
          if (!alive()) throw expired();
          return result;
        } catch (error) {
          if (!alive()) throw expired();
          throw error;
        }
      } };
    };
    const forget = (key: string): void => {
      const [projectPath, workId] = key.split('\u0000');
      if (projectPath !== undefined && workId !== undefined) retireWorkPages(projectPath, workId);
      held.delete(key);
      appliedMail.delete(key);
      mailFloors.delete(key);
      sourceEntries.delete(key);
      const mailRepair = mailRepairs.get(key);
      if (mailRepair?.timer) clearTimeout(mailRepair.timer);
      mailRepairs.delete(key);
      structural.delete(key);
      lives.delete(key);
      openRepairs.delete(key);
      waiting.delete(key);
      repairAfterCommit.delete(key);
      const repair = repairs.get(key);
      if (repair?.timer) clearTimeout(repair.timer);
      repairs.delete(key);
    };

    const find = (key: string): WindowWorkEntry | undefined =>
      get().entries.find((entry) => mailKey(entry.projectPath, entry.map.work.id) === key);

    const cancelMail = (): void => {
      for (const state of mailRepairs.values()) if (state.timer) clearTimeout(state.timer);
      mailRepairs.clear();
    };
    const abandonReads = (): void => {
      acceptingMail = false;
      structural.clear();
      lives.clear();
      openRepairs.clear();
      cancelMail();
      for (const state of repairs.values()) if (state.timer) clearTimeout(state.timer);
      repairs.clear();
      set({ ready: false });
    };
    const retryMail = (key: string, state: MailRepairState): void => {
      if (disposed || mailRepairs.get(key) !== state || state.timer !== null) return;
      state.failures += 1;
      publishRepairs();
      state.timer = setTimeout(() => {
        state.timer = null;
        pumpMail();
      }, Math.min(REPAIR_BACKOFF_MS * 2 ** Math.min(state.failures - 1, 5), REPAIR_BACKOFF_MAX_MS));
    };
    const publishMail = (key: string, state: MailRepairState): boolean => {
      const value = state.captured;
      if (value === undefined) return false;
      const coverage = structural.get(key);
      if (coverage === undefined || coverage < value.requiredStructuralVersion) return false;
      if (value.sourceVersion < Math.max(knownMail(key) ?? 0, mailFloors.get(key) ?? 0)) {
        delete state.captured;
        retryMail(key, state);
        return false;
      }
      if (state.timer) clearTimeout(state.timer);
      held.set(key, value.sourceVersion);
      appliedMail.set(key, value.sourceVersion);
      repairAfterCommit.delete(key);
      mailFloors.delete(key);
      mailRepairs.delete(key);
      set(current => ({ entries: current.entries.map(entry => {
        if (mailKey(entry.projectPath, entry.map.work.id) !== key) return entry;
        const prior = entry.map.compact;
        return { ...entry, map: { ...entry.map, compact: { version: 2,
          cut: prior?.cut ?? [], omitted: prior?.omitted ?? {}, ...value.mail } } };
      }) }));
      publishRepairs();
      return true;
    };
    function pumpMail(): void {
      if (!sync || disposed || !acceptingMail || consumerFailed) return;
      for (const key of repairAfterCommit) {
        const entry = find(key);
        const life = lives.get(key);
        const epoch = reducer.view.epoch;
        if (entry === undefined || life === undefined || epoch === null) continue;
        let state = mailRepairs.get(key);
        if (state === undefined) {
          state = { running: false, failures: 0, timer: null };
          mailRepairs.set(key, state);
        }
        if (state.running) continue;
        if (state.captured !== undefined) {
          if (!publishMail(key, state) && state.captured !== undefined) retryMail(key, state);
          continue;
        }
        if (state.timer !== null || mailRunning >= MAIL_REPAIR_CONCURRENCY) continue;
        const job = state;
        const alive = (): boolean => !disposed && lives.get(key) === life && mailRepairs.get(key) === job && reducer.view.epoch === epoch;
        job.running = true;
        mailRunning += 1;
        void (async () => {
          const workKey = { projectPath: entry.projectPath, workId: entry.map.work.id };
          const assembler = new WorksMailStateAssembler({ epoch, key: workKey });
          let cursor: string | undefined;
          while (alive()) {
            const result = await bridge.call('works.mailState', { ...workKey, ...(cursor === undefined ? {} : { cursor }) });
            if (!alive()) return;
            if (result.kind === 'mail-unavailable') throw new Error(`mail state unavailable: ${result.reason}`);
            const outcome = assembler.applyPage(result);
            if (outcome.state === 'rejected') throw new Error(outcome.reason);
            if (outcome.state === 'committed') {
              job.captured = outcome.value;
              if (!publishMail(key, job) && job.captured !== undefined) retryMail(key, job);
              return;
            }
            cursor = result.next ?? undefined;
          }
        })().catch(() => { if (alive()) retryMail(key, job); }).finally(() => {
          job.running = false;
          mailRunning -= 1;
          pumpMail();
        });
      }
    }

    /**
     * Что делать с событием при данной карте работы: комнаты на месте — применить как есть; комнаты нет, а снимок не
     * старее события — её удалила та же запись, события про неё выбрасываются (применяется остальное); иначе структура
     * ещё в пути — `null`, ждать снимка (спека rooms.mail 6.5).
     */
    const place = (entry: WindowWorkEntry, event: RoomsMailEvent, key: string): RoomsMailEvent | null => {
      if (event.requiredStructuralVersion !== undefined) {
        const covered = structural.get(key);
        if (covered === undefined || covered < event.requiredStructuralVersion) return null;
      }
      const known = new Set(entry.map.rooms.map((room) => room.id));
      const present = event.rooms.filter((room) => room.roomId === null || known.has(room.roomId));
      if (present.length === event.rooms.length) return event;
      const version = structural.get(key);
      return version !== undefined && version >= (event.requiredStructuralVersion ?? event.version) ? { ...event, rooms: present } : null;
    };

    const repairOf = (key: string): RepairState => {
      let state = repairs.get(key);
      if (state === undefined) {
        state = { running: false, again: false, failures: 0, timer: null };
        repairs.set(key, state);
      }
      return state;
    };

    /**
     * Чтение не удалось — даже если после его начала применилось ещё событие: окно не знает, чем располагает, и следующее
     * событие станет разрывом. Новая починка этой работы начнётся не раньше конца отступа.
     */
    const failed = (key: string, error: unknown): void => {
      if (disposed) return;
      console.warn('[parley] rooms.mail repair', error);
      held.delete(key);
      const state = repairOf(key);
      state.failures += 1;
      if (sync && (find(key)?.map.messages.length ?? 0) > 0) state.again = true;
      if (state.timer !== null) clearTimeout(state.timer);
      const delay = Math.min(REPAIR_BACKOFF_MS * 2 ** (state.failures - 1), REPAIR_BACKOFF_MAX_MS);
      state.timer = setTimeout(() => {
        state.timer = null;
        pump(key);
        publishRepairs();
      }, delay);
      publishRepairs();
    };

    /**
     * Запускает починку работы, если есть разрыв, она не идёт и отступа нет: одну на все накопившиеся разрывы. Разрыв, что
     * стартует сразу, читает карту до своего события (`from`: комнату, которой окно не держало, оно не читает, а её письма
     * из события уже в карте); отложенная — карту, какая есть к её старту.
     */
    const pump = (key: string, from?: WindowWorkEntry): void => {
      const state = repairs.get(key);
      if (disposed || state === undefined || !state.again || state.running || state.timer !== null) return;
      state.again = false;
      const entry = from ?? find(key);
      if (entry === undefined) return;
      state.running = true;
      publishRepairs();
      repairWork(guardedBridge(entry), entry)
        .then(
          () => {
            state.failures = 0;
          },
          (error: unknown) => failed(key, error),
        )
        .finally(() => {
          state.running = false;
          pump(key);
          publishRepairs();
        });
    };

    /**
     * Применяет событие к карте работы по правилам версии (6.5) и запускает дочитывание, если оно нужно. `before` — карта до
     * применения. Разрыв — только версия, которой окно не покрывает: событие начинается позже держимой (`prevVersion > held`)
     * или версия неизвестна. Спека 6.5 говорит «`prevVersion` не равна `held`», но «больше» — тот же смысл: окно пропускает
     * что-то лишь тогда, когда событие начинается после того, что оно держит; при `prevVersion <= held < version` оно
     * получило начало пачки снимком, а событие несёт всё остальное.
     */
    const deliver = (before: WindowWorkEntry, event: RoomsMailEvent): void => {
      const key = mailKey(event.projectPath, event.workId);
      const version = held.get(key);
      const latest = knownMail(key);
      // Версия события не больше версии окна: повтор или обогнавший событие снимок — письма и отметки сливаются, числа не трогаются.
      const stale = latest !== undefined && event.version <= latest;
      // Разрыв — событие начинается после держимой версии или версия неизвестна; `prevVersion <= version < event.version` — пачка
      // смешанной записи, начатая до снимка, пропущенного нет (подробнее — в описании `deliver`).
      const gap = !stale && (version === undefined || event.prevVersion > version);
      // Версия сошлась, но верх держимой комнаты ниже `prevTop` (письма между ними потерялись) или комната помечена `reread`.
      // Это и у устаревшего события: событие смешанной записи приходит после снимка своей версии, и урезанные потолком
      // кадра или склеенные для медленного окна комнаты несут `reread` без писем — дочитать их, кроме как здесь, некому.
      // Открытая комната без держимых писем (`opening`): событие положит в неё только письма человека, а чтение страницы открытия
      // панель больше не повторяет, — дыру между ними закрывает только эта комната. Нужна и на пути разрыва: починка читает карту
      // до события, а в ней открытой пустой комнаты нет.
      const policy = heldPolicy(event.projectPath, event.workId);
      const ranges = heldRanges(before);
      const lagging: Array<string | null> = [];
      const rereading: Array<string | null> = [];
      const opening: Array<string | null> = [];
      for (const room of event.rooms) {
        const range = ranges.get(room.roomId);
        if (range === undefined) {
          if (room.reread === true && policy.isOpen(room.roomId)) opening.push(room.roomId);
          continue;
        }
        // Держимое при разрыве перечитывает `repairWork`.
        if (gap) continue;
        if (room.reread === true) rereading.push(room.roomId);
        else if (range.max < room.prevTop) lagging.push(room.roomId);
      }

      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.projectPath === event.projectPath && entry.map.work.id === event.workId ? withMail(entry, event, stale, policy.isOpen, policy.floor) : entry,
        ),
      }));
      if (!stale) { held.set(key, event.version); if (sync) appliedMail.set(key, event.version); }
      notifyMail(event);

      if (sync && (gap || event.rooms.some(room => room.reread))) markRepair(key, event.version);
      if (gap) {
        repairOf(key).again = true;
        pump(key, before);
      }
      if (lagging.length === 0 && rereading.length === 0 && opening.length === 0) return;
      // Открытая пустая комната теперь держит письма человека из события: читается вниз до наименьшего из них, и пачка больше
      // страницы закрывается целиком (в пределах `MAIL_PAGES_MAX`). Не держит ничего (событие писем ей не положило) — страница открытия.
      const current = find(key);
      const after = current === undefined ? undefined : heldRanges(current);
      Promise.all([
        ...lagging.map((roomId) => followRoom(guardedBridge(before), before, roomId)),
        ...rereading.map((roomId) => rereadRoom(guardedBridge(before), before, roomId)),
        ...opening.map((roomId) => (current !== undefined && after?.has(roomId) === true ? rereadRoom(guardedBridge(current), current, roomId) : openRoom(guardedBridge(before), before, roomId))),
      ]).catch((error: unknown) => failed(key, error));
    };

    const enqueue = (key: string, event: RoomsMailEvent): void => {
      const queue = waiting.get(key) ?? [];
      queue.push(event);
      if (queue.length > WAITING_EVENTS_MAX) { queue.shift(); markRepair(key, event.version); }
      waiting.set(key, queue);
      if (waiting.size > WAITING_WORKS_MAX) {
        const evicted = waiting.keys().next().value!;
        const lost = waiting.get(evicted)!;
        waiting.delete(evicted);
        markRepair(evicted, Math.max(...lost.map(event => event.version)));
      }
    };

    /** После снимка: ждущие события работ, которые теперь в карте, применяются по порядку; ждать дальше — только тем, что снимок не покрыл. */
    const drain = (): void => {
      for (const [key, queue] of [...waiting]) {
        for (let event = queue[0]; event !== undefined; event = queue[0]) {
          const entry = find(key);
          if (entry === undefined) break;
          const placed = place(entry, event, key);
          if (placed === null) break;
          queue.shift();
          deliver(entry, placed);
        }
        if (queue.length === 0) waiting.delete(key);
      }
    };

    const handleMail = (event: RoomsMailEvent): void => {
      if (disposed) return;
      const key = mailKey(event.projectPath, event.workId);
      const entry = find(key);
      if (acceptingMail && entry !== undefined && !waiting.has(key)) {
        const placed = place(entry, event, key);
        if (placed !== null) {
          deliver(entry, placed);
          return;
        }
      }
      enqueue(key, event);
    };

    /** Первый применённый снимок этого подключения: держимые письма стоят от прошлого подключения, и чинить их надо один раз. */
    let first = true;

    /**
     * После первого снимка нового подключения: каждая работа со снимком без писем, у которой окно держит письма, чинится
     * через ту же одиночную починку, что и разрыв версии (`again`, `pump`). Работа, которой уже чинит разрыв, из событий,
     * что ждали снимка, лишней починки не получает: та починка читает то же держимое.
     */
    const repairOpen = (entry: WindowWorkEntry, roomId: string | null): void => {
      const key = mailKey(entry.projectPath, entry.map.work.id);
      const life = lives.get(key);
      if (life === undefined) return;
      const jobs = openRepairs.get(key) ?? new Set<{ failed: boolean; retry(): void }>();
      const job = { failed: false, retry: () => { void read(); } };
      jobs.add(job);
      openRepairs.set(key, jobs);
      const alive = (): boolean => !disposed && lives.get(key) === life && openRepairs.get(key) === jobs;
      const guarded = guardedBridge(entry);
      let requested = false;
      const finish = (): void => {
        if (openRepairs.get(key) === jobs) {
          jobs.delete(job);
          if (jobs.size === 0) openRepairs.delete(key);
        }
        publishRepairs();
      };
      const tracked: Pick<ParleyBridge, 'call'> = { call: async (method, params) => {
        requested = true;
        try {
          const result = await guarded.call(method, params);
          finish();
          return result;
        } catch (error) {
          if (alive()) {
            if (decodeIpcError(error).code === 'not_found') finish();
            else { job.failed = true; publishRepairs(); }
          }
          throw error;
        }
      } };
      const read = async (): Promise<void> => {
        const current = find(key);
        if (!alive() || current === undefined) return;
        try {
          await openRoom(tracked, current, roomId);
          // openRoom мог вернуть opening старой жизни, не вызвав наш bridge. Его guarded
          // ответ отброшен; после удаления старого opening нужен собственный свежий read.
          if (!alive() || requested) { if (!job.failed) finish(); return; }
          const latest = find(key);
          if (latest === undefined || (roomId !== null && !latest.map.rooms.some(room => room.id === roomId))
            || !heldPolicy(entry.projectPath, entry.map.work.id).isOpen(roomId) || heldRanges(latest).has(roomId)) { finish(); return; }
          await openRoom(tracked, latest, roomId);
          if (!job.failed) finish();
        } catch {
          if (!requested && alive()) { void read(); return; }
          // openRoom owns bounded backoff. Its subsequent attempts retain this tracked
          // bridge, so failures stay visible and a successful retry releases the job.
          if (alive()) { job.failed = true; publishRepairs(); }
        }
      };
      publishRepairs();
      void read();
    };

    const repairHeld = (snapshot: WorksSnapshot): void => {
      for (const { projectPath, map } of snapshot.entries) {
        const key = mailKey(projectPath, map.work.id);
        const entry = find(key);
        if (entry === undefined || entry.map.compact?.version !== 2) continue;
        if (sync) {
          const ranges = heldRanges(entry);
          const policy = heldPolicy(projectPath, map.work.id);
          for (const roomId of [null, ...entry.map.rooms.map(room => room.id)]) {
            if (policy.isOpen(roomId) && !ranges.has(roomId)) {
              repairOpen(entry, roomId);
            }
          }
        }
        if (entry.map.messages.length > 0) {
          const state = repairOf(key);
          if (state.running || state.again || state.timer !== null) continue;
          state.again = true;
          pump(key);
        }
      }
    };

    const apply = (snapshot: WorksSnapshot, committed = false, replaceHeld = false): void => {
      if (disposed) return;
      // Хост до P35 номера не шлёт: его снимки применяются в порядке прихода, как прежде.
      if (snapshot.revision !== undefined) {
        if (!committed && snapshot.revision <= applied) return;
        applied = snapshot.revision;
      }
      const present = new Set<string>();
      // Работы, чей снимок старее версии, которой окно уже располагает (событие обогнало снимок, собранный до письма).
      const older = new Set<string>();
      const previousSource = new Map(sourceEntries);
      structural.clear();
      for (const entry of snapshot.entries) {
        const key = mailKey(entry.projectPath, entry.map.work.id);
        present.add(key);
        if (!lives.has(key)) lives.set(key, {});
        if (entry.version !== undefined) structural.set(key, entry.version);
        // Снимок ставит `held = max(held, version)`; без версии окно не знает, чем располагает, и забывает прежнюю.
        const prior = knownMail(key);
        sourceEntries.set(key, entry);
        if (entry.version === undefined) {
          if (sync && prior !== undefined) older.add(key);
          else held.delete(key);
        } else {
          if (prior !== undefined && entry.version < prior) older.add(key);
          held.set(key, Math.max(prior ?? entry.version, entry.version));
          if (sync) appliedMail.set(key, Math.max(prior ?? entry.version, entry.version));
        }
      }
      for (const key of [...lives.keys()]) if (!present.has(key)) forget(key);
      for (const key of [...held.keys()]) if (!present.has(key)) held.delete(key);
      set((state) => {
        const previous = new Map((replaceHeld ? [] : state.entries).map((entry) => [mailKey(entry.projectPath, entry.map.work.id), entry]));
        return {
          entries: snapshot.entries.map((entry) => {
            const key = mailKey(entry.projectPath, entry.map.work.id);
            const prev = previous.get(key);
            if (sync && prev !== undefined && previousSource.get(key) === entry) return prev;
            // Снимок старее события, уже применённого окном: структура (комнаты, сессии, план) берётся из него, а числа и
            // кандидаты в упоминания остаются от события — иначе снимок, вышедший позже, откатил бы их, а нового события
            // у работы может не быть (последнее письмо переписки).
            const numbers = older.has(key) && entry.map.compact?.version === 2 ? prev?.map.compact : undefined;
            const next = numbers?.version === 2 ? { ...entry, map: { ...entry.map, compact: numbers } } : entry;
            return keepHeld(prev, next, heldPolicy(entry.projectPath, entry.map.work.id).floor);
          }),
          branches: snapshot.branches,
          loading: false,
          error: null,
        };
      });
      if (repairAllAfterCommit && snapshot.entries.length > 0) {
        for (const key of present) repairAfterCommit.add(key);
        repairAllAfterCommit = false;
      }
      acceptingMail = true;
      drain();
      if (first) {
        first = false;
        repairHeld(snapshot);
      }
    };

    if (!sync) bridge
      .call('works.list', {})
      .then((snapshot) => {
        apply(snapshot);
        if (!disposed) set({ ready: true });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        // `loading` не снимается и прежний снимок не трогается (lane-r5): отказ — не пустой список.
        // Иначе «загружено, работ нет» стёрло бы сохранённые вкладки (retainLayouts первого снимка)
        // или закрыло вкладки работ при переподключении. Текст хоста — только в консоль.
        // Причина — `data.reason` ошибки хоста, как у ошибок git (8.2a).
        const info = decodeIpcError(err);
        const reason = info.data?.['reason'];
        console.warn('[parley] works.list failed', info.message);
        set({ error: { code: info.code, reason: typeof reason === 'string' ? reason : null } });
      });

    const unsubscribe = sync ? () => {} : bridge.on('works.changed', apply);
    let retiringEpoch = false;
    const offSync = surface?.subscribe(batch => {
      if (disposed || consumerFailed) return;
      const previous = reducer.view;
      if (batch.index === 0 && batch.transaction.mode === 'reset') {
        abandonReads();
        first = true;
        retiringEpoch = previous.epoch !== null && previous.epoch !== batch.transaction.epoch;
        if (retiringEpoch) {
          for (const entry of get().entries) invalidateWorkPages(entry.projectPath, entry.map.work.id);
          held.clear(); appliedMail.clear(); mailFloors.clear(); sourceEntries.clear(); waiting.clear(); repairAfterCommit.clear(); repairAllAfterCommit = false;
        }
      }
      const outcome = reducer.applyPage({ ...batch, kind: 'page', cursor: `local:${batch.index}`,
        next: batch.commit ? null : `local:${batch.index + 1}` });
      if (outcome.state === 'rejected') {
        consumerFailed = true;
        set({ syncStatus: { state: 'error', epoch: previous.epoch, applied: previous.revision, error: 'protocol', retryable: true } });
        throw new Error('works sync local transaction rejected');
      }
      if (outcome.state !== 'committed') return;
      const present = new Set(reducer.view.snapshot.entries.map(entry => mailKey(entry.projectPath, entry.map.work.id)));
      for (const old of previous.snapshot.entries) {
        const key = mailKey(old.projectPath, old.map.work.id);
        if (!present.has(key)) forget(key);
      }
      for (const deleted of outcome.commit.deleted) forget(mailKey(deleted.projectPath, deleted.workId));
      const reset = batch.transaction.mode === 'reset';
      const previousKeys = new Set(previous.snapshot.entries.map(entry => mailKey(entry.projectPath, entry.map.work.id)));
      if (retiringEpoch) for (const entry of get().entries) retireWorkPages(entry.projectPath, entry.map.work.id, true);
      apply(reducer.view.snapshot, true, retiringEpoch);
      retiringEpoch = false;
      for (const entry of reducer.view.snapshot.entries) {
        const key = mailKey(entry.projectPath, entry.map.work.id);
        if (reset || !previousKeys.has(key)) repairAfterCommit.add(key);
      }
      set({ ready: true, syncStatus: { state: 'current', epoch: outcome.commit.epoch, applied: outcome.commit.revision },
        mailRepairPending: pendingRepairs() });
      publishRepairs();
      pumpMail();
    }, status => {
      if (disposed || consumerFailed) return;
      if (status.state === 'loading' || (status.state === 'error' && status.error === 'connection')) abandonReads();
      set({ syncStatus: status });
    });
    if (surface) set({ retrySync: () => {
      if (disposed) return;
      if (mailConnectionFailed) { surface.retry(); return; }
      for (const state of mailRepairs.values()) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.failures = 0;
      }
      if (!consumerFailed && get().syncStatus?.state === 'current' && pendingRepairs() > 0) {
        for (const jobs of openRepairs.values()) for (const job of jobs) job.retry();
        for (const [key, state] of repairs) {
          if (state.timer) clearTimeout(state.timer);
          state.timer = null;
          state.failures = 0;
          pump(key);
        }
        publishRepairs();
        pumpMail();
      } else {
        consumerFailed = false;
        reducer.abandon();
        surface.retry();
      }
    } });
    // На `rooms.mail` окно подписано, только пока хост объявляет признак: хост без него события не шлёт, а пришедшее
    // от чужой сборки не читается — письма тогда приходят снимком, как раньше (спека rooms.mail 6.10). Статус
    // отдаётся при подписке, так что решение принято до первого события; остров статус хоста не хранит — берём из моста.
    let offMail: (() => void) | null = null;
    const offStatus = bridge.onStatus((status) => {
      if (sync && status.state !== 'connected') {
        if (pendingRepairs() > 0) mailConnectionFailed = true;
        abandonReads();
        publishRepairs();
      }
      const wants = hostFeatures(status).has(ROOMS_MAIL_FEATURE);
      if (wants && offMail === null) offMail = bridge.on('rooms.mail', handleMail);
      else if (!wants && offMail !== null) {
        offMail();
        offMail = null;
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      offSync?.();
      offStatus();
      offMail?.();
      stopOpenRetries();
      waiting.clear();
      held.clear();
      appliedMail.clear();
      sourceEntries.clear();
      mailFloors.clear();
      cancelMail();
      structural.clear();
      lives.clear();
      openRepairs.clear();
      repairAfterCommit.clear();
      repairAllAfterCommit = false;
      for (const state of repairs.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.again = false;
      }
      repairs.clear();
    };
  },
}));

/** Работы по порядку создания — по нему идёт нумерация 1…9 в сайдбаре и ⌘1…⌘9. */
export function orderedWorks(entries: readonly WindowWorkEntry[]): WindowWorkEntry[] {
  return [...entries].sort((a, b) => a.map.work.createdAt.localeCompare(b.map.work.createdAt));
}
