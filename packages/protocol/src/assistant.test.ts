import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssistantOrigin, AssistantProposal, AssistantState, ProposalCardView, RoomProposalView } from './assistant.js';
import { METHODS } from './methods.js';

describe('схемы методов помощника', () => {
  it('assistant.ask: текст обязателен, провайдер и модель могут быть null', () => {
    expect(METHODS['assistant.ask'].safeParse({ text: 'кто работает?', provider: null, model: null, language: 'ru' }).success).toBe(true);
    expect(METHODS['assistant.ask'].safeParse({ text: '', provider: null, model: null, language: 'ru' }).success).toBe(false);
    expect(METHODS['assistant.ask'].safeParse({ text: 'x', provider: 'claude', model: 'haiku', language: 'RU' }).success).toBe(false);
  });
  it('assistant.ask: язык — код Whisper из двух-трёх латинских строчных букв', () => {
    const ask = (language: string): boolean => METHODS['assistant.ask'].safeParse({ text: 'x', provider: null, model: null, language }).success;
    expect(ask('uk')).toBe(true);
    expect(ask('yue')).toBe(true);
    expect(ask('english')).toBe(false);
    expect(ask('RU')).toBe(false);
  });
  it('assistant.decide: только send и cancel', () => {
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'send' }).success).toBe(true);
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'maybe' }).success).toBe(false);
  });
  it('assistant.sent: ссылка на сессию', () => {
    expect(METHODS['assistant.sent'].safeParse({ ref: { projectPath: '/p', workId: 'w', sessionId: 's' } }).success).toBe(true);
  });
});

describe('виды карточки помощника', () => {
  const base = { id: 'p1', target: 'Auth', where: 'Parley · my_harnas', text: 'Сделай X' };

  it('допускает все четыре вида; у письма action необязателен', () => {
    const legacy: AssistantProposal = { ...base, kind: 'note', wake: false };
    const message: AssistantProposal = { ...base, action: 'message', kind: null, mentions: ['S03 Ruslan'], wake: true };
    const room: AssistantProposal = { ...base, action: 'room', title: 'Auth', members: ['S01', 'S02'], lead: 'S01', task: null };
    const decision: AssistantProposal = {
      ...base,
      action: 'decision',
      card: { cardId: 'c1', kind: 'permission', summary: 'Run ls', detail: null },
      decision: { kind: 'permission', behavior: 'allow' },
    };
    const roomDecision: AssistantProposal = {
      ...base,
      action: 'room-decision',
      proposal: { proposalId: 'r1', rev: 1, kind: 'decision', from: 'S01', text: 'Ship it' },
      choice: 'return',
      note: 'Нужны тесты',
    };
    expect([legacy, message, room, decision, roomDecision]).toHaveLength(5);
  });

  it('общие поля обязательны: room без text не проходит', () => {
    // @ts-expect-error — у каждого вида есть text: старое окно показывает любую карточку как письмо
    const noText: AssistantProposal = { id: 'p1', target: 'Auth', where: 'w', action: 'room', title: 'Auth', members: [], lead: 'S01', task: null };
    expect(noText.id).toBe('p1');
  });

  it('вспомогательные виды имеют заданную форму', () => {
    expectTypeOf<ProposalCardView['kind']>().toEqualTypeOf<'permission' | 'question' | 'plan'>();
    expectTypeOf<RoomProposalView['kind']>().toEqualTypeOf<'decision' | 'completion'>();
    expectTypeOf<RoomProposalView['planId']>().toEqualTypeOf<string | undefined>();
  });

  it('AssistantState принимает outcome done и origin reminder; origin необязателен', () => {
    expectTypeOf<AssistantState['outcome']>().toEqualTypeOf<'sent' | 'done' | 'cancelled' | null>();
    expectTypeOf<AssistantState['origin']>().toEqualTypeOf<AssistantOrigin | undefined>();
    expectTypeOf<AssistantOrigin>().toEqualTypeOf<'island' | 'reminder'>();
  });
});
