/**
 * Список работ: старт — `works.list`, дальше живые изменения по `works.changed`
 * (кусок 1.10 плана окна). Хранилище держит последний снимок целиком — работ
 * немного, точечных патчей хост не присылает.
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
 * это повтор или обогнавший событие снимок: письма сливаются, а числа не трогаются. `prevVersion` не больше версии окна —
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
import { ROOMS_MAIL_FEATURE, type RoomsMailEvent, type WorksSnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { hostFeatures } from '../lib/capabilities.js';
import { heldRanges, keepHeld, withFreshMessages, withMail, withMessages } from '../lib/window-merge.js';
import { followRoom, heldPolicy, repairWork, rereadRoom, stopOpenRetries } from './room-pages.js';

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
  init: (bridge: Pick<ParleyBridge, 'call' | 'on' | 'onStatus'>) => () => void;
  /** Письма, пришедшие страницей (`context.messages`), встают в карту работы по номеру. */
  addMessages: (projectPath: string, workId: string, messages: readonly Message[]) => void;
  /**
   * Письма, пришедшие страницей при починке разрыва или дочитывании (`repairWork`, `followRoom`): свежая копия письма
   * заменяет держимую, отметки прочтения только прибавляются (`addMessages` оставляет держимую копию как есть).
   */
  addMail: (projectPath: string, workId: string, messages: readonly Message[]) => void;
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
  addMail: (projectPath, workId, messages) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.projectPath === projectPath && entry.map.work.id === workId ? withFreshMessages(entry, messages) : entry,
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
  init: (bridge) => {
    let disposed = false;
    let applied = -1;
    /**
     * Версия каждой работы, которой располагает окно: из снимка (`max`) и из последнего применённого события. Нет записи —
     * окно не знает, чем располагает (снимок без версии, сбой починки), и первое событие считает разрывом: безопасный путь,
     * цена — одна лишняя починка.
     */
    const held = new Map<string, number>();
    /** События, что ждут снимка своей работы (или комнаты в нём), в порядке прихода: следующее не обгоняет первое. */
    const waiting = new Map<string, RoomsMailEvent[]>();
    const repairs = new Map<string, RepairState>();
    // Новое подключение — возможно, к только что запущенному хосту: готовность считается заново.
    set({ ready: false });

    const find = (key: string): WindowWorkEntry | undefined =>
      get().entries.find((entry) => mailKey(entry.projectPath, entry.map.work.id) === key);

    /**
     * Что делать с событием при данной карте работы: комнаты на месте — применить как есть; комнаты нет, а снимок не
     * старее события — её удалила та же запись, события про неё выбрасываются (применяется остальное); иначе структура
     * ещё в пути — `null`, ждать снимка (спека rooms.mail 6.5).
     */
    const place = (entry: WindowWorkEntry, event: RoomsMailEvent, key: string): RoomsMailEvent | null => {
      const known = new Set(entry.map.rooms.map((room) => room.id));
      const present = event.rooms.filter((room) => room.roomId === null || known.has(room.roomId));
      if (present.length === event.rooms.length) return event;
      const version = held.get(key);
      return version !== undefined && version >= event.version ? { ...event, rooms: present } : null;
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
      if (state.timer !== null) clearTimeout(state.timer);
      const delay = Math.min(REPAIR_BACKOFF_MS * 2 ** (state.failures - 1), REPAIR_BACKOFF_MAX_MS);
      state.timer = setTimeout(() => {
        state.timer = null;
        pump(key);
      }, delay);
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
      repairWork(bridge, entry)
        .then(
          () => {
            state.failures = 0;
          },
          (error: unknown) => failed(key, error),
        )
        .finally(() => {
          state.running = false;
          pump(key);
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
      // Версия события не больше версии окна: повтор или обогнавший событие снимок — письма и отметки сливаются, числа не трогаются.
      const stale = version !== undefined && event.version <= version;
      // Разрыв — событие начинается после держимой версии или версия неизвестна; `prevVersion <= version < event.version` — пачка
      // смешанной записи, начатая до снимка, пропущенного нет (подробнее — в описании `deliver`).
      const gap = !stale && (version === undefined || event.prevVersion > version);
      // Версия сошлась, но верх держимой комнаты ниже `prevTop` (письма между ними потерялись) или комната помечена `reread`.
      const ranges = heldRanges(before);
      const lagging: Array<string | null> = [];
      const rereading: Array<string | null> = [];
      if (!stale && !gap) {
        for (const room of event.rooms) {
          const range = ranges.get(room.roomId);
          if (range === undefined) continue;
          if (room.reread === true) rereading.push(room.roomId);
          else if (range.max < room.prevTop) lagging.push(room.roomId);
        }
      }

      const policy = heldPolicy(event.projectPath, event.workId);
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.projectPath === event.projectPath && entry.map.work.id === event.workId ? withMail(entry, event, stale, policy.isOpen, policy.floor) : entry,
        ),
      }));
      if (!stale) held.set(key, event.version);
      notifyMail(event);
      if (stale) return;

      if (gap) {
        repairOf(key).again = true;
        pump(key, before);
        return;
      }
      if (lagging.length === 0 && rereading.length === 0) return;
      Promise.all([...lagging.map((roomId) => followRoom(bridge, before, roomId)), ...rereading.map((roomId) => rereadRoom(bridge, before, roomId))]).catch(
        (error: unknown) => failed(key, error),
      );
    };

    const enqueue = (key: string, event: RoomsMailEvent): void => {
      const queue = waiting.get(key) ?? [];
      queue.push(event);
      if (queue.length > WAITING_EVENTS_MAX) queue.shift();
      waiting.set(key, queue);
      if (waiting.size > WAITING_WORKS_MAX) waiting.delete(waiting.keys().next().value!);
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
      if (entry !== undefined && !waiting.has(key)) {
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
    const repairHeld = (snapshot: WorksSnapshot): void => {
      for (const { projectPath, map } of snapshot.entries) {
        const key = mailKey(projectPath, map.work.id);
        const entry = find(key);
        if (entry === undefined || entry.map.compact?.version !== 2 || entry.map.messages.length === 0) continue;
        const state = repairOf(key);
        if (state.running || state.again || state.timer !== null) continue;
        state.again = true;
        pump(key);
      }
    };

    const apply = (snapshot: WorksSnapshot): void => {
      if (disposed) return;
      // Хост до P35 номера не шлёт: его снимки применяются в порядке прихода, как прежде.
      if (snapshot.revision !== undefined) {
        if (snapshot.revision <= applied) return;
        applied = snapshot.revision;
      }
      const present = new Set<string>();
      for (const entry of snapshot.entries) {
        const key = mailKey(entry.projectPath, entry.map.work.id);
        present.add(key);
        // Снимок ставит `held = max(held, version)`; без версии окно не знает, чем располагает, и забывает прежнюю.
        if (entry.version === undefined) held.delete(key);
        else held.set(key, Math.max(held.get(key) ?? entry.version, entry.version));
      }
      for (const key of [...held.keys()]) if (!present.has(key)) held.delete(key);
      set((state) => {
        const previous = new Map(state.entries.map((entry) => [mailKey(entry.projectPath, entry.map.work.id), entry]));
        return {
          entries: snapshot.entries.map((entry) =>
            keepHeld(previous.get(mailKey(entry.projectPath, entry.map.work.id)), entry, heldPolicy(entry.projectPath, entry.map.work.id).floor),
          ),
          branches: snapshot.branches,
          loading: false,
          error: null,
        };
      });
      drain();
      if (first) {
        first = false;
        repairHeld(snapshot);
      }
    };

    bridge
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

    const unsubscribe = bridge.on('works.changed', apply);
    // На `rooms.mail` окно подписано, только пока хост объявляет признак: хост без него события не шлёт, а пришедшее
    // от чужой сборки не читается — письма тогда приходят снимком, как раньше (спека rooms.mail 6.10). Статус
    // отдаётся при подписке, так что решение принято до первого события; остров статус хоста не хранит — берём из моста.
    let offMail: (() => void) | null = null;
    const offStatus = bridge.onStatus((status) => {
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
      offStatus();
      offMail?.();
      stopOpenRetries();
      waiting.clear();
      held.clear();
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
