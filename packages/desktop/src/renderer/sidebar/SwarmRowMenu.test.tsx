/**
 * Меню строки роя (спека роя v1, 7.1): «Open the queen», «Mark as seen» (рой закончен, итог не просмотрен), «Cancel swarm…»
 * (рой идёт, с подтверждением). Пункты с методами, которых хост не знает, спрятаны.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { WorkSwarm } from '@parley/core';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSwarm } from '../test-utils/work-fixtures.js';
import { SwarmRowMenu } from './SwarmRowMenu.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;
const hostWith = (methods: string[]): void => {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods } });
};

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('swarms.cancel', () => ({ ok: true as const }));
  bridge.setHandler('swarms.seen', () => ({ ok: true as const }));
  hostWith(['swarms.cancel', 'swarms.seen']);
  useUiStore.setState({ sidebarHolds: {} });
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' } });
});

function renderMenu(swarm: WorkSwarm, onOpenQueen: (() => void) | null = vi.fn()): { onOpenQueen: (() => void) | null } {
  render(
    <SwarmRowMenu workKey="/tmp/proj w-01" projectPath="/tmp/proj" workId="w-01" swarm={swarm} bridge={bridge} onOpenQueen={onOpenQueen}>
      <div>swarm row</div>
    </SwarmRowMenu>,
  );
  fireEvent.contextMenu(screen.getByText('swarm row'));
  return { onOpenQueen };
}

describe('SwarmRowMenu — пункты', () => {
  it('идущий рой: «Open the queen» и «Cancel swarm»; «Mark as seen» нет; открытое меню держит порядок сайдбара', () => {
    renderMenu(makeSwarm('sw-01', 's-q'));
    expect(screen.getByText('Open the queen')).toBeTruthy();
    expect(screen.getByText('Cancel swarm')).toBeTruthy();
    expect(screen.queryByText('Mark as seen')).toBeNull();
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
  });

  it('готовый рой с непросмотренным итогом: «Mark as seen» вместо «Cancel swarm»; просмотренный — без отметки', () => {
    renderMenu(makeSwarm('sw-01', 's-q', { status: 'done' }));
    expect(screen.getByText('Mark as seen')).toBeTruthy();
    expect(screen.queryByText('Cancel swarm')).toBeNull();
    cleanup();
    renderMenu(makeSwarm('sw-01', 's-q', { status: 'done', seenAt: '2026-10-28T10:00:00.000Z' }));
    expect(screen.queryByText('Mark as seen')).toBeNull();
    cleanup();
    renderMenu(makeSwarm('sw-01', 's-q', { status: 'cancelled' }));
    expect(screen.queryByText('Mark as seen')).toBeNull();
  });

  it('«Open the queen» зовёт колбэк строки и ничего не шлёт хосту', () => {
    const { onOpenQueen } = renderMenu(makeSwarm('sw-01', 's-q'));
    fireEvent.click(screen.getByText('Open the queen'));
    expect(onOpenQueen).toHaveBeenCalledTimes(1);
    expect(bridge.calls).toEqual([]);
  });

  it('сессии королевы в карте нет — «Open the queen» не показывается, остальные пункты на месте', () => {
    renderMenu(makeSwarm('sw-01', 's-q'), null);
    expect(screen.queryByText('Open the queen')).toBeNull();
    expect(screen.getByText('Cancel swarm')).toBeTruthy();
  });

  it('хост без swarms.cancel и swarms.seen — кнопок нет, остаётся «Open the queen»', () => {
    hostWith([]);
    renderMenu(makeSwarm('sw-01', 's-q'));
    expect(screen.queryByText('Cancel swarm')).toBeNull();
    expect(screen.getByText('Open the queen')).toBeTruthy();
    cleanup();
    renderMenu(makeSwarm('sw-01', 's-q', { status: 'failed' }));
    expect(screen.queryByText('Mark as seen')).toBeNull();
  });
});

describe('SwarmRowMenu — действия', () => {
  it('«Cancel swarm» спрашивает подтверждение; swarms.cancel уходит только после него', async () => {
    renderMenu(makeSwarm('sw-01', 's-q'));
    fireEvent.click(screen.getByText('Cancel swarm'));
    expect(screen.getByText('Cancel swarm Research?')).toBeTruthy();
    expect(bridge.calls).toEqual([]);
    // Первая по DOM «Cancel swarm» — кнопка подтверждения диалога.
    fireEvent.click(screen.getAllByText('Cancel swarm')[0] as HTMLElement);
    await waitFor(() => expect(bridge.calls).toEqual([{ method: 'swarms.cancel', params: { projectPath: '/tmp/proj', workId: 'w-01', swarmId: 'sw-01' } }]));
  });

  it('«Mark as seen» шлёт swarms.seen сразу, без вопроса', async () => {
    renderMenu(makeSwarm('sw-01', 's-q', { status: 'done' }));
    fireEvent.click(screen.getByText('Mark as seen'));
    await waitFor(() => expect(bridge.calls).toEqual([{ method: 'swarms.seen', params: { projectPath: '/tmp/proj', workId: 'w-01', swarmId: 'sw-01' } }]));
  });

  it('отказ хоста — тост «Couldn\'t cancel the swarm», текст хоста только в консоль', async () => {
    bridge.setHandler('swarms.cancel', () => {
      throw encodeIpcError({ code: 'conflict', message: 'host detail' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMenu(makeSwarm('sw-01', 's-q'));
    fireEvent.click(screen.getByText('Cancel swarm'));
    fireEvent.click(screen.getAllByText('Cancel swarm')[0] as HTMLElement);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't cancel the swarm: conflicting state."));
    expect(vi.mocked(toast).mock.calls.flat().join(' ')).not.toContain('host detail');
    warn.mockRestore();
  });
});
