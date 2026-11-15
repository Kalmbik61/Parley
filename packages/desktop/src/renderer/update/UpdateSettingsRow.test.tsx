/**
 * Строка самообновления в настройках (спека self-update §4.2): по строке на состояние и кнопку; в `idle` строки нет.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateState } from '../../shared/bridge.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { UpdateSettingsRow } from './UpdateSettingsRow.js';

afterEach(cleanup);

const BASE = { version: '0.2.0', url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.2.0' };

function setup(state: UpdateState) {
  const bridge = createFakeBridge();
  bridge.setUpdateState(state);
  render(<UpdateSettingsRow bridge={bridge} />);
  return bridge;
}

describe('UpdateSettingsRow', () => {
  it('SU-01: нет новой версии — строки нет', () => {
    const { container } = render(<UpdateSettingsRow bridge={createFakeBridge()} />);
    expect(container.firstChild).toBeNull();
  });

  it('найдена, можно заменить: «Parley X is available» и «Update» → downloadUpdate', () => {
    const bridge = setup({ phase: 'available', ...BASE, canInstall: true });
    expect(screen.getByText('Parley 0.2.0 is available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(bridge.updateCalls).toContain('download');
  });

  it('найдена, нельзя заменить: «Download» открывает страницу релиза', () => {
    const bridge = setup({ phase: 'available', ...BASE, canInstall: false });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(bridge.externalOpened).toEqual([BASE.url]);
  });

  it('загрузка: «Downloading X — N%» и «Cancel»; без размера — без процента', () => {
    const bridge = setup({ phase: 'downloading', ...BASE, received: 50, total: 200 });
    expect(screen.getByText('Downloading 0.2.0 — 25%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.updateCalls).toContain('cancel');
    act(() => bridge.emitUpdateState({ phase: 'downloading', ...BASE, received: 50, total: null }));
    expect(screen.getByText('Downloading 0.2.0…')).toBeTruthy();
  });

  it('проверка: «Checking X…» и «Cancel»', () => {
    const bridge = setup({ phase: 'verifying', ...BASE });
    expect(screen.getByText('Checking 0.2.0…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.updateCalls).toContain('cancel');
  });

  it('готово: «X is ready to install» и «Restart to update» → installUpdate', () => {
    const bridge = setup({ phase: 'ready', ...BASE });
    expect(screen.getByText('0.2.0 is ready to install')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(bridge.updateCalls).toContain('install');
  });

  it("не удалось: «Couldn't update: <причина>» и «Try again» → downloadUpdate", () => {
    const bridge = setup({ phase: 'failed', ...BASE, reason: 'network' });
    expect(
      screen.getByText("Couldn't update: GitHub did not answer, check your connection"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(bridge.updateCalls).toContain('download');
  });

  it('следует за событиями состояния и пропадает при idle', () => {
    const bridge = setup({ phase: 'ready', ...BASE });
    act(() => bridge.emitUpdateState({ phase: 'idle' }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
