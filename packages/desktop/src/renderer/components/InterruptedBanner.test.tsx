/**
 * Тест 5 куска 3.6 плана окна: баннер показывает список прерванных сессий и
 * вызывает `sessions.resumeInterrupted` с этими же `refs`. Чипы сессий с названием работы, открытие
 * по клику и «×» (скрытые не возвращаются, новые появляются).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useWorksStore } from '../store/works.js';
import { InterruptedBanner } from './InterruptedBanner.js';

afterEach(() => {
  cleanup();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
});

const noop = (): void => {};

const REFS: SessionRef[] = [
  { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
  { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-05' },
];

describe('InterruptedBanner — тест 5', () => {
  it('показывает список и «Поднять всех» шлёт sessions.resumeInterrupted с этими refs', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: REFS }));
    bridge.setHandler('sessions.resumeInterrupted', () => ({ ok: true }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    await screen.findByText('Interrupted mid-turn:');
    expect(screen.getByRole('button', { name: 'S03' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'S05' })).toBeTruthy();

    fireEvent.click(screen.getByText('Resume all'));

    const call = bridge.calls.find((entry) => entry.method === 'sessions.resumeInterrupted');
    expect(call?.params).toEqual({ refs: REFS });
  });

  it('пустой список — баннера нет', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: [] }));

    const { container } = render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  // Раунд main-r2, п. 2 (ревью 6.3-B, Important 2): «Restart host» не перемонтирует окно —
  // баннер перезапрашивает список на каждое восстановление связи с хостом.
  it('восстановление связи с хостом — список запрошен заново, баннер появился', async () => {
    const bridge = createFakeBridge();
    let refs: SessionRef[] = [];
    bridge.setHandler('sessions.interrupted', () => ({ refs }));
    const { container } = render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');

    refs = REFS;
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'restart' }));
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null }));
    await screen.findByText('Interrupted mid-turn:');
  });

  it('чип — «S03 метка · название работы» из снимка работ; без снимка — просто S03', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/w-01', title: 'Billing', sessions: [makeSession('s-03', 'backend')] })],
    });
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: REFS }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    const chip = await screen.findByRole('button', { name: 'S03 backend · Billing' });
    expect(chip.getAttribute('title')).toBe('S03 backend · Billing');
    // s-05 в снимке нет — запасной вариант.
    expect(screen.getByRole('button', { name: 'S05' })).toBeTruthy();
  });

  it('одинаковый номер в разных работах — два различимых чипа', async () => {
    useWorksStore.setState({
      entries: [
        makeWork('w-01', { projectPath: '/tmp/w-01', title: 'Billing', sessions: [makeSession('s-03', 'backend')] }),
        makeWork('w-02', { projectPath: '/tmp/w-02', title: 'Landing', sessions: [makeSession('s-03', 'backend')] }),
      ],
    });
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({
      refs: [
        { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
        { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-03' },
      ],
    }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    await screen.findByRole('button', { name: 'S03 backend · Billing' });
    expect(screen.getByRole('button', { name: 'S03 backend · Landing' })).toBeTruthy();
  });

  it('дубли refs показываются одним чипом и уходят в «Resume all» один раз', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: [REFS[0]!, REFS[0]!] }));
    bridge.setHandler('sessions.resumeInterrupted', () => ({ ok: true }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    await screen.findByRole('button', { name: 'S03' });
    expect(screen.getAllByRole('button', { name: 'S03' })).toHaveLength(1);
    fireEvent.click(screen.getByText('Resume all'));
    const call = bridge.calls.find((entry) => entry.method === 'sessions.resumeInterrupted');
    expect(call?.params).toEqual({ refs: [REFS[0]] });
  });

  it('клик по чипу вызывает onOpenSession с этим ref', async () => {
    const onOpenSession = vi.fn();
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: REFS }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={onOpenSession} />);

    fireEvent.click(await screen.findByRole('button', { name: 'S05' }));
    expect(onOpenSession).toHaveBeenCalledWith(REFS[1]);
  });

  it('длинное название работы: чип обрезан, полный текст в title, ряд переносится', async () => {
    const title = 'W'.repeat(120);
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/w-01', title, sessions: [makeSession('s-03', 'backend')] })],
    });
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.interrupted', () => ({ refs: [REFS[0]!] }));

    render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    const chip = await screen.findByTitle(`S03 backend · ${title}`);
    expect(chip.className).toContain('max-w-[16rem]');
    expect(chip.querySelector('span')?.className).toContain('truncate');
    expect(chip.parentElement?.className).toContain('flex-wrap');
    expect(chip.parentElement?.className).toContain('min-w-0');
  });

  it('«Dismiss» прячет баннер; после переподключения возвращаются только новые refs', async () => {
    const bridge = createFakeBridge();
    let refs: SessionRef[] = [REFS[0]!];
    bridge.setHandler('sessions.interrupted', () => ({ refs }));
    const { container } = render(<InterruptedBanner bridge={bridge} onOpenSession={noop} />);

    await screen.findByRole('button', { name: 'S03' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container.textContent).toBe('');

    // Хост снова отдаёт скрытую сессию и новую: скрытая остаётся скрытой.
    refs = [REFS[0]!, REFS[1]!];
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'restart' }));
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null }));
    await screen.findByRole('button', { name: 'S05' });
    expect(screen.queryByRole('button', { name: 'S03' })).toBeNull();
  });
});
