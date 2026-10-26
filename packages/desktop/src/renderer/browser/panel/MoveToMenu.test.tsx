/**
 * Подменю «Move to browser of…» в «⋯» вкладки браузера человека (спека браузера 3.10; этап B2, часть 1): сессии и комнаты
 * работы — те же списки, что у меню «To»; выбор отдаёт хозяина колбэку.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowWorkEntry } from '@parley/core';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/dropdown-menu.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { MoveToMenu } from './MoveToMenu.js';

const LONG = 'x'.repeat(60);
const WORK = makeWork('w-01', {
  sessions: [makeSession('s-01', `backend ${LONG}`), makeSession('s-02', 'helper', { provider: 'codex' }), makeSession('s-03', 'gone', { lifecycle: 'closed' })],
  rooms: [makeRoom('r-01', `review ${LONG}`), { ...makeRoom('r-02', 'archived room'), archivedAt: '2026-10-08T12:00:00.000Z' }],
});

afterEach(cleanup);

function renderMenu(entry: WindowWorkEntry, onMove = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>меню</DropdownMenuTrigger>
      <DropdownMenuContent>
        <MoveToMenu entry={entry} onMove={onMove} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return onMove;
}

function openSub(): HTMLElement {
  fireEvent.keyDown(screen.getByTestId('browser-move-to'), { key: 'ArrowRight' });
  return screen.getAllByRole('menu').at(-1) as HTMLElement;
}

describe('MoveToMenu', () => {
  it('пункт «Move to browser of…» открывает список: Sessions и Rooms без закрытой сессии и архивной комнаты', () => {
    renderMenu(WORK);
    expect(screen.getByTestId('browser-move-to').textContent).toBe('Move to browser of…');
    const sub = openSub();
    expect(within(sub).getByText('Sessions')).toBeTruthy();
    expect(within(sub).getByText('Rooms')).toBeTruthy();
    expect(within(sub).getAllByRole('menuitem').map((item) => item.getAttribute('data-owner-key'))).toEqual(['session:s-01', 'session:s-02', 'room:r-01']);
  });

  it('длинные ярлык и название режутся на экране, целиком — в подсказке', () => {
    renderMenu(WORK);
    const [session, , room] = within(openSub()).getAllByRole('menuitem') as [HTMLElement, HTMLElement, HTMLElement];
    expect(session.getAttribute('title')).toBe(`S01 backend ${LONG}`);
    expect(session.querySelector('span.truncate')?.textContent).toBe(`S01 backend ${LONG}`);
    expect(room.getAttribute('title')).toBe(`review ${LONG}`);
  });

  it('выбор пункта — onMove с хозяином: сессия и комната', () => {
    const onMove = renderMenu(WORK);
    fireEvent.click(within(openSub()).getAllByRole('menuitem')[1] as HTMLElement);
    expect(onMove).toHaveBeenCalledWith({ kind: 'session', sessionId: 's-02' });
    cleanup();
    const second = renderMenu(WORK);
    fireEvent.click(within(openSub()).getAllByRole('menuitem')[2] as HTMLElement);
    expect(second).toHaveBeenCalledWith({ kind: 'room', roomId: 'r-01' });
  });

  it('ни сессий, ни комнат — подменю неактивно', () => {
    renderMenu(makeWork('w-02'));
    expect(screen.getByTestId('browser-move-to').getAttribute('aria-disabled')).toBe('true');
  });
});
