/**
 * Кусок 2.6 (спека 5.4): чистые части перетаскивания — зона по точке,
 * `applyDrop`, разбор `onDragEnd` и `layoutCollision`. Тесты 1–5, 7, 9, 11
 * (часть про столкновения) и 14 брифа.
 */

import { describe, expect, it } from 'vitest';
import type { Active, ClientRect, DragEndEvent, DroppableContainer, Over } from '@dnd-kit/core';
import type { GroupNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import {
  acceptsTerminal,
  applyDrop,
  dndId,
  dropFromDragEnd,
  layoutCollision,
  zoneForPoint,
  type DragItem,
  type DragSourceData,
  type DropTargetData,
} from './dnd.js';
import { tabId } from './ids.js';
import { emptyLayout, groups, openTab, splitGroup, type GroupSizes } from './tree.js';

function term(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

function groupById(layout: WorkLayout, id: string): GroupNode {
  const found = groups(layout).find((group) => group.id === id);
  if (found === undefined) throw new Error(`группа не найдена: ${id}`);
  return found;
}

/** Две группы рядом: слева s-1, s-2; справа s-3. */
function twoGroups(): { layout: WorkLayout; left: string; right: string } {
  let layout = openTab(openTab(emptyLayout(), term('s-1')), term('s-2'));
  const left = layout.activeGroupId;
  const result = splitGroup(layout, left, 'row', term('s-3'));
  if (result.error !== null) throw new Error(result.error);
  layout = result.layout;
  return { layout, left, right: layout.activeGroupId };
}

/** `n` групп по одной вкладке. */
function nGroups(n: number): WorkLayout {
  let layout = openTab(emptyLayout(), term('g-0'));
  for (let i = 1; i < n; i += 1) {
    const result = splitGroup(
      layout,
      layout.activeGroupId,
      i % 2 === 0 ? 'column' : 'row',
      term(`g-${i}`),
    );
    if (result.error !== null) throw new Error(result.error);
    layout = result.layout;
  }
  return layout;
}

const BIG: GroupSizes = new Proxy({}, { get: () => ({ width: 2000, height: 2000 }) }) as GroupSizes;

describe('zoneForPoint (тест 1)', () => {
  const body = { left: 100, top: 50, width: 1000, height: 400 };

  it('точка в центре — center', () => {
    expect(zoneForPoint({ x: 600, y: 250 }, body, 'g-a')).toEqual({
      kind: 'center',
      groupId: 'g-a',
    });
  });

  it('x на 24% ширины — край left, на 26% — center', () => {
    expect(zoneForPoint({ x: 100 + 240, y: 250 }, body, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'left',
    });
    expect(zoneForPoint({ x: 100 + 260, y: 250 }, body, 'g-a')).toEqual({
      kind: 'center',
      groupId: 'g-a',
    });
    expect(zoneForPoint({ x: 100 + 740, y: 250 }, body, 'g-a')).toEqual({
      kind: 'center',
      groupId: 'g-a',
    });
    expect(zoneForPoint({ x: 100 + 770, y: 250 }, body, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'right',
    });
  });

  it('y у верха и низа — top и bottom', () => {
    expect(zoneForPoint({ x: 600, y: 50 + 90 }, body, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'top',
    });
    expect(zoneForPoint({ x: 600, y: 50 + 310 }, body, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'bottom',
    });
  });

  it('угол (5%, 5%) — ближайшая сторона в пикселях', () => {
    // 5% ширины 1000 = 50 px до левого края, 5% высоты 400 = 20 px до верхнего.
    expect(zoneForPoint({ x: 100 + 50, y: 50 + 20 }, body, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'top',
    });
    // Высокое тело: теперь ближе левый край.
    const tall = { left: 0, top: 0, width: 400, height: 1000 };
    expect(zoneForPoint({ x: 20, y: 50 }, tall, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'left',
    });
    // Правый нижний угол.
    expect(zoneForPoint({ x: 380, y: 950 }, tall, 'g-a')).toEqual({
      kind: 'edge',
      groupId: 'g-a',
      edge: 'right',
    });
  });
});

describe('applyDrop — вкладки (тесты 2, 3)', () => {
  it('тест 2: вкладка в строку другой группы на индекс 0 — первая там', () => {
    const { layout, left, right } = twoGroups();
    const result = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:s-1' },
      { kind: 'strip', groupId: right, index: 0 },
      BIG,
    );
    expect(result.error).toBeNull();
    expect(groupById(result.layout, right).tabs.map((tab) => tab.id)).toEqual([
      'terminal:s-1',
      'terminal:s-3',
    ]);
    expect(groupById(result.layout, left).tabs.map((tab) => tab.id)).toEqual(['terminal:s-2']);
  });

  it('индекс строки — место вставки: вправо в своей группе встаёт перед вкладкой цели', () => {
    const layout = openTab(openTab(openTab(emptyLayout(), term('a')), term('b')), term('c'));
    const groupId = layout.activeGroupId;
    // Место 2 — между b и c: a уходит туда, итог b, a, c.
    const result = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:a' },
      { kind: 'strip', groupId, index: 2 },
      BIG,
    );
    expect(groupById(result.layout, groupId).tabs.map((tab) => tab.id)).toEqual([
      'terminal:b',
      'terminal:a',
      'terminal:c',
    ]);
    // Место 0 для c — в начало.
    const back = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:c' },
      { kind: 'strip', groupId, index: 0 },
      BIG,
    );
    expect(groupById(back.layout, groupId).tabs.map((tab) => tab.id)).toEqual([
      'terminal:c',
      'terminal:a',
      'terminal:b',
    ]);
  });

  it('вкладка в центр тела — последней в группе', () => {
    const { layout, right } = twoGroups();
    const result = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:s-1' },
      { kind: 'center', groupId: right },
      BIG,
    );
    expect(groupById(result.layout, right).tabs.map((tab) => tab.id)).toEqual([
      'terminal:s-3',
      'terminal:s-1',
    ]);
  });

  it('тест 3: вкладка к правому краю — сплит row, новая группа второй', () => {
    const layout = openTab(openTab(emptyLayout(), term('a')), term('b'));
    const groupId = layout.activeGroupId;
    const result = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:b' },
      { kind: 'edge', groupId, edge: 'right' },
      BIG,
    );
    expect(result.error).toBeNull();
    const root = result.layout.root;
    if (root.type !== 'split') throw new Error('ожидался сплит');
    expect(root.direction).toBe('row');
    expect(root.children[0].id).toBe(groupId);
    const second = root.children[1];
    if (second.type !== 'group') throw new Error('ожидалась группа');
    expect(second.tabs.map((tab) => tab.id)).toEqual(['terminal:b']);
    expect(result.layout.activeGroupId).toBe(second.id);
  });
});

