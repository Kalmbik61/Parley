import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { refKey, type BacklogSnapshot, type SessionRef } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useBoardStore } from '../board/board-store.js';
import { focusComposer, setVisibilityCheck } from '../keys/type-to-focus.js';
import { cardDropFromDragEnd, dndId, dragItemOf, type DragSourceData } from '../layout/dnd.js';
import { useDragStore } from '../layout/drag-store.js';
import { workKey } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { Composer } from './Composer.js';

afterEach(() => {
  cleanup();
  setVisibilityCheck();
  vi.restoreAllMocks();
  useDictationStore.setState({ phase: 'idle', targetId: null });
});

function mount(text = '', onSubmit = vi.fn()) {
  return render(
    <Composer
      busy={false}
      visible={false}
      text={text}
      onTextChange={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
      bridge={createFakeBridge()}
      onSubmit={onSubmit}
      source={{ capabilities: null, listDir: () => Promise.resolve([]) }}
      onPickFiles={() => Promise.resolve([])}
      onPasteImage={() => Promise.resolve(null)}
      dictationId="chat:test"
    />,
  );
}

describe('Composer чата — набор с любого места', () => {
  it('смонтированное поле регистрируется и получает фокус, после размонтирования — нет', () => {
    setVisibilityCheck(() => true);
    const view = mount();
    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(view.container.querySelector('textarea'));

    view.unmount();
    expect(focusComposer()).toBe(false);
  });
});

describe('Composer чата — Enter/Send во время диктовки', () => {
  it('диктовка идёт: Enter завершает её и не отправляет', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(true);
    const onSubmit = vi.fn();
    mount('набранное', onSubmit);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('диктовки нет: Enter отправляет как раньше', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(false);
    const onSubmit = vi.fn();
    mount('набранное', onSubmit);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).toHaveBeenCalledWith('набранное', []);
  });

  it('запись в это поле при пустом тексте: Send доступен, нажатие не отправляет; без записи — недоступен', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(true);
    const onSubmit = vi.fn();
    mount('', onSubmit);
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    act(() => useDictationStore.setState({ phase: 'recording', targetId: 'chat:test' }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const KEY = workKey(PROJECT, WORK);
const OWNER: SessionRef = { projectPath: PROJECT, workId: WORK, sessionId: 's-04' };

/** Что «под указателем»: id droppable; пусто — ничего. jsdom прямоугольников не считает, поэтому тест ставит его сам. */
const pointer = { over: '' };

const collisionDetection: CollisionDetection = ({ droppableContainers }) => {
  const hit = droppableContainers.find((container) => String(container.id) === pointer.over);
  return hit === undefined ? [] : [{ id: hit.id, data: { droppableContainer: hit, value: 1 } }];
};

/** Карточка Backlog доски, которую можно тащить (в окне — `BoardCardView`). */
function CardSource(): JSX.Element {
  const data: DragSourceData = { item: { kind: 'card', projectPath: PROJECT, id: 'b-001', index: 0, title: 'Task' } };
  const { setNodeRef, listeners } = useDraggable({ id: dndId.card(`${PROJECT}#b-001`), data });
  return <div ref={setNodeRef} {...listeners} data-card-source="" />;
}

/**
 * Настоящее поле Chat в `DndContext` с порогом 4 px, как в окне. Что тащат, кладётся в стор жеста обработчиками, как в
 * `AppShell`. id диктовки в формате `chat:{refKey}` — по нему поле не должно узнавать владельца, только по `dropSession`.
 */
function DropField({ dropSession, onEnd }: { dropSession?: SessionRef; onEnd: (event: DragEndEvent) => void }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(event) => useDragStore.getState().setItem(dragItemOf(event.active.data.current))}
      onDragEnd={(event) => {
        useDragStore.getState().setItem(null);
        onEnd(event);
      }}
      onDragCancel={() => useDragStore.getState().setItem(null)}
    >
      <CardSource />
      <Composer
        busy={false}
        visible={false}
        text=""
        onTextChange={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
        bridge={createFakeBridge()}
        onSubmit={vi.fn()}
        source={{ capabilities: null, listDir: () => Promise.resolve([]) }}
        onPickFiles={() => Promise.resolve([])}
        onPasteImage={() => Promise.resolve(null)}
        dictationId={`chat:${refKey(OWNER)}`}
        {...(dropSession === undefined ? {} : { dropSession })}
      />
    </DndContext>
  );
}

/** Тащит карточку Backlog за порог и держит указатель над целью `over` (id droppable). Бросок — `release()`. */
async function dragCardOver(over: string): Promise<void> {
  pointer.over = over;
  const source = document.querySelector<HTMLElement>('[data-card-source]');
  if (source === null) throw new Error('карточки нет');
  fireEvent.pointerDown(source, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
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

describe('Composer чата — цель броска карточки доски (задача 9)', () => {
  beforeEach(() => {
    pointer.over = '';
    useDragStore.setState({ item: null });
    // Живая сессия s-04 в проекте карточки и сама карточка b-001 в Backlog: бросок на поле s-04 возможен.
    useWorksStore.setState({
      entries: [makeWork(WORK, { projectPath: PROJECT, sessions: [makeSession('s-04', 'четыре')] })],
      branches: {},
      loading: false,
      error: null,
    });
    const item = { id: 'b-001', title: 'Task', details: '', checked: false, section: null };
    const snapshot = { projectPath: PROJECT, sharedProjectPath: PROJECT, version: 'v1', items: [item] } as unknown as BacklogSnapshot;
    useBoardStore.setState({ slots: new Map([[PROJECT, { snapshot, live: true }]]), inboxPath: null });
  });

  it('с dropSession поле — цель броска карточки этой сессии', async () => {
    const ended = vi.fn();
    render(<DropField dropSession={OWNER} onEnd={ended} />);
    await dragCardOver(dndId.composer(KEY, 's-04'));
    expect(screen.getByTestId('chat-composer').getAttribute('data-card-over')).toBe('');
    await release();
    // Бросок разбирается так же, как в `AppShell`: поле ввода сессии s-04 в её работе.
    expect(cardDropFromDragEnd(ended.mock.calls.at(-1)?.[0] as DragEndEvent)).toMatchObject({
      workKey: KEY,
      target: { kind: 'composer', sessionId: 's-04' },
    });
    expect(screen.getByTestId('chat-composer').getAttribute('data-card-over')).toBeNull();
  });

  it('без dropSession цели нет', async () => {
    const ended = vi.fn();
    render(<DropField onEnd={ended} />);
    await dragCardOver(dndId.composer(KEY, 's-04'));
    // Карточку тащат, цель для неё в сторах есть — поле не берёт её только потому, что владельца не назвали.
    expect(useDragStore.getState().item?.kind).toBe('card');
    expect(screen.getByTestId('chat-composer').getAttribute('data-card-over')).toBeNull();
    await release();
    expect(ended).toHaveBeenCalledTimes(1);
    expect((ended.mock.calls.at(-1)?.[0] as DragEndEvent).over).toBeNull();
  });
});
