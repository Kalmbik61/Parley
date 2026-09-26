/**
 * Действия харнесса: клавиши после префикса и режим навигации по сайдбару
 * (дизайн TUI v2, 3.1–3.2, макеты 1.5 и §8).
 *
 * Байты разбирает `use-prefix-input.ts`, оверлеи держит `use-overlays.ts`;
 * здесь — только маршрут «клавиша → действие». Всё, что не префикс, уходит гостю.
 */

import { displayStatus } from '@harnas/core';
import type { WorkSession } from '@harnas/core';
import { useInput } from 'ink';
import { useCallback, useMemo, useState } from 'react';
import {
  sidebarCursorRows,
  sidebarTargets,
  stepCursor,
  type SidebarProps,
  type SidebarTarget,
  type SidebarWork,
} from './components/sidebar.js';
import type { PanelState, WorkRef } from './use-panel.js';
import type { OverlaysState } from './use-overlays.js';
import type { RoomState } from './use-room.js';
import { usePrefixInput, withoutMouse, type MouseEvent } from './use-prefix-input.js';
import type { SelectionState } from './use-selection.js';
import type { StatusEventInit } from './use-status.js';

/**
 * Клавиши прокрутки ленты комнаты без префикса (дизайн комнаты, 5.4): гостю не
 * уходят вовсе, пока комната выбрана (`capture` ниже). Единственное
 * поддерживаемое кодирование — то же, что у `parseMouse` в
 * `use-prefix-input.ts`: `xterm`-последовательности стрелок, `PgUp`/`PgDn` и
 * `End`. `j`/`k`/`G` — обычные символы: конфликтовать им не с чем, комната
 * держит весь ввод у себя.
 */
type RoomKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'tail';

const ROOM_KEYS: ReadonlyArray<readonly [string, RoomKey]> = [
  ['\u001B[A', 'up'],
  ['k', 'up'],
  ['\u001B[B', 'down'],
  ['j', 'down'],
  ['\u001B[5~', 'pageUp'],
  ['\u001B[6~', 'pageDown'],
  ['\u001B[F', 'tail'],
  ['\u001B[4~', 'tail'],
  ['G', 'tail'],
];

const roomKeyOf = (data: string): RoomKey | null =>
  ROOM_KEYS.find(([sequence]) => sequence === data)?.[1] ?? null;

/** Клавиша префикса → оверлей, который она открывает (таблица 3.2). */
const OVERLAYS: Readonly<Record<string, Parameters<OverlaysState['open']>[0]>> = {
  w: 'works',
  g: 'history',
  i: 'details',
  r: 'resume',
  R: 'summary',
  ',': 'settings',
  '?': 'help',
  x: 'close',
  d: 'delete',
  D: 'deleteWork',
  q: 'exit',
};

export interface ActionsOptions {
  /** Байт префикса и его имя для подсказок (`ctrl+q`). */
  prefixByte: number;
  /** Работы сайдбара по порядку: `prefix 1..9` выбирает работу по номеру. */
  workRows: readonly SidebarWork[];
  selection: SelectionState;
  /** Сессии каждой работы в порядке дерева: курсор навигации и ходьба `j`/`k`. */
  orders: ReadonlyMap<string, readonly string[]>;
  /**
   * Ключи работ, у которых есть комната — хотя бы одно письмо (дизайн комнаты,
   * 3 и 5): ходьба `j`/`k` заходит в комнату работы после её последней сессии,
   * только когда работа в этом множестве.
   */
  roomWorks: ReadonlySet<string>;
  /**
   * Выбранная работа с её проектом: в неё ложится новая сессия (5.1). Проект
   * берётся у записи работы — закреплённая работа бывает чужой (макет 4.2).
   */
  work: WorkRef | null;
  session: WorkSession | null;
  panel: PanelState;
  overlays: OverlaysState;
  /**
   * Комната работы: `t` выбирает и уводит из неё, стрелки и колесо без
   * префикса листают её ленту, пока она выбрана (дизайн комнаты, 3–5).
   */
  room: RoomState;
  /** Событие строки статуса «писем в работе пока нет» — тем же механизмом, что и остальные (дизайн комнаты, 5). */
  push: (events: readonly StatusEventInit[]) => void;
  /** Сайдбар, как он нарисован: из его раскладки берутся цели клика (3.3). */
  sidebar: SidebarProps | null;
  /** Колонок слева от панели: клик не правее — сайдбару. */
  panelLeft: number;
  /**
   * Ячеек рамки панели до экрана гостя: на столько же сдвинуты его первая
   * колонка и строка, и на столько же правится координата клика, уходящего
   * ему (план рамок, задача 6).
   */
  panelInset: number;
  /** `config.mouseCapture`: выключен — харнесс мышь не ловит вовсе (3.3). */
  mouseCapture: boolean;
  /**
   * Нажатие, не ушедшее гостю: после префикса, в списках, в оверлее. По нему
   * гаснет событие строки статуса без источника (дизайн координации, раздел 5).
   */
  onKey: () => void;
  /**
   * `prefix b`: сайдбар прячется и показывается. `false` — сайдбара на этой
   * ширине нет вовсе, и `b` открывает его оверлеем (2.1, решение №9).
   */
  toggleSidebar: () => boolean;
}

