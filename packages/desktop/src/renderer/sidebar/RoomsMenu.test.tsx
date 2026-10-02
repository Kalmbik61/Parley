/** Тест 4 куска 3.4: меню комнат работы по `#`/`#N` карточки (спека 6.3). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Message } from '@parley/core';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';
import { makeLetter, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { RoomsMenu } from './RoomsMenu.js';

beforeEach(() => useUiStore.setState({ sidebarHolds: {} }));
afterEach(cleanup);

describe('RoomsMenu (тест 4)', () => {
  it('все комнаты работы со счётчиками непрочитанного человеком; выбор — onOpenRoom', () => {
    const map = makeWork('w-01', {
      rooms: [makeRoom('r-01', 'Design'), makeRoom('r-02', 'Backend')],
      messages: [makeLetter('m-1', { roomId: 'r-01', to: [] }), makeLetter('m-2', { roomId: 'r-01', to: [] })],
    }).map;
    const onOpenRoom = vi.fn();
    render(
      <RoomsMenu map={map} onOpenRoom={onOpenRoom}>
        <button type="button">#</button>
      </RoomsMenu>,
    );
    fireEvent.keyDown(screen.getByText('#'), { key: 'Enter' });

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Design2', 'Backend']);
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);

    fireEvent.click(within(menu).getByText('Backend'));
    expect(onOpenRoom).toHaveBeenCalledWith('r-02');
    expect(useUiStore.getState().sidebarHolds).toEqual({});
  });

  it('у комнаты с непрочитанным упоминанием человека перед числом — «@» акцентным цветом с подсказкой (Parley 0.3.0)', () => {
    const agent = (id: string, patch: Partial<Message>): Message =>
      makeLetter(id, { roomId: 'r-01', from: 's-02', to: [], ...patch });
    const map = makeWork('w-01', {
      rooms: [
        makeRoom('r-01', 'Design'),
        makeRoom('r-02', 'Backend'),
        makeRoom('r-03', 'Infra'),
        makeRoom('r-04', 'Docs'),
        makeRoom('r-05', 'Ops'),
      ],
      messages: [
        // Упоминание и обычное сообщение: число — все непрочитанные, «@» — упоминание среди них.
        agent('m-1', { text: 'Готово, @human' }),
        agent('m-2', { text: 'просто статус' }),
        // Непрочитанное без упоминания.
        agent('m-3', { roomId: 'r-02', text: 'ничего особенного' }),
        // Прочитанное упоминание, `@human` в коде и свои слова человека — упоминанием не считаются; у Infra
        // непрочитано только обычное сообщение рядом с прочитанным упоминанием.
        agent('m-4', { roomId: 'r-03', text: 'раз, @human', readBy: { human: 'x' } }),
        agent('m-5', { roomId: 'r-03', text: 'ещё один статус' }),
        agent('m-6', { roomId: 'r-04', text: 'запусти `@human`' }),
        agent('m-7', { roomId: 'r-05', from: 'human', text: 'сам, @human' }),
      ],
    }).map;
    render(
      <RoomsMenu map={map} onOpenRoom={vi.fn()}>
        <button type="button">#</button>
      </RoomsMenu>,
    );
    fireEvent.keyDown(screen.getByText('#'), { key: 'Enter' });

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Design@2',
      'Backend1',
      'Infra1',
      'Docs1',
      'Ops',
    ]);
    const marks = within(menu).getAllByText('@');
    expect(marks).toHaveLength(1);
    const mark = marks[0] as HTMLElement;
    expect(items[0]?.contains(mark)).toBe(true);
    expect(mark.className).toContain('text-accent-700');
    expect(mark.getAttribute('title')).toBe(S.rooms.humanMentionTitle);
    // «@» стоит прямо перед числом непрочитанного.
    expect(mark.nextSibling?.textContent).toBe('2');
  });
});
