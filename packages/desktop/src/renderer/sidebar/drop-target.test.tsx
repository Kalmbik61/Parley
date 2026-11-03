/**
 * Строки сайдбара как цели броска сессии (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5): подсвечивается
 * только цель, на которую бросить можно — фон `accent 14 %` и inset-рамка 1.5px. На себя, в свою комнату, закрытую
 * сессию, в чужую работу (строка неактивной карточки), участнику комнаты и при хосте без нужного метода — не
 * подсвечивается и не принимает.
 *
 * Настоящий `DndContext` с порогом 4 px, как в окне; «под указателем» задаёт `collisionDetection` теста — jsdom
 * прямоугольников не считает. Выключенные droppable dnd-kit в него не передаёт: цель, которой нет в списке, не
 * подсветится. Что тащат, тест кладёт в стор жеста (`layout/drag-store.ts`) своими обработчиками, как `AppShell`: карточку
 * над лентами и терминалами узнают по нему, а не по `useDndContext()`.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import type { BacklogSnapshot } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowWorkEntry } from '@parley/core';
import { useBoardStore } from '../board/board-store.js';
import { dndId, dragItemOf, type DragSourceData } from '../layout/dnd.js';
import { useDragStore } from '../layout/drag-store.js';
import { useLayoutStore } from '../layout/store.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { RoomRow } from './RoomRow.js';
import { SessionRow } from './SessionRow.js';
import { cardRows } from './sort.js';
import { useFeedDropTarget } from './use-drop-target.js';

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const KEY = workKey(PROJECT, WORK);
const NOW = new Date('2026-09-29T10:00:00.000Z');
const BRIDGE = createFakeBridge();

/** Что «под указателем»: id droppable; пусто — ничего. Тест ставит его перед движением. */
const pointer = { over: '' };

const collisionDetection: CollisionDetection = ({ droppableContainers }) => {
  const hit = droppableContainers.find((container) => String(container.id) === pointer.over);
  return hit === undefined ? [] : [{ id: hit.id, data: { droppableContainer: hit, value: 1 } }];
};

/** Обработчики жеста, как в `AppShell`: предмет кладётся в стор на старте и убирается на конце и отмене. */
const dragToStore = {
  onDragStart: (event: DragStartEvent): void => {
    useDragStore.getState().setItem(dragItemOf(event.active.data.current));
  },
  onDragEnd: (): void => {
    useDragStore.getState().setItem(null);
  },
  onDragCancel: (): void => {
    useDragStore.getState().setItem(null);
  },
};

/** Карточка Backlog доски, которую можно тащить (в окне — `BoardCardView`); по умолчанию — из проекта работы. */
function CardSource({ projectPath = PROJECT }: { projectPath?: string }): JSX.Element {
  const data: DragSourceData = { item: { kind: 'card', projectPath, id: 'b-001', index: 0, title: 'Task' } };
  const { setNodeRef, listeners } = useDraggable({ id: dndId.card(`${projectPath}#b-001`), data });
  return <div ref={setNodeRef} {...listeners} data-card-source="" />;
}

function Card({ entry, showClosed = false }: { entry: WindowWorkEntry; showClosed?: boolean }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} {...dragToStore}>
      <CardSource />
      {cardRows(entry.map, showClosed).map((row) =>
        row.kind === 'session' ? (
          <SessionRow
            key={row.session.id}
            workKey={KEY}
            projectPath={PROJECT}
            workId={WORK}
            bridge={BRIDGE}
            session={row.session}
            depth={row.depth}
            activity={null}
            now={NOW}
            draggable
            selected={false}
            onOpen={() => {}}
          />
        ) : (
          <RoomRow
            key={row.room.id}
            workKey={KEY}
            projectPath={PROJECT}
            workId={WORK}
            bridge={BRIDGE}
            row={row}
            mentioned={false}
            activity={{}}
            now={NOW}
            active
            selectedSessionId={null}
            onOpen={() => {}}
            openerFor={() => () => {}}
          />
        ),
      )}
    </DndContext>
  );
}

type FeedOwner = { roomId: string } | { sessionId: string };

/** Лента комнаты или Chat как цель броска карточки: в окне это `RoomPanel` и `ChatView`, здесь — пустой блок с тем же хуком. */
function Feed({ owner }: { owner: FeedOwner }): JSX.Element {
  const { setNodeRef, over } = useFeedDropTarget(KEY, owner);
  return <div ref={setNodeRef} data-feed={'roomId' in owner ? owner.roomId : owner.sessionId} {...(over ? { 'data-feed-over': '' } : {})} />;
}

