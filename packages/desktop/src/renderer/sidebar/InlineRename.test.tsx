/** Тест 3 куска 3.4: переименование работы на месте (спека 6.4). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { InlineRename, RoomInlineRename, SessionInlineRename } from './InlineRename.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;
const entry = makeWork('w-01', { projectPath: '/tmp/proj', title: 'Redesign' });

function renderRename(onDone = vi.fn()): { input: HTMLInputElement; onDone: ReturnType<typeof vi.fn> } {
  render(<InlineRename entry={entry} bridge={bridge} onDone={onDone} />);
  return { input: screen.getByRole('textbox') as HTMLInputElement, onDone };
}

const renames = (): unknown[] => bridge.calls.filter((call) => call.method === 'works.rename').map((call) => call.params);

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('works.rename', () => ({ ok: true as const }));
  useUiStore.setState({ sidebarHolds: {} });
  vi.mocked(toast).mockClear();
});

afterEach(cleanup);

describe('InlineRename (тест 3)', () => {
  it('поле с названием, выделено всё; держит порядок сайдбара, пока открыто', () => {
    const { input } = renderRename();
    expect(input.value).toBe('Redesign');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Redesign'.length]);
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
    cleanup();
    expect(useUiStore.getState().sidebarHolds).toEqual({});
  });

  it('безымянная работа: поле открывается на «Untitled workspace»; без изменений хост не зовётся', () => {
    const untitled = makeWork('w-02', { projectPath: '/tmp/proj', title: 'untitled' });
    const onDone = vi.fn();
    render(<InlineRename entry={untitled} bridge={bridge} onDone={onDone} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Untitled workspace');
    fireEvent.blur(input);
    expect(onDone).toHaveBeenCalled();
    expect(renames()).toEqual([]);
  });

  it('Enter зовёт works.rename с новым названием', async () => {
    const { input, onDone } = renderRename();
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(renames()).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', title: 'New title' }]);
  });

  it('Esc не зовёт и закрывает поле', () => {
    const { input, onDone } = renderRename();
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
    expect(renames()).toEqual([]);
  });

  it('потеря фокуса с изменённым названием — зовёт; без изменений — нет', async () => {
    const first = renderRename();
    fireEvent.change(first.input, { target: { value: 'Other' } });
    fireEvent.blur(first.input);
    await waitFor(() => expect(first.onDone).toHaveBeenCalled());
    expect(renames()).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', title: 'Other' }]);
    cleanup();

    const second = renderRename();
    fireEvent.blur(second.input);
    expect(second.onDone).toHaveBeenCalled();
    expect(renames()).toHaveLength(1);
  });

  it('bad_request хоста — тост «Couldn\'t rename workspace: invalid request.», поле закрыто', async () => {
    bridge.setHandler('works.rename', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'пустое название' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input, onDone } = renderRename();
    fireEvent.change(input, { target: { value: 'Bad' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't rename workspace: invalid request."));
    expect(onDone).toHaveBeenCalled();
    // Повторная потеря фокуса после ответа не шлёт второй вызов.
    act(() => fireEvent.blur(input));
    expect(renames()).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('RoomInlineRename — то же поле в строке комнаты', () => {
  const roomRenames = (): unknown[] => bridge.calls.filter((call) => call.method === 'rooms.rename').map((call) => call.params);

  beforeEach(() => bridge.setHandler('rooms.rename', () => ({ ok: true as const })));

  function renderRoom(title: string, onDone = vi.fn()): { input: HTMLInputElement; onDone: ReturnType<typeof vi.fn> } {
    render(<RoomInlineRename projectPath="/tmp/proj" workId="w-01" room={makeRoom('r-02', title)} bridge={bridge} onDone={onDone} />);
    return { input: screen.getByRole('textbox', { name: 'Room name' }) as HTMLInputElement, onDone };
  }

  it('открывается на названии комнаты, выделено всё; Enter зовёт rooms.rename с комнатой', async () => {
    const { input, onDone } = renderRoom('Refunds');
    expect(input.value).toBe('Refunds');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Refunds'.length]);
    fireEvent.change(input, { target: { value: 'Payments' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(roomRenames()).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: 'r-02', title: 'Payments' }]);
    expect(renames()).toEqual([]);
  });

  it('безымянная комната — поле на «Room»; пустое и без изменений хосту не уходят', () => {
    const first = renderRoom('');
    expect(first.input.value).toBe('Room');
    fireEvent.blur(first.input);
    expect(first.onDone).toHaveBeenCalled();
    cleanup();

    const second = renderRoom('Refunds');
    fireEvent.change(second.input, { target: { value: '  ' } });
    fireEvent.keyDown(second.input, { key: 'Enter' });
    expect(second.onDone).toHaveBeenCalled();
    expect(roomRenames()).toEqual([]);
  });

  it('отказ хоста — тост «Couldn\'t rename room: invalid request.», поле закрыто', async () => {
    bridge.setHandler('rooms.rename', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'room r-02 is not in the map' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input, onDone } = renderRoom('Refunds');
    fireEvent.change(input, { target: { value: 'Payments' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't rename room: invalid request."));
    expect(onDone).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('SessionInlineRename — то же поле в строке сессии', () => {
  const sessionRenames = (): unknown[] => bridge.calls.filter((call) => call.method === 'sessions.rename').map((call) => call.params);

  beforeEach(() => bridge.setHandler('sessions.rename', () => ({ ok: true as const })));

  function renderSession(id: string, label: string, onDone = vi.fn()): { input: HTMLInputElement; onDone: ReturnType<typeof vi.fn> } {
    render(<SessionInlineRename projectPath="/tmp/proj" workId="w-01" session={makeSession(id, label)} bridge={bridge} onDone={onDone} />);
    return { input: screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement, onDone };
  }

  it('открывается на ярлыке сессии, выделено всё; Enter зовёт sessions.rename с адресом сессии', async () => {
    const { input, onDone } = renderSession('s-02', 'plan');
    expect(input.value).toBe('plan');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'plan'.length]);
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Ralph' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sessionRenames()).toEqual([{ ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-02' }, label: 'Ralph' }]);
    expect(renames()).toEqual([]);
  });

  it('старая метка new session — поле на имени по номеру; без изменений хосту ничего не уходит', () => {
    const { input, onDone } = renderSession('s-18', 'new session');
    expect(input.value).toBe('Nina');
    fireEvent.blur(input);
    expect(onDone).toHaveBeenCalled();
    expect(sessionRenames()).toEqual([]);
  });

  it('Esc и пустое имя хосту не уходят', () => {
    const first = renderSession('s-01', 'plan');
    fireEvent.change(first.input, { target: { value: 'Other' } });
    fireEvent.keyDown(first.input, { key: 'Escape' });
    expect(first.onDone).toHaveBeenCalled();
    cleanup();

    const second = renderSession('s-01', 'plan');
    fireEvent.change(second.input, { target: { value: '  ' } });
    fireEvent.keyDown(second.input, { key: 'Enter' });
    expect(second.onDone).toHaveBeenCalled();
    expect(sessionRenames()).toEqual([]);
  });

  it('отказ хоста — тост «Couldn\'t rename session: invalid request.», поле закрыто', async () => {
    bridge.setHandler('sessions.rename', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'session s-01 is not in the map' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input, onDone } = renderSession('s-01', 'plan');
    fireEvent.change(input, { target: { value: 'Ralph' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't rename session: invalid request."));
    expect(onDone).toHaveBeenCalled();
    warn.mockRestore();
  });
});
