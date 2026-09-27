/** Тест 4 куска 3.4: меню комнат работы по `#`/`#N` карточки (спека 6.3). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
});