describe('applyDrop — сессии (тесты 4, 5, 14)', () => {
  it('тест 4: сессия в центр — вкладка терминала создана в группе; уже открытая в другой группе переносится', () => {
    const { layout, left, right } = twoGroups();
    const opened = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-9' },
      { kind: 'center', groupId: right },
      BIG,
    );
    expect(opened.error).toBeNull();
    expect(groupById(opened.layout, right).tabs.map((tab) => tab.id)).toEqual([
      'terminal:s-3',
      'terminal:s-9',
    ]);
    expect(groupById(opened.layout, right).activeTabId).toBe('terminal:s-9');

    const moved = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-1' },
      { kind: 'center', groupId: right },
      BIG,
    );
    expect(groupById(moved.layout, right).tabs.map((tab) => tab.id)).toEqual([
      'terminal:s-3',
      'terminal:s-1',
    ]);
    expect(groupById(moved.layout, left).tabs.map((tab) => tab.id)).toEqual(['terminal:s-2']);
  });

  it('сессия в строку — на место', () => {
    const { layout, right } = twoGroups();
    const result = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-9' },
      { kind: 'strip', groupId: right, index: 0 },
      BIG,
    );
    expect(groupById(result.layout, right).tabs.map((tab) => tab.id)).toEqual([
      'terminal:s-9',
      'terminal:s-3',
    ]);
  });

  it('тест 5: к краю при 8 группах — too-many-groups', () => {
    const layout = nGroups(8);
    const target = groups(layout)[0]!.id;
    const tab = applyDrop(
      layout,
      { kind: 'tab', tabId: 'terminal:g-3' },
      { kind: 'edge', groupId: target, edge: 'right' },
      BIG,
    );
    // Исходная группа g-3 пустеет и исчезает — число групп не растёт.
    expect(tab.error).toBeNull();
    const session = applyDrop(
      layout,
      { kind: 'session', sessionId: 'new' },
      { kind: 'edge', groupId: target, edge: 'right' },
      BIG,
    );
    expect(session.error).toBe('too-many-groups');
    expect(session.layout).toBe(layout);
  });

  it('тест 14: сессия к левому краю — слева новая группа с её терминалом и она активна; при 8 группах отказ той же ссылкой', () => {
    const { layout, right } = twoGroups();
    const result = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-9' },
      { kind: 'edge', groupId: right, edge: 'left' },
      BIG,
    );
    expect(result.error).toBeNull();
    const all = groups(result.layout);
    expect(all).toHaveLength(3);
    const index = all.findIndex((group) => group.id === right);
    const newGroup = all[index - 1]!;
    expect(newGroup.tabs.map((tab) => tab.id)).toEqual(['terminal:s-9']);
    expect(result.layout.activeGroupId).toBe(newGroup.id);
    // Активная вкладка цели — прежняя.
    expect(groupById(result.layout, right).activeTabId).toBe('terminal:s-3');
    expect(groupById(result.layout, right).tabs.map((tab) => tab.id)).toEqual(['terminal:s-3']);

    const full = nGroups(8);
    const target = groups(full)[2]!;
    const refused = applyDrop(
      full,
      { kind: 'session', sessionId: 's-9' },
      { kind: 'edge', groupId: target.id, edge: 'left' },
      BIG,
    );
    expect(refused.error).toBe('too-many-groups');
    expect(refused.layout).toBe(full);
    expect(groupById(refused.layout, target.id).activeTabId).toBe(target.activeTabId);
  });

  it('уже открытая сессия к краю — сразу moveTab', () => {
    const { layout, left, right } = twoGroups();
    const result = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-1' },
      { kind: 'edge', groupId: right, edge: 'bottom' },
      BIG,
    );
    expect(result.error).toBeNull();
    expect(groupById(result.layout, left).tabs.map((tab) => tab.id)).toEqual(['terminal:s-2']);
    expect(groupById(result.layout, result.layout.activeGroupId).tabs.map((tab) => tab.id)).toEqual(
      ['terminal:s-1'],
    );
  });

  it('too-small от moveTab второй операции — прежняя раскладка', () => {
    const { layout, right } = twoGroups();
    const small: GroupSizes = { [right]: { width: 300, height: 300 } };
    const result = applyDrop(
      layout,
      { kind: 'session', sessionId: 's-9' },
      { kind: 'edge', groupId: right, edge: 'left' },
      small,
    );
    expect(result.error).toBe('too-small');
    expect(result.layout).toBe(layout);
  });
});

