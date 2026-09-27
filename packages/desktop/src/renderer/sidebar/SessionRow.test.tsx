/**
 * Тесты 4, 11, 12, 13 куска 3.3: строка сессии карточки. Тест 12 переехал сюда из
 * `components/sidebar/SessionTree.test.tsx` (контракт перетаскивания 2.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Activity, WorkSession } from '@harnas/core';
import type { HostNotice } from '@harnas/protocol';
import { S } from '../../shared/strings.js';
import { formatMetricsLine } from '../lib/metrics-line.js';
import { workKey } from '../lib/tree-order.js';
import { useNoticesStore } from '../store/notices.js';
import { makeActivity, makeSession } from '../test-utils/work-fixtures.js';
import { SessionRow } from './SessionRow.js';

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const KEY = workKey(PROJECT, WORK);
const NOW = new Date('2026-09-27T10:00:00.000Z');

function renderRow(
  session: WorkSession,
  options: { activity?: Activity | null; draggable?: boolean; selected?: boolean; onOpen?: () => void } = {},
) {
  const activity =
    options.activity === undefined || options.activity === null
      ? null
      : makeActivity({ projectPath: PROJECT, workId: WORK, sessionId: session.id }, options.activity, {
          lastEventAt: '2026-09-27T09:57:00.000Z',
        });
  return render(
    <SessionRow
      workKey={KEY}
      session={session}
      depth={0}
      activity={activity}
      now={NOW}
      draggable={options.draggable ?? true}
      selected={options.selected ?? false}
      onOpen={options.onOpen ?? (() => {})}
    />,
  );
}

const row = (id = 's-01'): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
  if (element === null) throw new Error(`строки ${id} нет`);
  return element;
};

beforeEach(() => useNoticesStore.setState({ notices: [] }));
afterEach(cleanup);

describe('SessionRow — девять состояний таблицы 4.2 (тест 4)', () => {
  const cases: Array<{ name: string; session: WorkSession; activity: Activity | null; state: string; lifecycle?: string; word: string }> = [
    { name: 'работает', session: makeSession('s-01', 'a'), activity: 'working', state: 'working', word: S.states.working },
    { name: 'ждёт тебя', session: makeSession('s-01', 'a'), activity: 'blocked', state: 'blocked', word: S.states.blocked },
    { name: 'не просмотрено', session: makeSession('s-01', 'a'), activity: 'unseen', state: 'unseen', word: S.states.unseen },
    { name: 'простаивает', session: makeSession('s-01', 'a'), activity: null, state: 'idle', word: S.states.idle },
    { name: 'ожидает запуска', session: makeSession('s-01', 'a', { lifecycle: 'pending' }), activity: null, state: 'pending', word: S.states.pending },
    { name: 'спит', session: makeSession('s-01', 'a', { lifecycle: 'sleeping' }), activity: null, state: 'exited', lifecycle: 'sleeping', word: S.states.asleep },
    { name: 'закрыта', session: makeSession('s-01', 'a', { lifecycle: 'closed' }), activity: null, state: 'exited', lifecycle: 'closed', word: S.states.closed },
    { name: 'готово', session: makeSession('s-01', 'a', { result: 'done' }), activity: null, state: 'done', word: S.states.done },
    { name: 'сбой', session: makeSession('s-01', 'a', { result: 'failed' }), activity: null, state: 'failed', word: S.states.failed },
  ];

  for (const c of cases) {
    it(`${c.name}: значок ${c.state} и слово «${c.word}»`, () => {
      renderRow(c.session, { activity: c.activity });
      const dot = row().querySelector('[data-testid="agent-state-dot"]');
      expect(dot?.getAttribute('data-state')).toBe(c.state);
      if (c.lifecycle !== undefined) expect(dot?.getAttribute('data-lifecycle')).toBe(c.lifecycle);
      expect(row().textContent).toContain(c.word);
    });
  }

  it('девять пар (значок, слово) различны', () => {
    const pairs = new Set(cases.map((c) => `${c.state}/${c.lifecycle ?? ''}/${c.word}`));
    expect(pairs.size).toBe(9);
  });

  it('⎇ только у сессии со своим worktree, ветка — в title', () => {
    renderRow(makeSession('s-01', 'a'));
    expect(row().querySelector('[data-worktree]')).toBeNull();
    cleanup();
    renderRow(makeSession('s-01', 'a', { worktree: { path: '/tmp/wt', branch: 'harnas/s-01', base: 'main', createdAt: null } }));
    expect(row().querySelector('[data-worktree]')?.getAttribute('title')).toBe('harnas/s-01');
  });

  it('подсветка amber при needs-you и unseen, у работающей — нет; на строке data-session-id', () => {
    renderRow(makeSession('s-01', 'a'), { activity: 'blocked' });
    expect(row().className).toContain('bg-amber-500/10');
    cleanup();
    renderRow(makeSession('s-01', 'a'), { activity: 'unseen' });
    expect(row().className).toContain('bg-amber-500/10');
    cleanup();
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(row().className).not.toContain('bg-amber-500/10');
    expect(row().getAttribute('data-session-id')).toBe('s-01');
  });

  it('подпись S01 и время последнего события; клик зовёт onOpen', () => {
    const onOpen = vi.fn();
    renderRow(makeSession('s-01', 'исполнитель'), { activity: 'working', onOpen });
    expect(row().textContent).toContain('S01 исполнитель');
    expect(row().textContent).toContain('3m');
    fireEvent.click(row());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('SessionRow — пометка trust-wait (тест 11)', () => {
  it('host.notice trust-wait по ref строки — ⚠ с тултипом; у строки другой сессии пометки нет', () => {
    const notice: HostNotice = {
      kind: 'trust-wait',
      text: 'молчит',
      ref: { projectPath: PROJECT, workId: WORK, sessionId: 's-01' },
    } as HostNotice;
    useNoticesStore.setState({ notices: [notice] });

    renderRow(makeSession('s-01', 'a'));
    renderRow(makeSession('s-02', 'b'));
    expect(row('s-01').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)?.textContent).toBe('⚠');
    expect(row('s-02').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)).toBeNull();
  });
});

describe('SessionRow — контракт перетаскивания (тест 12)', () => {
  it('у строки неактивной работы нет data-draggable и курсор not-allowed, у активной — есть; HTML5 draggable нет; у выбранной — data-selected', () => {
    renderRow(makeSession('s-01', 'a'), { draggable: false });
    expect(row().hasAttribute('data-draggable')).toBe(false);
    expect(row().className).toContain('cursor-not-allowed');
    expect(row().getAttribute('draggable')).toBeNull();
    expect(row().getAttribute('data-selected')).toBe('false');
    cleanup();

    renderRow(makeSession('s-01', 'a'), { draggable: true, selected: true });
    expect(row().hasAttribute('data-draggable')).toBe(true);
    expect(row().className).not.toContain('cursor-not-allowed');
    expect(row().getAttribute('draggable')).toBeNull();
    expect(row().getAttribute('data-selected')).toBe('true');
  });
});

describe('SessionRow — тултип (тест 13)', () => {
  it('задача (первые 300 символов), summary, слово итога, модель и строка метрик', async () => {
    const task = 'x'.repeat(320);
    const session = makeSession('s-01', 'a', { task, summary: 'Сделал ревью', result: 'done' });
    const metrics = { tokensIn: 1200, tokensOut: 300, durationMs: 65_000, unread: 0, subagents: 0, model: 'claude-opus' };
    render(
      <SessionRow
        workKey={KEY}
        session={session}
        depth={0}
        activity={makeActivity({ projectPath: PROJECT, workId: WORK, sessionId: 's-01' }, 'idle', { metrics })}
        now={NOW}
        draggable
        selected={false}
        onOpen={() => {}}
      />,
    );
    fireEvent.focus(row());
    const tooltip = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-session-tooltip]');
      if (element === null) throw new Error('тултипа нет');
      return element;
    });
    const text = tooltip.textContent ?? '';
    expect(text).toContain(`${'x'.repeat(300)}…`);
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('Сделал ревью');
    expect(text).toContain(S.states.done);
    expect(text).toContain('claude-opus');
    expect(text).toContain(formatMetricsLine(metrics));
    expect(screen.getAllByText('claude-opus').length).toBeGreaterThan(0);
  });
});
