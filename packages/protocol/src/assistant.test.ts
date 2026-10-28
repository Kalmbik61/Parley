import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssistantMood } from '@parley/core';
import {
  ASSISTANT_ACTIONS_FEATURE,
  assistantMethodSchemas,
  reportLine,
  type ActionStepView,
  type ActionsReport,
  type AssistantOrigin,
  type AssistantProposal,
  type AssistantState,
  type ProposalCardView,
  type RoomProposalView,
} from './assistant.js';
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
  it('assistant.configure: voiceGender необязателен, только female, male и neutral', () => {
    const settings = { enabled: true, provider: null, model: null, language: 'ru', voiceModel: null };
    const configure = (extra: object) => METHODS['assistant.configure'].safeParse({ ...settings, ...extra });
    expect(configure({}).success).toBe(true);
    for (const voiceGender of ['female', 'male', 'neutral']) {
      expect(configure({ voiceGender }).data).toMatchObject({ voiceGender });
    }
    expect(configure({ voiceGender: 'robot' }).success).toBe(false);
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

  it('AssistantState.moods необязателен: позиции эмоций в очищенном ответе', () => {
    expectTypeOf<AssistantState['moods']>().toEqualTypeOf<Array<{ at: number; mood: AssistantMood }> | undefined>();
  });
});

describe('протокол карточки действий', () => {
  it('decide принимает action: actions, без поля — тоже; чужое значение — нет', () => {
    const decide = assistantMethodSchemas['assistant.decide'];
    expect(decide.parse({ proposalId: 'p1', decision: 'send', action: 'actions' })).toEqual({ proposalId: 'p1', decision: 'send', action: 'actions' });
    expect(decide.parse({ proposalId: 'p1', decision: 'send' })).toEqual({ proposalId: 'p1', decision: 'send' });
    expect(decide.safeParse({ proposalId: 'p1', decision: 'send', action: 'room' }).success).toBe(false);
  });
  it('configure: defaultProvider необязателен и может быть null', () => {
    const base = { enabled: true, provider: null, model: null, language: 'ru', voiceModel: null };
    expect(assistantMethodSchemas['assistant.configure'].parse({ ...base, defaultProvider: null })).toMatchObject({ defaultProvider: null });
    expect(assistantMethodSchemas['assistant.configure'].parse({ ...base, defaultProvider: 'glm' })).toMatchObject({ defaultProvider: 'glm' });
    expect(assistantMethodSchemas['assistant.configure'].parse(base)).not.toHaveProperty('defaultProvider');
    expect(assistantMethodSchemas['assistant.configure'].safeParse({ ...base, defaultProvider: '' }).success).toBe(false);
  });
  it('reportLine: ход, итог и остановка', () => {
    const steps = [{ line: 'a', status: 'done' }, { line: 'b', status: 'failed' }, { line: 'c', status: 'skipped' }] as const;
    expect(reportLine({ proposalId: 'p1', status: 'stopped', steps: [...steps], failedStep: 2, reason: 'S05 Vera is already asleep', notes: [] })).toBe('Stopped at step 2 of 3: S05 Vera is already asleep');
    expect(reportLine({ proposalId: 'p1', status: 'running', steps: [{ line: 'a', status: 'done' }, { line: 'b', status: 'running' }], failedStep: null, reason: null, notes: [] })).toBe('Running step 2 of 2');
  });
  it('reportLine: пока ни один шаг не running — первый waiting; готово — Done', () => {
    const waiting: ActionsReport = {
      proposalId: 'p1',
      status: 'running',
      steps: [{ line: 'a', status: 'done' }, { line: 'b', status: 'waiting' }, { line: 'c', status: 'waiting' }],
      failedStep: null,
      reason: null,
      notes: [],
    };
    expect(reportLine(waiting)).toBe('Running step 2 of 3');
    expect(reportLine({ ...waiting, status: 'done', steps: waiting.steps.map((step) => ({ ...step, status: 'done' as const })) })).toBe('Done');
  });
  it('карточка actions входит в AssistantProposal, признак клиента задан', () => {
    const step: ActionStepView = { verb: 'wake', line: 'Wake S05 Vera', text: null, danger: false };
    const card: AssistantProposal = { id: 'p1', target: 'Auth', where: 'Parley · my_harnas', text: 'Wake S05 Vera', action: 'actions', steps: [step] };
    expect(card.action).toBe('actions');
    expect(ASSISTANT_ACTIONS_FEATURE).toBe('assistant-actions');
  });
  it('AssistantState.report необязателен: ActionsReport или null', () => {
    expectTypeOf<AssistantState['report']>().toEqualTypeOf<ActionsReport | null | undefined>();
  });
});
