/**
 * Стор тащимого предмета (`layout/drag-store.ts`): `AppShell` кладёт предмет на старте жеста и убирает на конце и отмене.
 * Движение указателя стор не трогает, а читатель стора — лента как цель броска карточки — от него не перерисовывается, в
 * отличие от `useDndContext()`, который меняется на каждое движение.
 *
 * Настоящий `DndContext` с порогом 4 px, как в окне; обработчики пишут стор так же, как `AppShell`. «Под указателем»
 * целей нет — нужен только сам жест.
 */

import { Profiler } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workKey } from '../lib/tree-order.js';
import { useFeedDropTarget } from '../sidebar/use-drop-target.js';
import { dndId, dragItemOf, type DragItem, type DragSourceData } from './dnd.js';
import { useDragStore } from './drag-store.js';

const CARD: DragItem = { kind: 'card', projectPath: '/p', id: 'b-001', index: 0, title: 'Task' };

function Source(): JSX.Element {
  const data: DragSourceData = { item: CARD };
  const { setNodeRef, listeners } = useDraggable({ id: dndId.card('/p#b-001'), data });
  return <div ref={setNodeRef} {...listeners} data-source="" />;
}

/** Читатель стора, как лента комнаты и Chat в окне: цель броска карточки. */
function Feed(): JSX.Element {
  const { setNodeRef } = useFeedDropTarget(workKey('/p', 'w-01'), { roomId: 'r-01' });
  return <div ref={setNodeRef} data-feed="" />;
}

/** `DndContext` окна: предмет — в стор на старте жеста, убирается на конце и отмене. `onRender` — коммиты ленты. */
function Stage({ onRender }: { onRender: () => void }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext
      sensors={sensors}
      onDragStart={(event) => {
        useDragStore.getState().setItem(dragItemOf(event.active.data.current));
      }}
      onDragEnd={() => {
        useDragStore.getState().setItem(null);
      }}
      onDragCancel={() => {
        useDragStore.getState().setItem(null);
      }}
    >
      <Source />
      <Profiler id="feed" onRender={onRender}>
        <Feed />
      </Profiler>
    </DndContext>
  );
}

/** Нажимает на карточку; жест начнётся, когда указатель уйдёт дальше 4 px (`move`). */
function pressCard(onRender: () => void = () => {}): void {
  render(<Stage onRender={onRender} />);
  const source = document.querySelector<HTMLElement>('[data-source]');
  if (source === null) throw new Error('тащимого нет');
  fireEvent.pointerDown(source, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
}

async function move(x: number): Promise<void> {
  fireEvent.pointerMove(document, { isPrimary: true, clientX: x, clientY: 10 });
  await act(async () => {});
}

beforeEach(() => {
  useDragStore.setState({ item: null });
});

afterEach(() => {
  // Незаконченный жест держит слушатели dnd-kit на document дольше теста, и его `onDragEnd` написал бы в стор следующему.
  fireEvent.pointerUp(document, { isPrimary: true });
  cleanup();
});

describe('стор тащимого предмета', () => {
  it('предмет попадает в стор, когда указатель перешёл порог 4 px, а не при нажатии', async () => {
    pressCard();
    expect(useDragStore.getState().item).toBeNull();
    await move(12);
    expect(useDragStore.getState().item).toBeNull();
    await move(30);
    expect(useDragStore.getState().item).toBe(CARD);
  });

  it('движение указателя не меняет предмет в сторе; сброс — на drop', async () => {
    pressCard();
    await move(30);
    const held = useDragStore.getState().item;
    expect(held).toBe(CARD);
    const changes = vi.fn();
    const unsubscribe = useDragStore.subscribe(changes);
    for (const x of [34, 48, 80, 120]) await move(x);
    unsubscribe();
    expect(changes).not.toHaveBeenCalled();
    expect(useDragStore.getState().item).toBe(held);
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 120, clientY: 10 });
    await act(async () => {});
    expect(useDragStore.getState().item).toBeNull();
  });

  it('отмена жеста (Esc) сбрасывает предмет', async () => {
    pressCard();
    await move(30);
    expect(useDragStore.getState().item).toBe(CARD);
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await act(async () => {});
    expect(useDragStore.getState().item).toBeNull();
  });

  it('читатель стора — лента как цель броска — не перерисовывается от движения указателя', async () => {
    const rendered = vi.fn();
    pressCard(rendered);
    // Старт жеста будит ленту; второе движение даёт dnd-kit осесть, и считаем только то, что принесёт дальнейшее.
    await move(30);
    await move(32);
    rendered.mockClear();
    for (const x of [40, 60, 90, 130]) await move(x);
    expect(rendered).not.toHaveBeenCalled();
  });
});
