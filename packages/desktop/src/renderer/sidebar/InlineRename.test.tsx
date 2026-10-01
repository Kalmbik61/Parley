/** Тест 3 куска 3.4: переименование работы на месте (спека 6.4). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeWork } from '../test-utils/work-fixtures.js';
import { InlineRename } from './InlineRename.js';

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
