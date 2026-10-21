/**
 * Лента участников: вторая строка карточки — чем занят участник (`doing`), а без этого — его задача
 * (Parley 0.2.0, активность агентов). Подсказка второй строки — `doingDetail`. Строка субагентов — бейдж с поповером
 * (кусок 4b плана 2026-10-01): клик по агенту открывает сессию участника на карточке этого агента.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionNeed } from '@parley/core';
import { capPlan, type AgentPlan } from '@parley/core/agent-plan';
import type { LiveTask } from '@parley/protocol';
import { makeNeed } from '../../test-utils/work-fixtures.js';
import type { ParticipantModel } from './feed-model.js';
import { ParticipantStrip } from './ParticipantStrip.js';

afterEach(cleanup);

function participant(patch: Partial<ParticipantModel> = {}): ParticipantModel {
  return {
    id: 's-01',
    label: 'S01 архитектор',
    rawLabel: 'архитектор',
    provider: 'claude',
    providerName: 'Claude Code',
    model: null,
    state: 'working',
    lifecycle: 'active',
    word: 'working',
    attention: 'working',
    task: 'Спроектировать возвраты',
    plan: null,
    planLine: null,
    doing: null,
    doingDetail: null,
    agents: [],
    lead: false,
    closed: false,
    ...patch,
  };
}

const renderStrip = (participants: ParticipantModel[], onOpenSession = vi.fn()) => {
  render(<ParticipantStrip participants={participants} onOpenSession={onOpenSession} />);
  return onOpenSession;
};

const card = (id: string): HTMLElement =>
  document.querySelector(`[data-participant="${id}"]`) as HTMLElement;

describe('ParticipantStrip — чем занят участник', () => {
  it('doing есть — он вместо задачи, а подсказка второй строки — doingDetail', () => {
    renderStrip([
      participant({
        doing: '2 subagents: Docs lookup',
        doingDetail: '2 subagents\n• Docs lookup\n• Release notes',
      }),
    ]);

    const line = within(card('s-01')).getByText('2 subagents: Docs lookup');
    expect(line.getAttribute('title')).toBe('2 subagents\n• Docs lookup\n• Release notes');
    expect(line.className).toContain('truncate');
    expect(within(card('s-01')).queryByText('Спроектировать возвраты')).toBeNull();
  });

  it('doing нет — задача, как раньше, без подсказки', () => {
    renderStrip([participant()]);

    const line = within(card('s-01')).getByText('Спроектировать возвраты');
    expect(line.getAttribute('title')).toBeNull();
  });

  it('подсказка карточки целиком (провайдер и модель) на месте; клик открывает сессию', () => {
    const onOpenSession = renderStrip([
      participant({ model: 'Opus 5.5', doing: 'Waiting for S03', doingDetail: 'Waiting for S03' }),
    ]);

    expect(card('s-01').getAttribute('title')).toBe('Claude Code · Opus 5.5');
    fireEvent.click(within(card('s-01')).getByRole('button'));
    expect(onOpenSession).toHaveBeenCalledWith('s-01');
  });
});

const task = (id: string, extra: Partial<LiveTask> = {}): LiveTask => ({
  id,
  agentType: 'Explore',
  description: `Task ${id}`,
  background: true,
  ...extra,
});

describe('ParticipantStrip — поповер агентов на строке субагентов (кусок 4b)', () => {
  const subagents = (tasks: LiveTask[]): Partial<ParticipantModel> => ({
    doing: `${tasks.length} subagents: Task ${tasks[0]?.id}`,
    doingDetail: `${tasks.length} subagents\n• Task a\n• Task b`,
    agents: tasks,
  });

  it('строка субагентов — бейдж с той же подписью и подсказкой; на карточке одна кнопка открытия, а не вложенная в неё', () => {
    renderStrip([participant(subagents([task('a'), task('b')]))]);
    const line = within(card('s-01')).getByTestId('agents-badge');
    expect(line.textContent).toBe('2 subagents: Task a');
    expect(line.getAttribute('title')).toBe('2 subagents\n• Task a\n• Task b');
    expect(line.className).toContain('truncate');
    // Кнопка в кнопке недопустима: открывающая кнопка карточки и бейдж — соседи.
    const buttons = within(card('s-01')).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons.some((button) => button !== line && button.contains(line))).toBe(false);
    expect(within(card('s-01')).queryByText('Спроектировать возвраты')).toBeNull();
  });

  it('клик по бейджу открывает поповер и не открывает сессию; клик по строке агента — onOpenSession(сессия, агент)', () => {
    const onOpenSession = renderStrip([
      participant(subagents([task('a', { description: 'Look around' }), task('b', { agentType: 'Plan', description: 'Plan it', background: false })])),
    ]);
    fireEvent.click(within(card('s-01')).getByTestId('agents-badge'));
    expect(onOpenSession).not.toHaveBeenCalled();
    const rows = screen.getAllByTestId('agents-popover-row');
    expect(rows.map((row) => row.textContent)).toEqual(['ExplorebackgroundLook around', 'PlanPlan it']);
    fireEvent.click(rows[1]!);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('s-01', 'b');
  });

  it('клик по самой карточке — по-прежнему только сессия, без агента', () => {
    const onOpenSession = renderStrip([participant(subagents([task('a'), task('b')]))]);
    fireEvent.click(within(card('s-01')).getAllByRole('button')[0]!);
    expect(onOpenSession).toHaveBeenCalledWith('s-01');
  });

  it('ожидание важнее субагентов (agents пуст): строка — обычный текст без поповера, подсказка несёт оба', () => {
    renderStrip([participant({ doing: 'Waiting for S03', doingDetail: 'Waiting for S03\nSubagent: Task a', agents: [] })]);
    expect(within(card('s-01')).queryByTestId('agents-badge')).toBeNull();
    expect(within(card('s-01')).getByText('Waiting for S03').getAttribute('title')).toBe('Waiting for S03\nSubagent: Task a');
  });

  it('карточка 230px, подкраска и тултип — у блока карточки; ★ с подсказкой Lead остаётся внутри кнопки', () => {
    renderStrip([participant({ ...subagents([task('a'), task('b')]), lead: true, attention: 'needs-you' })]);
    expect(card('s-01').className).toContain('w-[230px]');
    expect(card('s-01').className).toContain('bg-accent-200');
    expect(card('s-01').getAttribute('title')).toBe('Claude Code');
    expect(within(card('s-01')).getByTitle('Lead').closest('button')).not.toBeNull();
  });
});

// Жалоба 2026-10-07 («роль сжимается первой»): в карточке 230px с ролью, `★` и `done · unseen` имя схлопывалось в ноль, а
// слово состояния уезжало за край. Раскладку меряет E2E `room-participants-layout.spec.ts`; здесь — кто сжимается, а кто нет.
describe('ParticipantStrip — тесная первая строка с ролью', () => {
  it('сжимается чип роли; имя — не уже 5ch (номер S01…), ★ и слово состояния не сжимаются', () => {
    renderStrip([
      participant({ role: { source: 'builtin', name: 'architect' }, lead: true, word: 'done · unseen', attention: 'unseen' }),
    ]);
    const name = within(card('s-01')).getByText('S01 архитектор');
    expect(name.className).toContain('min-w-[5ch]');
    expect(name.className).toContain('truncate');
    const chip = card('s-01').querySelector('[data-role-chip]') as HTMLElement;
    expect(chip.className).not.toMatch(/\bshrink-0\b/);
    expect(within(chip).getByText('architect · Builtin').className).toMatch(/\btruncate\b/);
    expect(within(card('s-01')).getByTitle('Lead').className).toContain('shrink-0');
    expect(within(card('s-01')).getByText('done · unseen').className).toContain('shrink-0');
  });
});

// Спека застрявших 7.3: у участника, которому нужен человек, слово состояния заменяет причина (слово вида — из core),
// подсказка слова — обрамление и `detail`.
describe('ParticipantStrip — причина «нужен ты»', () => {
  const NOW = new Date(2026, 9, 21, 12, 0);
  const reset = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute).toISOString();
  const stuck = (need: SessionNeed, patch: Partial<ParticipantModel> = {}): ParticipantModel =>
    participant({ need, attention: 'needs-you', state: 'unseen', word: 'done · unseen', ...patch });
  const strip = (participants: ParticipantModel[]) =>
    render(<ParticipantStrip participants={participants} onOpenSession={vi.fn()} now={NOW} />);

  it('слово причины вместо слова состояния, подсказка слова — обрамление и detail', () => {
    strip([stuck(makeNeed('approval', { detail: 'Bash: npm test' }))]);
    const word = within(card('s-01')).getByText('approval');
    expect(word.getAttribute('title')).toBe('Waiting for approval: Bash: npm test');
    expect(word.className).toContain('text-accent-800');
    expect(within(card('s-01')).queryByText('done · unseen')).toBeNull();
    expect(card('s-01').className).toContain('bg-accent-200');
  });

  it('лимит со временем сброса: limit · 19:27; после сброса: limit · reset', () => {
    strip([stuck(makeNeed('limit', { resetsAt: reset(21, 19, 27) }))]);
    expect(within(card('s-01')).getByText('limit · 19:27')).toBeTruthy();
    cleanup();
    strip([stuck(makeNeed('limit', { resetsAt: reset(20, 19, 27) }))]);
    expect(within(card('s-01')).getByText('limit · reset')).toBeTruthy();
  });

  it('слово startup — starting; вход — sign-in', () => {
    strip([stuck(makeNeed('startup'))]);
    expect(within(card('s-01')).getByText('starting')).toBeTruthy();
    cleanup();
    strip([stuck(makeNeed('sign-in', { account: 'auth' }))]);
    expect(within(card('s-01')).getByText('sign-in')).toBeTruthy();
  });

  it('без need — слово состояния и без подсказки', () => {
    strip([participant({ word: 'working' })]);
    const word = within(card('s-01')).getByText('working');
    expect(word.getAttribute('title')).toBeNull();
  });

  // 800×500: ярлык в 80 знаков и самое длинное слово причины — слово остаётся целым, сжимается ярлык.
  it('длинный ярлык и слово «limit · Oct 22, 19:27»: ярлык сжимается многоточием, слово не сжимается', () => {
    strip([stuck(makeNeed('limit', { resetsAt: reset(22, 19, 27) }), { label: `S01 ${'я'.repeat(76)}` })]);
    const name = within(card('s-01')).getByText(/^S01 я+$/);
    expect(name.className).toContain('min-w-[5ch]');
    expect(name.className).toContain('truncate');
    expect(within(card('s-01')).getByText('limit · Oct 22, 19:27').className).toContain('shrink-0');
  });
});

describe('чип контекста (спека 2026-10-15, 3.2)', () => {
  it('чип во второй строке вне кнопки открытия; клик по «чем занят» открывает сессию', () => {
    const onOpen = vi.fn();
    render(
      <ParticipantStrip
        participants={[participant({ doing: 'Пишет миграции' })]}
        onOpenSession={onOpen}
        contextChip={() => <span data-testid="ctx">82%</span>}
      />,
    );
    expect(screen.getByTestId('ctx').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('Пишет миграции'));
    expect(onOpen.mock.calls[0]?.[0]).toBe('s-01');
  });

  it('без contextChip или с null — прежняя разметка: одна кнопка на обе строки', () => {
    const { unmount } = render(<ParticipantStrip participants={[participant()]} onOpenSession={vi.fn()} />);
    expect(document.querySelectorAll('[data-participant="s-01"] button')).toHaveLength(1);
    unmount();
    render(<ParticipantStrip participants={[participant()]} onOpenSession={vi.fn()} contextChip={() => null} />);
    expect(document.querySelectorAll('[data-participant="s-01"] button')).toHaveLength(1);
  });
});


describe('ParticipantStrip — agent plan', () => {
  const plan = (done = 3, total = 7, partial = false): AgentPlan => capPlan({
    items: Array.from({ length: total }, (_, i) => ({ id: String(i), subject: `Step ${i + 1}`, description: null, activeForm: null, status: i < done ? 'completed' : 'in_progress' })),
    explanation: null, partial, updatedAt: '2026-10-18T00:00:00Z',
  });
  it('doing takes priority while the progress chip remains visible', () => {
    renderStrip([participant({ doing: 'Waiting for S02', plan: plan(), planLine: { kind: 'current', text: '▸ Step 4' } })]);
    expect(screen.getByText('Waiting for S02')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3/7' })).toBeTruthy();
    expect(screen.queryByText('▸ Step 4')).toBeNull();
  });
  it('opens the plan from its line and chip', () => {
    const onOpenPlan = vi.fn();
    render(<ParticipantStrip participants={[participant({ plan: plan(), planLine: { kind: 'current', text: '▸ Step 4' } })]} onOpenSession={vi.fn()} onOpenPlan={onOpenPlan} />);
    fireEvent.click(screen.getByText('▸ Step 4'));
    fireEvent.click(screen.getByRole('button', { name: '3/7' }));
    expect(onOpenPlan.mock.calls).toEqual([['s-01'], ['s-01']]);
  });
  it('all 60 steps completed returns to task with no chip despite a capped list', () => {
    renderStrip([participant({ plan: plan(60, 60) })]);
    expect(screen.getByText('Спроектировать возвраты')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '60/60' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
  });
  it('partial completed steps retain a Plan chip with no total', () => {
    renderStrip([participant({ plan: plan(3, 3, true) })]);
    expect(screen.getByText('Спроектировать возвраты')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
    expect(screen.queryByText('3/3')).toBeNull();
  });
  it('long subject and name truncate while both chips remain whole', () => {
    render(<ParticipantStrip participants={[participant({ label: 'Long agent name '.repeat(30), plan: plan(), planLine: { kind: 'current', text: '▸ ' + 'Long subject '.repeat(30) } })]} onOpenSession={vi.fn()} contextChip={() => <button>82%</button>} />);
    expect(screen.getByText(/Long agent name/).className).toContain('truncate');
    expect(screen.getByText(/▸ Long subject/).className).toContain('truncate');
    expect(screen.getByText(/▸ Long subject/).className).toContain('min-w-0');
    expect(screen.getByRole('button', { name: '3/7' }).className).toContain('shrink-0');
    expect(screen.getByText('82%').parentElement?.className).toContain('shrink-0');
  });
});


it('opens the personal plan even when no steps have been published', () => {
  const open = vi.fn();
  const session = vi.fn();
  render(<ParticipantStrip participants={[participant()]} onOpenSession={session} onOpenPlan={open} />);
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
  expect(open).toHaveBeenCalledWith('s-01');
  expect(session).not.toHaveBeenCalled();
});
