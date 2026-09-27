/**
 * Тест 5 куска 3.6 плана окна: баннер показывает список прерванных сессий и
 * вызывает `sessions.resumeInterrupted` с этими же `refs`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { InterruptedBanner } from './InterruptedBanner.js';

afterEach(cleanup);

const REFS: SessionRef[] = [
  { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
  { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-05' },
];

describe('InterruptedBanner — тест 5', () => {
  it('показывает список и «Поднять всех» шлёт sessions.resumeInterrupted с этими refs', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: REFS }));
    bridge.setHandler('sessions.resumeInterrupted', () => ({ ok: true }));

    render(<InterruptedBanner bridge={bridge} />);

    await screen.findByText('Interrupted mid-turn: S03, S05');

    fireEvent.click(screen.getByText('Resume all'));

    const call = bridge.calls.find((entry) => entry.method === 'sessions.resumeInterrupted');
    expect(call?.params).toEqual({ refs: REFS });
  });

  it('пустой список — баннера нет', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: [] }));

    const { container } = render(<InterruptedBanner bridge={bridge} />);

    await Promise.resolve();
    expect(container.textContent).toBe('');
  });
});
