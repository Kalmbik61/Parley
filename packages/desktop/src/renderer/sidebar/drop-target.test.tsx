/**
 * Строки сайдбара как цели броска сессии (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5): подсвечивается
 * только цель, на которую бросить можно — фон `accent 14 %` и inset-рамка 1.5px. На себя, в свою комнату, закрытую
 * сессию, в чужую работу (строка неактивной карточки), участнику комнаты и при хосте без нужного метода — не
 * подсвечивается и не принимает.
 *
 * Настоящий `DndContext` с порогом 4 px, как в окне; «под указателем» задаёт `collisionDetection` теста — jsdom
 * прямоугольников не считает. Выключенные droppable dnd-kit в него не передаёт: цель, которой нет в списке, не
 * подсветится.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DndContext, PointerSensor, useSensor, useSensors, type CollisionDetection } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkEntry } from '@harnas/core';
import { dndId } from '../layout/dnd.js';
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

function Card({ entry, showClosed = false }: { entry: WorkEntry; showClosed?: boolean }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection}>
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
            unread={0}
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

function connect(methods: readonly string[] = [...REQUIRED_METHODS, 'rooms.addMember']): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: [...methods] } });
}

/** Работа: s-01 и s-04 вне комнат, s-02 и s-03 — в комнате r-01, s-05 закрыта и вне комнат; вторая комната r-02 — s-06. */
function entryOf(): WorkEntry {
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
  connect();
  useProvidersStore.setState({ providers: [] });
  useUiStore.setState({ roomExpanded: {}, dark: false });
  useLayoutStore.setState({ activeWorkKey: KEY, layouts: {} });
  useWorksStore.setState({ entries: [entryOf()], branches: {}, loading: false, error: null });
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
    connect(REQUIRED_METHODS);
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
