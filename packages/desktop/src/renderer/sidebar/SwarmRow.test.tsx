/**
 * Строка роя в карточке работы (спека роя v1, 7.1, 7.3): свёрнута по умолчанию, счётчик, точки, таймер, раскрытие с
 * участниками, итог законченного роя, значок карточки. Карточка — настоящая `WorkCard`, рой — запись карты.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WindowWorkEntry, WorkSwarm } from '@parley/core';
import type { WorkAttention } from '../attention/derive.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeSwarm, makeSwarmMember, makeWork } from '../test-utils/work-fixtures.js';
import { workKey } from '../lib/tree-order.js';
import { showSwarm } from './SwarmRow.js';
import { WorkCard } from './WorkCard.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const NOW = new Date('2026-09-27T08:04:12.000Z');
const attention: WorkAttention = { level: 'idle', needsYou: 0, unseen: 0, humanUnread: 0, roomsUnread: {}, roomMentions: {}, lastEventAt: '2026-09-27T08:00:00.000Z' };
let disposeHost: () => void = () => {};

beforeEach(() => {
  disposeHost = useHostStore.getState().init(createFakeBridge());
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  // Раскрытие живёт в памяти окна по ключу `workKey/swarmId` — между тестами его надо снять.
  for (const id of ['sw-01', 'sw-02']) showSwarm(`${workKey('/tmp/proj', 'w-01')}/${id}`, false);
  disposeHost();
});

const members = [
  makeSwarmMember('s-q', 'queen'),
  makeSwarmMember('s-d1', 'drone', 1, true),
  makeSwarmMember('s-d2', 'drone', 2),
  makeSwarmMember('s-v', 'verifier'),
];
const hive = [makeSession('s-q', 'queen'), makeSession('s-d1', 'drone one'), makeSession('s-d2', 'drone two'), makeSession('s-v', 'verifier')];

function entryWith(swarm: WorkSwarm, extra = [makeSession('s-lead', 'lead')]): WindowWorkEntry {
  return makeWork('w-01', { sessions: [...extra, ...hive], swarms: [{ ...swarm, creator: { kind: 'session', sessionId: 's-lead' } }] });
}

function renderCard(entry: WindowWorkEntry, onOpenSession: (id: string) => void = () => {}) {
  return render(
    <WorkCard
      entry={entry}
      attention={attention}
      activity={{}}
      active={false}
      pinned={false}
      branch={null}
      now={NOW}
      selectedSessionId={null}
      onActivate={() => {}}
      onOpenSession={onOpenSession}
      onOpenMail={() => {}}
      onOpenRoom={() => {}}
      bridge={createFakeBridge()}
    />,
  );
}

const swarmRow = (): HTMLElement => {
  const row = document.querySelector<HTMLElement>('[data-swarm-row]');
  if (row === null) throw new Error('строки роя нет');
  return row;
};

describe('SwarmRow', () => {
  it('свёрнута по умолчанию: значок, тег, точки, счётчик 1/3, таймер; участников и обычных строк роя нет', () => {
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members, createdAt: '2026-09-27T08:00:00.000Z' })));
    const row = swarmRow();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('[data-swarm-icon]')).not.toBeNull();
    expect(row.querySelector('[data-swarm-tag]')?.textContent).toBe('[Research]');
    expect(row.querySelector('[data-swarm-counter]')?.textContent).toBe('1/3');
    expect([...row.querySelectorAll('[data-dot]')].map((dot) => dot.getAttribute('data-dot'))).toEqual(['handed', 'open', 'open']);
    expect(row.querySelector('[data-swarm-timer]')?.textContent).toBe('4:12');
    expect(document.querySelector('[data-swarm-member]')).toBeNull();
    // Сессии роя обычными строками карточки не стоят, в «N сессий» тоже не считаются: она одна, `s-lead`.
    expect(screen.queryByText('drone one')).toBeNull();
  });

  it('до первого трутня счётчик — многоточие, у королевы «cutting the task…»', () => {
    renderCard(entryWith(makeSwarm('sw-01', 's-q')));
    expect(swarmRow().querySelector('[data-swarm-counter]')?.textContent).toBe('…');
    fireEvent.click(swarmRow());
    expect(within(swarmRow()).getByText('cutting the task…')).toBeTruthy();
  });

  it('клик раскрывает: королева, трутни по номеру, проверяющий; слова состояния; повторный клик сворачивает', () => {
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members })));
    fireEvent.click(swarmRow());
    expect(swarmRow().getAttribute('aria-expanded')).toBe('true');
    const lines = [...swarmRow().querySelectorAll('[data-swarm-member]')].map((line) => line.getAttribute('aria-label'));
    expect(lines).toEqual(['Queen: waiting for hand-ins…', 'Drone 1: handed in ✓', 'Drone 2: reading…', 'Verifier: verifying…']);
    fireEvent.click(swarmRow());
    expect(document.querySelector('[data-swarm-member]')).toBeNull();
  });

  it('клик по участнику открывает его сессию и не сворачивает рой', () => {
    const open = vi.fn();
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members })), open);
    fireEvent.click(swarmRow());
    fireEvent.click(document.querySelector('[data-swarm-member="s-d2"]') as HTMLElement);
    expect(open).toHaveBeenCalledWith('s-d2');
    expect(swarmRow().getAttribute('aria-expanded')).toBe('true');
  });

  it('Enter на строке раскрывает её', () => {
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members })));
    fireEvent.keyDown(swarmRow(), { key: 'Enter' });
    expect(swarmRow().getAttribute('aria-expanded')).toBe('true');
  });

  it('таймер идущего роя тикает раз в секунду, законченного — стоит', () => {
    const first = renderCard(entryWith(makeSwarm('sw-01', 's-q', { members, createdAt: new Date(NOW.getTime() - 5_000).toISOString() })));
    const before = swarmRow().querySelector('[data-swarm-timer]')?.textContent;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(swarmRow().querySelector('[data-swarm-timer]')?.textContent).not.toBe(before);
    first.unmount();
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members, status: 'done', createdAt: '2026-09-27T08:00:00.000Z', endedAt: '2026-09-27T08:02:30.000Z' })));
    expect(swarmRow().querySelector('[data-swarm-timer]')?.textContent).toBe('2:30');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(swarmRow().querySelector('[data-swarm-timer]')?.textContent).toBe('2:30');
  });

  it('готовый рой: знак ✓, итог в раскрытии; сбой — причина и знак', () => {
    const done = makeSwarm('sw-01', 's-q', { members, status: 'done', endedAt: '2026-09-27T08:03:00.000Z', result: { summary: 'Use jittered backoff.', at: '2026-09-27T08:03:00.000Z', deliveredAt: null } });
    const first = renderCard(entryWith(done));
    expect(swarmRow().querySelector('[data-swarm-end="done"]')).not.toBeNull();
    fireEvent.click(swarmRow());
    expect(within(swarmRow()).getByText('Use jittered backoff.')).toBeTruthy();
    first.unmount();
    renderCard(entryWith(makeSwarm('sw-02', 's-q', { members, status: 'failed', endedAt: '2026-09-27T08:03:00.000Z', failure: 'time limit: 90 min' })));
    expect(swarmRow().querySelector('[data-swarm-end="failed"]')).not.toBeNull();
    fireEvent.click(swarmRow());
    expect(within(swarmRow()).getByText('Stopped: time limit: 90 min')).toBeTruthy();
    expect(within(swarmRow()).getByText('No summary was handed in.')).toBeTruthy();
    expect(within(swarmRow()).getByRole('button', { name: 'Drone 2: closed' })).toBeTruthy();
  });

  it('просмотренный готовый рой с карточки уходит', () => {
    renderCard(entryWith(makeSwarm('sw-01', 's-q', { members, status: 'done', seenAt: '2026-09-27T09:00:00.000Z' })));
    expect(document.querySelector('[data-swarm-row]')).toBeNull();
  });
});

describe('значок роёв в заголовке карточки (7.3)', () => {
  const badge = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-work-key] [data-swarm-badge]');

  it('число идущих роёв; видно и при свёрнутой строке роя', () => {
    const entry = makeWork('w-01', { sessions: [...hive, makeSession('s-lead', 'lead')], swarms: [makeSwarm('sw-01', 's-q', { members }), makeSwarm('sw-02', 's-q2', { members: [makeSwarmMember('s-q2', 'queen')] })] });
    renderCard(entry);
    expect(badge()?.querySelector('[data-swarm-count]')?.textContent).toBe('2');
    expect(badge()?.getAttribute('title')).toBe('2 swarms running');
  });

  it('готовый непросмотренный итог — галочка; просмотренный и отменённый — значка нет', () => {
    const base = { sessions: hive };
    const { unmount } = renderCard(makeWork('w-01', { ...base, swarms: [makeSwarm('sw-01', 's-q', { members, status: 'done' })] }));
    expect(badge()?.getAttribute('data-swarm-badge')).toBe('done');
    expect(badge()?.querySelector('[data-swarm-count]')?.textContent).toBe('✓');
    unmount();
    renderCard(makeWork('w-01', { ...base, swarms: [makeSwarm('sw-01', 's-q', { members, status: 'done', seenAt: '2026-09-27T09:00:00.000Z' }), makeSwarm('sw-02', 's-q', { members, status: 'cancelled' })] }));
    expect(badge()).toBeNull();
  });
});
