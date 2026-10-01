/**
 * Лента участников: вторая строка карточки — чем занят участник (`doing`), а без этого — его задача
 * (Parley 0.2.0, активность агентов). Подсказка второй строки — `doingDetail`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
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
    fireEvent.click(card('s-01'));
    expect(onOpenSession).toHaveBeenCalledWith('s-01');
  });
});