export interface ActionsState {
  /** Фокус в сайдбаре: ввод не идёт гостю, разделитель cyan (макет 1.5). */
  navigating: boolean;
  /** Ждём вторую клавишу префикса: строка статуса показывает действия (§3). */
  awaiting: boolean;
  /** Строка сайдбара под курсором: она подсвечена (макет 1.5). */
  cursor: SidebarTarget | null;
}

/** Остановка ходьбы `j`/`k`: сессия работы или её комната следом за ними (комната, 5). */
type WalkStop =
  | { work: string; kind: 'session'; session: string }
  | { work: string; kind: 'room' };

export function useActions(options: ActionsOptions): ActionsState {
  const { prefixByte, workRows, selection, orders, roomWorks, panel, overlays, room, push } =
    options;
  const order = orders.get(selection.work ?? '') ?? [];
  // Все сессии сайдбара сверху вниз, а следом за сессиями каждой работы — её
  // комната, если она есть: по ним `j`/`k` ходят по кругу через работы (3.2;
  // дизайн комнаты, 5).
  const sequence = useMemo(() => {
    const out: WalkStop[] = [];
    for (const work of workRows) {
      for (const sessionId of orders.get(work.key) ?? []) {
        out.push({ work: work.key, kind: 'session', session: sessionId });
      }
      if (roomWorks.has(work.key)) out.push({ work: work.key, kind: 'room' });
    }
    return out;
  }, [workRows, orders, roomWorks]);
  const { work, session, sidebar, panelLeft, panelInset, mouseCapture, onKey, toggleSidebar } =
    options;

  const [navigating, setNavigating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [cursor, setCursor] = useState<SidebarTarget | null>(null);

  // Комната достижима курсором режима навигации только у выбранной работы, и
  // только когда она у этой работы есть (дизайн комнаты, 3 и 5).
  const roomKey =
    selection.work !== null && roomWorks.has(selection.work) ? selection.work : null;
  /** Строки сайдбара сверху вниз: по ним ходит курсор режима навигации (3.2). */
  const rows = useMemo(
    () => sidebarCursorRows(workRows, order, roomKey),
    [workRows, order, roomKey],
  );

  /**
   * `prefix j`/`k`: соседняя сессия с подключением к панели, а после последней
   * сессии работы — её комната, если она есть (3.2; дизайн комнаты, 5). Ходьба
   * идёт по всему сайдбару по кругу: с одной сессией на работу иначе некуда
   * шагать. Комната не подключает панель — `selectRoom` не зовёт `onAttach`
   * никогда, даже когда шаг заодно переносит выбор на чужую работу (комната, 3-4).
   */
  const walk = useCallback(
    (delta: number) => {
      const at = Math.max(
        0,
        sequence.findIndex(
          (item) =>
            item.work === selection.work &&
            (selection.room
              ? item.kind === 'room'
              : item.kind === 'session' && item.session === selection.session),
        ),
      );
      const next = sequence[(at + delta + sequence.length) % (sequence.length || 1)];
      if (next === undefined) return;
      if (next.kind === 'room') {
        setCursor({ kind: 'room', key: next.work });
        return selection.selectRoom(next.work);
      }
      setCursor({ kind: 'session', key: next.session });
      selection.selectWork(next.work, next.session);
    },
    [sequence, selection],
  );

  /**
   * Новая сессия в работе `target`; `null` — в новой работе «без названия» (5.1).
   * Выбор переезжает за панелью: работа могла родиться этим же нажатием.
   */
  const create = useCallback(
    (target: WorkRef | null) => {
      // Работа и сессия задаются явно: обе могли родиться этим же нажатием и в
      // выборе их ещё нет — `selectWork` без сессии вернул бы панель к прежней.
      panel.create(target, (sessionId, workKey) => selection.selectWork(workKey, sessionId));
    },
    [panel, selection],
  );

  /**
   * Выход из режима навигации: курсор уходит вместе с ним, иначе строка
   * осталась бы подсвеченной без фокуса в сайдбаре (макет 1.5).
   */
  const leave = useCallback(() => {
    setNavigating(false);
    setCursor(null);
  }, []);

  /** Ходьба курсора: сессия под ним выбирается сразу, работа — только `Enter`. */
  const moveCursor = useCallback(
    (delta: number) => {
      const next = stepCursor(rows, cursor, delta);
      setCursor(next);
      if (next?.kind === 'session') selection.selectSession(next.key);
    },
    [rows, cursor, selection],
  );

  const onAction = useCallback(
    (key: string) => {
      onKey();
      // `c` про курсор не спрашивает: сессия ложится в выбранную работу, а если
      // работ нет — `panel.create(null)` заводит первую (3.2, 5.1).
      if (key === 'c') return create(work);
      // `C` — дочерняя сессия выбранной: родитель и контекст берутся из неё (3.2).
      if (key === 'C') {
        if (work === null || session === null) return;
        return panel.createChild(work, session.id, (sessionId, workKey) =>
          selection.selectWork(workKey, sessionId),
        );
      }
      if (key === 'j' || key === 'k') return walk(key === 'j' ? 1 : -1);
      if (key === 's') {
        // Курсор входит в сайдбар там, где стоит выбор (макет 1.5); выбрана
        // комната — курсор встаёт на её строку (дизайн комнаты, 5).
        const at: SidebarTarget | null =
          selection.room && selection.work !== null
            ? { kind: 'room', key: selection.work }
            : selection.session !== null
              ? { kind: 'session', key: selection.session }
              : selection.work !== null
                ? { kind: 'work', key: selection.work }
                : null;
        setCursor(stepCursor(rows, at, 0));
        return setNavigating(true);
      }
      // Сайдбара на этой ширине нет — `b` открывает его оверлеем (решение №9).
      if (key === 'b') return toggleSidebar() ? undefined : overlays.open('sidebar');
      // Комната выбранной работы: повторное `t` уводит туда, откуда пришли, а
      // без писем в работе — только событие, комнате нечего показывать
      // (дизайн комнаты, 3 и 5).
      if (key === 't') {
        if (selection.room) return selection.leaveRoom();
        if (roomKey !== null) return selection.selectRoom();
        return push([{ text: 'писем в работе пока нет' }]);
      }
      if (key >= '1' && key <= '9') {
        const work = workRows[Number(key) - 1];
        if (work === undefined) return;
        setCursor({ kind: 'work', key: work.key });
        selection.selectWork(work.key);
        return;
      }
      const overlay = OVERLAYS[key];
      if (overlay !== undefined) overlays.open(overlay);
    },
    [
      create,
      work,
      session,
      rows,
      selection,
      walk,
      workRows,
      overlays,
      roomKey,
      push,
      onKey,
      toggleSidebar,
    ],
  );

  /**
   * Клик в сайдбаре: по работе — выбор, по сессии — выбор с подключением, по
   * `new` — сессия в новой работе, потому что выбрана строка `new` (3.3, 5.1).
   * Курсор клик двигает только в режиме навигации: вне его подсвечивать нечего.
   * Колесо и отпускание кнопки строк не трогают. Раскладка считается на сам
   * клик: каждый кадр она была бы напрасной работой.
   */
  const onMouse = (event: MouseEvent): void => {
    if (event.kind !== 'press' || event.button !== 0 || sidebar === null) return;
    const target = sidebarTargets(sidebar)[event.y - 1];
    if (target === undefined || target === null) return;
    if (navigating) setCursor(target);
    if (target.kind === 'work') return selection.selectWork(target.key);
    if (target.kind === 'new') return create(null);
    if (target.kind === 'room') return selection.selectRoom();
    selection.attach(target.key);
  };

  // В панели карточка, а не живой гость: клавишам некуда уходить, и `Enter`
  // делает то, что обещает карточка — запускает или возобновляет (2.2). Судим по
  // самой панели: карта с выбором приезжает через watcher позже, чем поднимается PTY.
  const card = panel.attached === null || !panel.alive(panel.attached);

  // Весь ввод — гостю, кроме префикса; пока открыт оверлей, сайдбар в режиме
  // навигации или выбрана комната, гостю не уходит ничего (3.1; комната, 3–4).
  usePrefixInput(true, {
    prefixByte,
    onAction,
    onAwait: setAwaiting,
    toGuest: panel.write,
    capture: overlays.kind !== null || navigating || card || selection.room,
    // Оверлей глух и к префиксу, а сайдбар, карточка и комната — нет: действия
    // харнесса слышны и в этих режимах, не выходя из них (3.1–3.2; комната, 4).
    keepPrefix: overlays.kind === null && (navigating || card || selection.room),
    // Ввод оверлея и списков — тоже нажатия харнесса; события мыши ими не
    // считаются: они гостю не уходят, но и клавишами не являются. Пока выбрана
    // комната и не открыт оверлей, тот же чанк ещё листает её ленту (5.4) —
    // `navigating` проверяется отдельно: войдя в сайдбар с комнаты, стрелки
    // должны водить курсор, а не лист.
    onCapture: (data) => {
      const text = withoutMouse(data);
      if (text !== '') onKey();
      if (!selection.room || navigating || overlays.kind !== null) return;
      const move = roomKeyOf(text);
      if (move === 'up') room.scrollBy(-1);
      else if (move === 'down') room.scrollBy(1);
      else if (move === 'pageUp') room.scrollBy(-room.height);
      else if (move === 'pageDown') room.scrollBy(room.height);
      else if (move === 'tail') room.follow();
    },
    mouseCapture,
    panelLeft,
    panelInset,
    mouseTracking: panel.snapshot?.mouseTracking ?? 'none',
    onMouse,
    onScroll: panel.scroll,
    roomSelected: selection.room,
    onRoomScroll: room.scrollBy,
  });

  // Режим навигации: стрелки и `j`/`k` по всем строкам сайдбара сверху вниз,
  // `Enter` выбирает работу, заводит сессию на `new` или подключает (3.2, §8).
  useInput(
    (input, key) => {
      if (key.escape) return leave();
      if (input === 'j' || key.downArrow) return moveCursor(1);
      if (input === 'k' || key.upArrow) return moveCursor(-1);
      if (!key.return) return;

      // Работа выбирается на месте: её сессии появляются внизу сайдбара, и
      // курсор идёт к ним дальше, не выходя из режима.
      if (cursor?.kind === 'work') return selection.selectWork(cursor.key);

      leave();
      // Выбрана строка `new` верхнего уровня — сессия ложится в новую работу
      // «без названия» (5.1).
      if (cursor?.kind === 'new') return create(null);
      // Строка комнаты: `Enter` выбирает её и выходит из режима — комната уже
      // принадлежит выбранной работе, переключать работу не нужно (комната, 5).
      if (cursor?.kind === 'room') return selection.selectRoom();

      const id = cursor?.key ?? selection.session;
      if (id === null) return;
      // Не живую сессию `Enter` запускает или возобновляет оверлеем (4.5, 4.6).
      if (session !== null && displayStatus(session) !== 'active') {
        overlays.open(displayStatus(session) === 'pending' ? 'launch' : 'resume');
        return;
      }
      selection.attach(id);
    },
    // Пока ждём вторую клавишу префикса, ходьба молчит: `prefix j` — это
    // действие харнесса, а не шаг курсора.
    { isActive: navigating && overlays.kind === null && !awaiting },
  );

  // `Enter` на карточке: запуск `pending`, возобновление вышедшей или
  // завершённой; у сессии, запущенной вне харнесса, подключать нечего (2.2).
  // Выбрана комната — панель показывает не карточку, а ленту: `Enter` карточки
  // ей не принадлежит (дизайн комнаты, 3).
  useInput(
    (_input, key) => {
      if (!key.return || session === null || displayStatus(session) === 'active') return;
      overlays.open(displayStatus(session) === 'pending' ? 'launch' : 'resume');
    },
    { isActive: card && !navigating && !selection.room && overlays.kind === null && !awaiting },
  );

  return { navigating, awaiting, cursor };
}
