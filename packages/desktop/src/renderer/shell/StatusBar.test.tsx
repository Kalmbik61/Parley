/**
 * Тест 12 куска 3.1: хост старее окна — сегмент «Host is outdated — restart»,
 * клик спрашивает подтверждение, `Restart` зовёт `onRestartHost` один раз,
 * `Cancel` — ни разу. С полным `REQUIRED_METHODS` сегмента нет.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { StatusBar } from './StatusBar.js';

afterEach(cleanup);

function renderBar(status: HostStatus, onRestartHost = vi.fn()) {
  render(
    <StatusBar
      status={status}
      noticeLine=""
      wakePaused={false}
      onToggleWake={() => {}}
      onRestartHost={onRestartHost}
    />,
  );
  return onRestartHost;
}

const old: HostStatus = { state: 'connected', hostVersion: '1.0.0', methods: null };

describe('StatusBar: хост старее окна', () => {
  it('Restart в подтверждении зовёт onRestartHost один раз', () => {
    const onRestartHost = renderBar(old);
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    expect(screen.getByRole('dialog', { name: 'Restart host?' })).toBeTruthy();
    expect(screen.getByText(S.statusBar.restartHostDescription)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onRestartHost).toHaveBeenCalledTimes(1);
  });

  it('Cancel не зовёт onRestartHost', () => {
    const onRestartHost = renderBar(old);
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRestartHost).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('с полным REQUIRED_METHODS сегмента нет', () => {
    renderBar({ state: 'connected', hostVersion: '2.0.0', methods: [...REQUIRED_METHODS] });
    expect(screen.queryByRole('button', { name: 'Host is outdated — restart' })).toBeNull();
  });
});
