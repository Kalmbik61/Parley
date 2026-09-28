/**
 * Тест 10 куска 3.4: «New room» из меню карточки открывает `CreateRoomDialog` без
 * обязательного участника; прежний вызов «Create room with…» из меню строки — как был.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { CreateRoomDialog, type RoomCandidate } from './CreateRoomDialog.js';

let bridge: FakeBridge;

const candidates: RoomCandidate[] = [
  { id: 's-01', label: 'S01 plan', closed: false },
  { id: 's-02', label: 'S02 build', closed: false },
  { id: 's-03', label: 'S03 old', closed: true },
];

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('rooms.create', () => ({ roomId: 'r-01' }));
});

afterEach(cleanup);

function renderDialog(requiredMember: { id: string; label: string } | null, onOpenChange: (open: boolean) => void = () => {}): void {
  render(
    <CreateRoomDialog
      open
      bridge={bridge}
      projectPath="/tmp/proj"
      workId="w-01"
      requiredMember={requiredMember}
      candidates={candidates}
      onOpenChange={onOpenChange}
    />,
  );
}

describe('CreateRoomDialog — «New room» без обязательного участника (тест 10)', () => {
  it('заголовок New room; Create неактивна, пока никто не выбран; rooms.create — с выбранными', async () => {
    let open = true;
    renderDialog(null, (next) => (open = next));
    expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Sync' } });
    expect(create.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'S02 build' }));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);

    await waitFor(() => expect(open).toBe(false));
    expect(bridge.calls).toEqual([
      { method: 'rooms.create', params: { projectPath: '/tmp/proj', workId: 'w-01', title: 'Sync', members: ['s-02'] } },
    ]);
  });

  it('закрытая сессия недоступна для выбора', () => {
    renderDialog(null);
    expect((screen.getByRole('checkbox', { name: 'S03 old' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('CreateRoomDialog — «Create room with…» (как до 3.4)', () => {
  it('заголовок с участником, Create доступна сразу, участник — первым в members', async () => {
    renderDialog({ id: 's-09', label: 'S09 lead' });
    expect(screen.getByRole('heading', { name: 'Create room with S09 lead' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pair' } });
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(bridge.calls).toHaveLength(1));
    expect(bridge.calls[0]?.params).toMatchObject({ members: ['s-09'] });
  });
});
