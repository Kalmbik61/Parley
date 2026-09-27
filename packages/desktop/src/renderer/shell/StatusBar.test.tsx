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
      attention={{ needsYou: 0, unseen: 0 }}
      onNextAttention={() => {}}
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

// Тест 9 куска 4.2: сегмент внимания «N need you · M unseen» (спека 7.3, 7.6).
describe('StatusBar: внимание (тест 9 куска 4.2)', () => {
  const connected: HostStatus = { state: 'connected', hostVersion: '1.0.0', methods: [...REQUIRED_METHODS] };

  function renderAttention(attention: { needsYou: number; unseen: number; humanUnread?: number }, onNext = vi.fn()) {
    render(
      <StatusBar
        status={connected}
        noticeLine=""
        wakePaused={false}
        onToggleWake={() => {}}
        onRestartHost={() => {}}
        attention={attention}
        onNextAttention={onNext}
      />,
    );
    return onNext;
  }

  it('needsYou 2, unseen 1 (писем 3) — «2 need you · 1 unseen»; клик зовёт onNextAttention один раз', () => {
    const onNext = renderAttention({ needsYou: 2, unseen: 1, humanUnread: 3 });
    const segment = screen.getByRole('button', { name: '2 need you · 1 unseen' });
    fireEvent.click(segment);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('needsYou 1, unseen 0 — «1 needs you»', () => {
    renderAttention({ needsYou: 1, unseen: 0 });
    expect(screen.getByRole('button', { name: '1 needs you' })).toBeTruthy();
  });

  it('unseen 3 — «3 unseen»; оба нуля — сегмента нет', () => {
    renderAttention({ needsYou: 0, unseen: 3 });
    expect(screen.getByRole('button', { name: '3 unseen' })).toBeTruthy();
    cleanup();
    renderAttention({ needsYou: 0, unseen: 0 });
    expect(document.querySelector('[data-attention-segment]')).toBeNull();
  });

  it('S.statusBar.attention', () => {
    expect(S.statusBar.attention(2, 1)).toBe('2 need you · 1 unseen');
    expect(S.statusBar.attention(1, 0)).toBe('1 needs you');
    expect(S.statusBar.attention(0, 3)).toBe('3 unseen');
    expect(S.statusBar.attention(0, 0)).toBe('');
  });
});
