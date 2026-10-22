/**
 * Карточка согласия на острове: заголовок, папка с сокращением середины (полный путь — в подсказке), строка «requested
 * by …», кнопки Trust / Deny с паузой `CARD_ARM_MS` (таймеры подставные), «Done ✓», «Already answered» и «Couldn't decide».
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import { CARD_ARM_MS } from '../arm.js';
import { ConsentView, type ConsentViewProps } from './ConsentView.js';

const CARD: ConsentCard = {
  id: 'c-01', kind: 'folder-trust', folder: '/Users/me/work/my_harnas', projectPath: '/Users/me/work/my_harnas',
  requestedBy: { source: 'agent', sessionId: 's-03', workId: 'w-1', label: 'S03 Ruslan' },
  at: '2026-10-21T10:00:00.000Z', state: 'pending',
};

function props(patch: Partial<ConsentViewProps> = {}): ConsentViewProps {
  return { card: CARD, deciding: false, note: null, onDecide: vi.fn(), ...patch };
}

const arm = (): void => {
  act(() => {
    vi.advanceTimersByTime(CARD_ARM_MS);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('карточка согласия острова', () => {
  it('заголовок, папка и строка «requested by»', () => {
    render(<ConsentView {...props()} />);
    expect(screen.getByTestId('island-card')).toBeTruthy();
    expect(screen.getByText('Trust folder for agents?')).toBeTruthy();
    expect(screen.getByTestId('island-consent-folder').textContent).toBe('/Users/me/work/my_harnas');
    expect(screen.getByText('requested by S03 Ruslan · create_session')).toBeTruthy();
  });

  it('источник запроса: resume и launch; без подписи — id сессии, без него — прочерк', () => {
    const { rerender } = render(<ConsentView {...props({ card: { ...CARD, requestedBy: { source: 'resume', sessionId: 's-04' } } })} />);
    expect(screen.getByText('requested by s-04 · resume')).toBeTruthy();
    rerender(<ConsentView {...props({ card: { ...CARD, requestedBy: { source: 'launch' } } })} />);
    expect(screen.getByText('requested by — · launch')).toBeTruthy();
  });

  it('длинный путь — с сокращённой серединой, полный путь в подсказке', () => {
    const folder = `/Users/me/${'very-long-directory-name/'.repeat(6)}my_harnas`;
    render(<ConsentView {...props({ card: { ...CARD, folder } })} />);
    const line = screen.getByTestId('island-consent-folder');
    expect(line.textContent).toContain('…');
    expect(Array.from(line.textContent ?? '').length).toBe(56);
    expect(line.textContent?.endsWith('my_harnas')).toBe(true);
    expect(line.getAttribute('title')).toBe(folder);
  });

  it('Trust зовёт onDecide(id, "allow"), Deny — onDecide(id, "deny")', () => {
    const p = props();
    render(<ConsentView {...p} />);
    arm();
    fireEvent.click(screen.getByTestId('island-consent-trust'));
    expect(p.onDecide).toHaveBeenLastCalledWith('c-01', 'allow');
    fireEvent.click(screen.getByTestId('island-consent-deny'));
    expect(p.onDecide).toHaveBeenLastCalledWith('c-01', 'deny');
    expect(screen.getByTestId('island-consent-trust').textContent).toBe('Trust');
    expect(screen.getByTestId('island-consent-deny').textContent).toBe('Deny');
  });

  it('кнопки взводятся через CARD_ARM_MS: до этого выключены', () => {
    const p = props();
    render(<ConsentView {...p} />);
    const trust = screen.getByTestId('island-consent-trust') as HTMLButtonElement;
    const deny = screen.getByTestId('island-consent-deny') as HTMLButtonElement;
    expect(trust.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CARD_ARM_MS - 1);
    });
    expect(trust.disabled).toBe(true);
    arm();
    expect(trust.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
  });

  it('другая карточка — пауза заново', () => {
    const { rerender } = render(<ConsentView {...props()} />);
    arm();
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(false);
    rerender(<ConsentView {...props({ card: { ...CARD, id: 'c-02' } })} />);
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(true);
  });

  it('решение в пути — кнопки выключены', () => {
    render(<ConsentView {...props({ deciding: true })} />);
    arm();
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('island-consent-deny') as HTMLButtonElement).disabled).toBe(true);
  });

  it('«Done ✓» вместо кнопок', () => {
    render(<ConsentView {...props({ note: 'done' })} />);
    expect(screen.getByTestId('island-consent-done').textContent).toBe('Done ✓');
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
    expect(screen.queryByTestId('island-consent-deny')).toBeNull();
  });

  it('«Already answered» вместо кнопок', () => {
    render(<ConsentView {...props({ note: 'elsewhere' })} />);
    expect(screen.getByText('Already answered')).toBeTruthy();
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
  });

  it('«Couldn\'t decide»: кнопки на месте и нажимаются', () => {
    const p = props({ note: 'failed' });
    render(<ConsentView {...p} />);
    expect(screen.getByText("Couldn't decide")).toBeTruthy();
    arm();
    fireEvent.click(screen.getByTestId('island-consent-trust'));
    expect(p.onDecide).toHaveBeenCalledWith('c-01', 'allow');
  });
});