function Feeds({ owners, onEnd, cardProject = PROJECT }: { owners: readonly FeedOwner[]; onEnd: (event: DragEndEvent) => void; cardProject?: string }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={dragToStore.onDragStart}
      onDragEnd={(event) => {
        dragToStore.onDragEnd();
        onEnd(event);
      }}
      onDragCancel={dragToStore.onDragCancel}
    >
      <CardSource projectPath={cardProject} />
      {owners.map((owner) => (
        <Feed key={'roomId' in owner ? owner.roomId : owner.sessionId} owner={owner} />
      ))}
    </DndContext>
  );
}

const sessionRowEl = (id: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>(`[data-session-id="${id}"]`)];
  if (found[0] === undefined) throw new Error(`строки ${id} нет`);
  return found[0];
};
const roomRowEl = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-room-row="${id}"]`);
  if (found === null) throw new Error(`строки комнаты ${id} нет`);
  return found;
};
const highlighted = (): string[] =>
  [...document.querySelectorAll('[data-drop-over]')].map((node) => node.getAttribute('data-session-id') ?? `room ${node.getAttribute('data-room-row')}`);

const feedsOver = (): string[] => [...document.querySelectorAll('[data-feed-over]')].map((node) => node.getAttribute('data-feed') ?? '');

/** Тащит строку сессии `from` за порог и держит указатель над целью `over` (id droppable). Бросок — `release()`. */
async function dragOver(from: string, over: string): Promise<void> {
  pointer.over = over;
  fireEvent.pointerDown(sessionRowEl(from), { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 30, clientY: 10 });
  await act(async () => {});
  // Droppable включается после старта перетаскивания — движение ещё раз даёт dnd-kit пересчитать столкновения.
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 32, clientY: 10 });
  await act(async () => {});
}

async function release(): Promise<void> {
  fireEvent.pointerUp(document, { isPrimary: true, clientX: 32, clientY: 10 });
  await act(async () => {});
}

/** Доска знает проект `path` с одной карточкой Backlog b-001. */
function setBoard(path: string): void {
  const item = { id: 'b-001', title: 'Task', details: '', checked: false, section: null };
  const snapshot = { projectPath: path, sharedProjectPath: path, version: 'v1', items: [item] } as unknown as BacklogSnapshot;
  useBoardStore.setState({ slots: new Map([[path, { snapshot, live: true }]]), inboxPath: null });
}

/** Тащит карточку Backlog и держит указатель над целью `over`. */
async function dragCardOver(over: string): Promise<void> {
  pointer.over = over;
  const source = document.querySelector<HTMLElement>('[data-card-source]');
  if (source === null) throw new Error('карточки нет');
  fireEvent.pointerDown(source, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 30, clientY: 10 });
  await act(async () => {});
  fireEvent.pointerMove(document, { isPrimary: true, clientX: 32, clientY: 10 });
  await act(async () => {});
}

function connect(methods: readonly string[] = REQUIRED_METHODS): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: [...methods] } });
}

/** Работа: s-01 и s-04 вне комнат, s-02 и s-03 — в комнате r-01, s-05 закрыта и вне комнат; вторая комната r-02 — s-06. */
function entryOf(): WindowWorkEntry {
  return makeWork(WORK, {
    projectPath: PROJECT,
    sessions: [
      makeSession('s-01', 'один'),
      makeSession('s-02', 'два'),
      makeSession('s-03', 'три'),
      makeSession('s-04', 'четыре'),
      makeSession('s-05', 'пять', { lifecycle: 'closed' }),
      makeSession('s-06', 'шесть'),
    ],
    rooms: [
      { ...makeRoom('r-01', 'Возвраты'), members: ['s-02', 's-03'], lead: 's-02', createdAt: '2026-09-29T08:00:00.000Z' },
      { ...makeRoom('r-02', 'Отчёты'), members: ['s-06'], lead: 's-06', createdAt: '2026-09-29T09:00:00.000Z' },
    ],
  });
}

beforeEach(() => {
  pointer.over = '';
  useDragStore.setState({ item: null });
  connect();
  useProvidersStore.setState({ providers: [] });
  useUiStore.setState({ roomExpanded: {}, dark: false });
  useLayoutStore.setState({ activeWorkKey: KEY, layouts: {} });
  useWorksStore.setState({ entries: [entryOf()], branches: {}, loading: false, error: null });
  setBoard(PROJECT);
});

afterEach(cleanup);

describe('строка сессии вне комнат — цель броска другой сессии (диалог 1.6)', () => {
  it('другая сессия, бросок возможен — цель подсвечена: фон accent 14 % и inset-рамка 1.5px; тащимая — нет', async () => {
    render(<Card entry={entryOf()} />);
    await dragOver('s-01', dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual(['s-04']);
    const target = sessionRowEl('s-04');
    expect(target.className).toContain('bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]');
    expect(target.className).toContain('shadow-[inset_0_0_0_1.5px_var(--primary)]');
    // Текст на подсвеченной цели — основной: hover под щитом броска не действует.
    expect(target.className).toContain('[--work-sidebar-muted-foreground:var(--color-text)]');
    await release();
    expect(highlighted()).toEqual([]);
  });

  it('на себя — цели нет, подсветки нет', async () => {
    render(<Card entry={entryOf()} />);
    await dragOver('s-01', dndId.sessionRow(KEY, 's-01'));
    expect(highlighted()).toEqual([]);
  });

  it('на закрытую сессию — нет (хост закрытую в комнату не берёт)', async () => {
    render(<Card entry={entryOf()} showClosed />);
    await dragOver('s-01', dndId.sessionRow(KEY, 's-05'));
    expect(highlighted()).toEqual([]);
  });

  it('закрытую сессию не бросить ни на что: ни на сессию, ни на комнату', async () => {
    render(<Card entry={entryOf()} showClosed />);
    await dragOver('s-05', dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual([]);
    await release();
    await dragOver('s-05', dndId.roomRow(KEY, 'r-02'));
    expect(highlighted()).toEqual([]);
  });

  it('участник комнаты — не цель для строки сессии: его строка droppable не регистрирует, подсвечивается комната целиком', async () => {
    render(<Card entry={entryOf()} />);
    // Комната развёрнута правилом: у неё выбран ручной шеврон.
    act(() => useUiStore.setState({ roomExpanded: { [`${KEY}/r-01`]: true } }));
    await dragOver('s-01', dndId.sessionRow(KEY, 's-02'));
    expect(highlighted()).toEqual([]);
    await release();
    await dragOver('s-01', dndId.roomRow(KEY, 'r-01'));
    expect(highlighted()).toEqual(['room r-01']);
  });

  it('строки неактивной карточки (чужая работа) цели не дают', async () => {
    render(<Card entry={entryOf()} />);
    act(() => useLayoutStore.setState({ activeWorkKey: workKey('/tmp/other', 'w-99') }));
    await dragOver('s-01', dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual([]);
  });

  it('хост без rooms.create — цели нет', async () => {
    connect(REQUIRED_METHODS.filter((method) => method !== 'rooms.create'));
    render(<Card entry={entryOf()} />);
    await dragOver('s-01', dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual([]);
  });
});

describe('строка комнаты — цель броска сессии (rooms.addMember)', () => {
  it('сессии, которой в комнате нет, — подсвечена: вся строка комнаты', async () => {
    render(<Card entry={entryOf()} />);
    await dragOver('s-01', dndId.roomRow(KEY, 'r-01'));
    expect(highlighted()).toEqual(['room r-01']);
    const target = roomRowEl('r-01');
    expect(target.className).toContain('bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]');
    expect(target.className).toContain('shadow-[inset_0_0_0_1.5px_var(--primary)]');
    await release();
    expect(highlighted()).toEqual([]);
  });

  it('в свою комнату — нельзя, цель не подсвечивается; в другую — можно', async () => {
    render(<Card entry={entryOf()} />);
    act(() => useUiStore.setState({ roomExpanded: { [`${KEY}/r-01`]: true } }));
    await dragOver('s-02', dndId.roomRow(KEY, 'r-01'));
    expect(highlighted()).toEqual([]);
    await release();
    await dragOver('s-02', dndId.roomRow(KEY, 'r-02'));
    expect(highlighted()).toEqual(['room r-02']);
  });

  it('решение ждёт (подкраска accent-200) — цель всё равно подсвечивается: бросок виден человеку', async () => {
    const waiting = entryOf();
    const first = waiting.map.rooms[0];
    if (first === undefined) throw new Error('нет комнаты');
    first.proposal = { id: 'p-01', from: 's-02', text: 'Решение', rev: 0, at: '2026-09-29T09:58:00.000Z' };
    useWorksStore.setState({ entries: [waiting] });
    render(<Card entry={waiting} />);
    expect(roomRowEl('r-01').className).toContain('bg-accent-200');
    await dragOver('s-01', dndId.roomRow(KEY, 'r-01'));
    expect(roomRowEl('r-01').className).toContain('bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]');
    expect(roomRowEl('r-01').className).not.toContain('bg-accent-200');
  });

  it('хост без rooms.addMember — цели нет (окно прячет функцию, если метода нет)', async () => {
    connect(REQUIRED_METHODS.filter((method) => method !== 'rooms.addMember'));
    render(<Card entry={entryOf()} />);
    await dragOver('s-01', dndId.roomRow(KEY, 'r-01'));
    expect(highlighted()).toEqual([]);
  });

  it('старая карта: сессия в двух комнатах стоит в самой ранней — в неё нельзя, в другую из её комнат — можно', async () => {
    const old = makeWork(WORK, {
      projectPath: PROJECT,
      sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два'), makeSession('s-03', 'три')],
      rooms: [
        { ...makeRoom('r-02', 'Поздняя'), members: ['s-02', 's-03'], lead: 's-03', createdAt: '2026-09-29T09:00:00.000Z' },
        { ...makeRoom('r-01', 'Ранняя'), members: ['s-01', 's-02'], lead: 's-01', createdAt: '2026-09-29T08:00:00.000Z' },
      ],
    });
    useWorksStore.setState({ entries: [old] });
    render(<Card entry={old} />);
    act(() => useUiStore.setState({ roomExpanded: { [`${KEY}/r-01`]: true, [`${KEY}/r-02`]: true } }));
    // s-02 стоит в r-01 (ранняя): туда нельзя, а в r-02, где она тоже числится, — можно (правило одной комнаты — у хоста).
    await dragOver('s-02', dndId.roomRow(KEY, 'r-01'));
    expect(highlighted()).toEqual([]);
    await release();
    await dragOver('s-02', dndId.roomRow(KEY, 'r-02'));
    expect(highlighted()).toEqual(['room r-02']);
  });
});

describe('строки сайдбара — цели броска карточки доски (задача 8)', () => {
  it('строка своего проекта подсвечивается под карточкой: и сессия, и комната', async () => {
    render(<Card entry={entryOf()} />);
    await dragCardOver(dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual(['s-04']);
    await release();
    await dragCardOver(dndId.roomRow(KEY, 'r-02'));
    expect(highlighted()).toEqual(['room r-02']);
  });

  it('работа не активная — строка всё равно цель; закрытая сессия и чужой проект — нет', async () => {
    act(() => useLayoutStore.setState({ activeWorkKey: workKey('/tmp/other', 'w-99') }));
    render(<Card entry={entryOf()} showClosed />);
    await dragCardOver(dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual(['s-04']);
    await release();
    await dragCardOver(dndId.sessionRow(KEY, 's-05'));
    expect(highlighted()).toEqual([]);
    await release();
    setBoard('/tmp/elsewhere');
    await dragCardOver(dndId.sessionRow(KEY, 's-04'));
    expect(highlighted()).toEqual([]);
  });
});

describe('лента — цель броска карточки доски (задача 8)', () => {
  const owners: FeedOwner[] = [{ roomId: 'r-01' }, { sessionId: 's-04' }, { sessionId: 's-05' }];
  /** id droppable, на котором кончился бросок; `null` — мимо целей (выключенную цель dnd-kit в коллизии не берёт). */
  const droppedOn = (ended: ReturnType<typeof vi.fn>): unknown => (ended.mock.calls.at(-1)?.[0] as DragEndEvent | undefined)?.over?.id ?? null;

  it('лента выключена, когда resolveCardDrop даёт null, и включена, когда цель есть', async () => {
    const ended = vi.fn();
    render(<Feeds owners={owners} onEnd={ended} />);
    // Живая комната и живая сессия своего проекта: цель есть — лента подсвечена и принимает бросок.
    await dragCardOver(dndId.feed(KEY, 'r-01'));
    expect(feedsOver()).toEqual(['r-01']);
    await release();
    expect(droppedOn(ended)).toBe(dndId.feed(KEY, 'r-01'));
    await dragCardOver(dndId.feed(KEY, 's-04'));
    expect(feedsOver()).toEqual(['s-04']);
    await release();
    expect(droppedOn(ended)).toBe(dndId.feed(KEY, 's-04'));
    // Закрытая сессия: цели нет — лента выключена, бросок мимо.
    await dragCardOver(dndId.feed(KEY, 's-05'));
    expect(feedsOver()).toEqual([]);
    await release();
    expect(droppedOn(ended)).toBeNull();
    // Карточки в сторе доски больше нет: бросать нечего — и живые ленты выключены.
    act(() => useBoardStore.setState({ slots: new Map() }));
    await dragCardOver(dndId.feed(KEY, 'r-01'));
    expect(feedsOver()).toEqual([]);
    await release();
    expect(droppedOn(ended)).toBeNull();
  });

  it('карточка другого проекта — у живых лент цели нет, лента выключена', async () => {
    const ended = vi.fn();
    setBoard('/tmp/elsewhere');
    render(<Feeds owners={owners} onEnd={ended} cardProject="/tmp/elsewhere" />);
    await dragCardOver(dndId.feed(KEY, 'r-01'));
    expect(feedsOver()).toEqual([]);
    await release();
    expect(droppedOn(ended)).toBeNull();
    await dragCardOver(dndId.feed(KEY, 's-04'));
    expect(feedsOver()).toEqual([]);
    await release();
    expect(droppedOn(ended)).toBeNull();
  });
});