describe('acceptsTerminal', () => {
  it('в этапе 2 терминал не принимает ни вкладку, ни сессию', () => {
    expect(acceptsTerminal({ kind: 'tab', tabId: 'mail' })).toBe(false);
    expect(acceptsTerminal({ kind: 'session', sessionId: 's-1' })).toBe(false);
  });
});

const RECT: ClientRect = { left: 0, top: 0, width: 1000, height: 400, right: 1000, bottom: 400 };

function activeOf(item: DragItem): Active {
  const data: DragSourceData = { item };
  return {
    id: 'drag',
    data: { current: data },
    rect: { current: { initial: null, translated: null } },
  } as Active;
}

function overOf(data: DropTargetData, rect: ClientRect = RECT): Over {
  return { id: 'over', rect, disabled: false, data: { current: data } } as Over;
}

function endEvent(
  item: DragItem,
  over: Over | null,
  point: { x: number; y: number },
): DragEndEvent {
  return {
    active: activeOf(item),
    over,
    delta: { x: point.x - 10, y: point.y - 10 },
    activatorEvent: new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }),
    collisions: null,
  } as DragEndEvent;
}

describe('dropFromDragEnd (тест 7)', () => {
  it('active строки сессии и over края тела — session и edge', () => {
    const drop = dropFromDragEnd(
      endEvent(
        { kind: 'session', sessionId: 's-1' },
        overOf({ workKey: 'A', kind: 'body', groupId: 'g-a' }),
        { x: 990, y: 200 },
      ),
    );
    expect(drop).toEqual({
      item: { kind: 'session', sessionId: 's-1' },
      zone: { kind: 'edge', groupId: 'g-a', edge: 'right' },
    });
  });

  it('over: null — null', () => {
    expect(
      dropFromDragEnd(endEvent({ kind: 'session', sessionId: 's-1' }, null, { x: 5, y: 5 })),
    ).toBeNull();
  });

  it('вкладка строки: правая половина — место после неё, левая — перед', () => {
    const tabRect: ClientRect = {
      left: 100,
      top: 0,
      width: 100,
      height: 32,
      right: 200,
      bottom: 32,
    };
    const data = {
      workKey: 'A',
      kind: 'strip',
      groupId: 'g-a',
      index: 3,
      item: { kind: 'tab', tabId: 'mail' },
    } as DropTargetData;
    const right = dropFromDragEnd(
      endEvent({ kind: 'tab', tabId: 'x' }, overOf(data, tabRect), { x: 170, y: 10 }),
    );
    expect(right?.zone).toEqual({ kind: 'strip', groupId: 'g-a', index: 4 });
    const left = dropFromDragEnd(
      endEvent({ kind: 'tab', tabId: 'x' }, overOf(data, tabRect), { x: 120, y: 10 }),
    );
    expect(left?.zone).toEqual({ kind: 'strip', groupId: 'g-a', index: 3 });
  });

  it('хвост строки — индекс как есть', () => {
    const drop = dropFromDragEnd(
      endEvent(
        { kind: 'tab', tabId: 'x' },
        overOf({ workKey: 'A', kind: 'strip', groupId: 'g-a', index: 2 }),
        { x: 990, y: 10 },
      ),
    );
    expect(drop?.zone).toEqual({ kind: 'strip', groupId: 'g-a', index: 2 });
  });

  it('тест 10 (часть): over поверхности терминала — zone terminal с sessionId', () => {
    const drop = dropFromDragEnd(
      endEvent(
        { kind: 'tab', tabId: 'x' },
        overOf({ workKey: 'A', kind: 'terminal', sessionId: 's-7' }),
        { x: 500, y: 200 },
      ),
    );
    expect(drop?.zone).toEqual({ kind: 'terminal', sessionId: 's-7' });
  });

  it('active без предмета — null', () => {
    const event = endEvent(
      { kind: 'tab', tabId: 'x' },
      overOf({ workKey: 'A', kind: 'body', groupId: 'g' }),
      { x: 5, y: 5 },
    );
    const bare = {
      ...event,
      active: { ...event.active, data: { current: undefined } },
    } as DragEndEvent;
    expect(dropFromDragEnd(bare)).toBeNull();
  });
});

