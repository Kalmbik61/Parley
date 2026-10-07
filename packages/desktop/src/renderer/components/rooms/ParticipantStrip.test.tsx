/**
 * Лента участников: вторая строка карточки — чем занят участник (`doing`), а без этого — его задача
 * (Parley 0.2.0, активность агентов). Подсказка второй строки — `doingDetail`. Строка субагентов — бейдж с поповером
 * (кусок 4b плана 2026-10-01): клик по агенту открывает сессию участника на карточке этого агента.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LiveTask } from '@parley/protocol';
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
