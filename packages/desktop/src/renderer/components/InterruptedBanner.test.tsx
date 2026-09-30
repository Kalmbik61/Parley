/**
 * Тест 5 куска 3.6 плана окна: баннер показывает список прерванных сессий и
 * вызывает `sessions.resumeInterrupted` с этими же `refs`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@parley/protocol';
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

  // Раунд main-r2, п. 2 (ревью 6.3-B, Important 2): «Restart host» не перемонтирует окно —
  // баннер перезапрашивает список на каждое восстановление связи с хостом.
  it('восстановление связи с хостом — список запрошен заново, баннер появился', async () => {
    const bridge = createFakeBridge();
    let refs: SessionRef[] = [];
    bridge.setHandler('sessions.interrupted', () => ({ refs }));
    const { container } = render(<InterruptedBanner bridge={bridge} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');

    refs = REFS;
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'restart' }));
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null }));
    await screen.findByText('Interrupted mid-turn: S03, S05');
  });
});