function container(id: string, data: DropTargetData, disabled = false): DroppableContainer {
  return {
    id,
    key: id,
    data: { current: data },
    disabled,
    node: { current: null },
    rect: { current: null },
  } as DroppableContainer;
}

function collide(
  activeWorkKey: string | null,
  item: DragItem,
  containers: DroppableContainer[],
  rects: Record<string, ClientRect>,
  point: { x: number; y: number },
  accepts?: (item: DragItem) => boolean,
) {
  const detect =
    accepts === undefined
      ? layoutCollision(activeWorkKey)
      : layoutCollision(activeWorkKey, accepts);
  return detect({
    active: activeOf(item),
    collisionRect: { ...RECT, width: 10, height: 10, right: 10, bottom: 10 },
    droppableRects: new Map(Object.entries(rects)),
    droppableContainers: containers,
    pointerCoordinates: point,
  });
}

describe('layoutCollision (тесты 9, 11)', () => {
  const body = container(dndId.body('A', 'g-a'), { workKey: 'A', kind: 'body', groupId: 'g-a' });
  const surface = container(dndId.terminal('A', 'terminal:s-1'), {
    workKey: 'A',
    kind: 'terminal',
    sessionId: 's-1',
  });
  const rects = { [body.id]: RECT, [surface.id]: RECT };

  it('тест 9: над поверхностью в центре тела вкладка и сессия видят тело, принимаемый предмет — терминал', () => {
    for (const item of [
      { kind: 'tab', tabId: 'mail' },
      { kind: 'session', sessionId: 's-2' },
    ] as DragItem[]) {
      const hits = collide('A', item, [surface, body], rects, { x: 500, y: 200 });
      expect(hits[0]?.id).toBe(body.id);
      const data = hits[0]?.data?.droppableContainer.data.current as DropTargetData;
      expect(data.kind).toBe('body');
      expect(zoneForPoint({ x: 500, y: 200 }, RECT, 'g-a')).toEqual({
        kind: 'center',
        groupId: 'g-a',
      });
    }
    const fake = { kind: 'file', path: '/tmp/x' } as unknown as DragItem;
    const hits = collide('A', fake, [body, surface], rects, { x: 500, y: 200 }, () => true);
    expect(hits[0]?.id).toBe(surface.id);
    expect(hits[0]?.data?.droppableContainer.data.current).toEqual({
      workKey: 'A',
      kind: 'terminal',
      sessionId: 's-1',
    });
  });

  it('тест 11: тела работ A и B на одном прямоугольнике — layoutCollision(A) отдаёт тело A', () => {
    const bodyB = container(dndId.body('B', 'g-b'), { workKey: 'B', kind: 'body', groupId: 'g-b' });
    const both = { [body.id]: RECT, [bodyB.id]: RECT };
    expect(
      collide('A', { kind: 'tab', tabId: 'mail' }, [bodyB, body], both, { x: 500, y: 200 }).map(
        (hit) => hit.id,
      ),
    ).toEqual([body.id]);
    expect(
      collide('B', { kind: 'tab', tabId: 'mail' }, [bodyB, body], both, { x: 500, y: 200 }).map(
        (hit) => hit.id,
      ),
    ).toEqual([bodyB.id]);
    expect(
      collide(null, { kind: 'tab', tabId: 'mail' }, [bodyB, body], both, { x: 500, y: 200 }),
    ).toEqual([]);
  });

  it('вкладка строки важнее хвоста строки; вне прямоугольников — пусто', () => {
    const tail = container(dndId.strip('A', 'g-a'), {
      workKey: 'A',
      kind: 'strip',
      groupId: 'g-a',
      index: 2,
    });
    const tab = container(dndId.tab('A', 'mail'), {
      workKey: 'A',
      kind: 'strip',
      groupId: 'g-a',
      index: 0,
    });
    const stripRects = {
      [tail.id]: { left: 0, top: 0, width: 600, height: 32, right: 600, bottom: 32 },
      [tab.id]: { left: 0, top: 0, width: 100, height: 32, right: 100, bottom: 32 },
    };
    expect(
      collide('A', { kind: 'tab', tabId: 'x' }, [tail, tab], stripRects, { x: 50, y: 10 })[0]?.id,
    ).toBe(tab.id);
    expect(
      collide('A', { kind: 'tab', tabId: 'x' }, [tail, tab], stripRects, { x: 300, y: 10 })[0]?.id,
    ).toBe(tail.id);
    expect(
      collide('A', { kind: 'tab', tabId: 'x' }, [tail, tab], stripRects, { x: 300, y: 100 }),
    ).toEqual([]);
  });

  it('выключенные контейнеры пропускаются', () => {
    const off = container(
      dndId.terminal('A', 'terminal:s-2'),
      { workKey: 'A', kind: 'terminal', sessionId: 's-2' },
      true,
    );
    const hits = collide(
      'A',
      { kind: 'file' } as unknown as DragItem,
      [off, surface, body],
      { ...rects, [off.id]: RECT },
      { x: 500, y: 200 },
      () => true,
    );
    expect(hits[0]?.id).toBe(surface.id);
  });
});
