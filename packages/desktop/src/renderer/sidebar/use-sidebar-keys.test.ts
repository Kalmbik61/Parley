/** Тест 6 куска 3.4: курсор клавиатуры сайдбара (спека 6.5). */

import { describe, expect, it } from 'vitest';
import { moveCursor, type SidebarCursor } from './use-sidebar-keys.js';

const cardA: SidebarCursor = { workKey: 'a', sessionId: null };
const rowA1: SidebarCursor = { workKey: 'a', sessionId: 's-01' };
const rowA2: SidebarCursor = { workKey: 'a', sessionId: 's-02' };
const cardB: SidebarCursor = { workKey: 'b', sessionId: null };
const ORDER = [cardA, rowA1, rowA2, cardB];

describe('moveCursor (тест 6)', () => {
  it('↓ с последней строки остаётся на ней; ↑ с первой — на ней', () => {
    expect(moveCursor(ORDER, cardB, 'ArrowDown')).toEqual(cardB);
    expect(moveCursor(ORDER, cardA, 'ArrowUp')).toEqual(cardA);
  });

  it('переход между карточками идёт через строки сессий', () => {
    expect(moveCursor(ORDER, cardA, 'ArrowDown')).toEqual(rowA1);
    expect(moveCursor(ORDER, rowA1, 'ArrowDown')).toEqual(rowA2);
    expect(moveCursor(ORDER, rowA2, 'ArrowDown')).toEqual(cardB);
    expect(moveCursor(ORDER, cardB, 'ArrowUp')).toEqual(rowA2);
  });

  it('курсора нет или его элемент пропал — ↓ на первый, ↑ на последний; пустой порядок — null', () => {
    expect(moveCursor(ORDER, null, 'ArrowDown')).toEqual(cardA);
    expect(moveCursor(ORDER, null, 'ArrowUp')).toEqual(cardB);
    expect(moveCursor(ORDER, { workKey: 'gone', sessionId: null }, 'ArrowDown')).toEqual(cardA);
    expect(moveCursor([], cardA, 'ArrowDown')).toBeNull();
  });
});

// Кусок 5 плана «Organic»: строка комнаты — тоже элемент курсора (`roomId`), между карточкой и строками сессий.
describe('moveCursor — строка комнаты (кусок 5)', () => {
  const roomA: SidebarCursor = { workKey: 'a', sessionId: null, roomId: 'r-01' };
  const inRoom: SidebarCursor = { workKey: 'a', sessionId: 's-01' };
  const ORDER_WITH_ROOM = [cardA, roomA, inRoom, rowA2, cardB];

  it('карточка → комната → участник → следующая строка; ↑ идёт обратно тем же путём', () => {
    expect(moveCursor(ORDER_WITH_ROOM, cardA, 'ArrowDown')).toEqual(roomA);
    expect(moveCursor(ORDER_WITH_ROOM, roomA, 'ArrowDown')).toEqual(inRoom);
    expect(moveCursor(ORDER_WITH_ROOM, inRoom, 'ArrowUp')).toEqual(roomA);
    expect(moveCursor(ORDER_WITH_ROOM, roomA, 'ArrowUp')).toEqual(cardA);
  });

  it('комната и карточка с одним workKey — разные позиции; комната одной работы не путается с комнатой другой', () => {
    expect(moveCursor(ORDER_WITH_ROOM, { workKey: 'a', sessionId: null, roomId: null }, 'ArrowDown')).toEqual(roomA);
    // Комнаты `r-01` другой работы в порядке нет — курсор «потерян»: ↓ на первый.
    expect(moveCursor(ORDER_WITH_ROOM, { workKey: 'b', sessionId: null, roomId: 'r-01' }, 'ArrowDown')).toEqual(cardA);
  });
});
