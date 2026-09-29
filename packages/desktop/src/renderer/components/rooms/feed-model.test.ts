/**
 * Модель вкладки комнаты (спека окна 2026-09-29, 1.3, 2.4, решения контролёра 1, 3, 4 куска 6):
 * шапка, лента участников, сообщения с адресатами и строкой ожидания, блок `Decisions`, карточка
 * решения. Ведущий — `roomLiveLead`, своей копии правила здесь нет.
 */

import { describe, expect, it } from 'vitest';
import type { Message, Room, WorkEntry, WorkSession } from '@harnas/core';
import { activityMap, makeActivity, makeLetter, makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { buildRoomModel, type RoomModel } from './feed-model.js';

const PROJECT = '/tmp/proj';
const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'aider', label: 'Aider' },
];

function room(patch: Partial<Room> = {}): Room {
  return { ...makeRoom('r-01', 'Возвраты'), members: ['s-01', 's-02', 's-03'], lead: 's-01', ...patch };
}

function sessions(): WorkSession[] {
  return [
    makeSession('s-01', 'архитектор', { task: 'Спроектировать возвраты' }),
    makeSession('s-02', 'бэкенд', { task: 'Частичный возврат' }),
    makeSession('s-03', 'ревью', { provider: 'codex', task: 'Ревью диффа' }),
  ];
}

function message(id: string, patch: Partial<Message> = {}): Message {
  return makeLetter(id, { roomId: 'r-01', to: [], from: 'human', ...patch });
}

function entryOf(patch: { room?: Room; sessions?: WorkSession[]; messages?: Message[]; title?: string } = {}): WorkEntry {
  return makeWork('w-01', {
    projectPath: PROJECT,
    title: patch.title ?? 'Платежи',
    sessions: patch.sessions ?? sessions(),
    rooms: [patch.room ?? room()],
    messages: patch.messages ?? [],
  });
}

function build(entry: WorkEntry, activity = {}): RoomModel {
  const model = buildRoomModel({ entry, roomId: 'r-01', providers: PROVIDERS, activity });
  if (model === null) throw new Error('комната не найдена');
  return model;
}

const REF = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-01', sessionId });

describe('buildRoomModel — шапка', () => {
  it('комнаты с таким id нет — null', () => {
    expect(buildRoomModel({ entry: entryOf(), roomId: 'r-99', providers: PROVIDERS, activity: {} })).toBeNull();
  });

  it('название и подзаголовок: Created by you · N agents · lead S01 · работа', () => {
    const model = build(entryOf());
    expect(model.title).toBe('Возвраты');
    expect(model.subtitle).toBe('Created by you · 3 agents · lead S01 · Платежи');
  });

  it('создатель — сессия: её ярлык с номером; создатель входит в число агентов один раз', () => {
    const model = build(entryOf({ room: room({ creator: 's-01', members: ['s-01', 's-02', 's-03'] }) }));
    expect(model.subtitle).toBe('Created by S01 архитектор · 3 agents · lead S01 · Платежи');
    const withoutCreatorInMembers = build(entryOf({ room: room({ creator: 's-01', members: ['s-02', 's-03'] }) }));
    expect(withoutCreatorInMembers.subtitle).toBe('Created by S01 архитектор · 3 agents · lead S01 · Платежи');
  });

  it('один агент — «1 agent»', () => {
    const model = build(entryOf({ room: room({ members: ['s-02'], lead: null }) }));
    expect(model.subtitle).toBe('Created by you · 1 agent · lead S02 · Платежи');
  });

  it('ведущий — roomLiveLead: закрытого подменяет первый живой; нет живых — части «lead» нет', () => {
    const closedLead = sessions();
    closedLead[0] = makeSession('s-01', 'архитектор', { lifecycle: 'closed' });
    expect(build(entryOf({ sessions: closedLead })).subtitle).toBe('Created by you · 3 agents · lead S02 · Платежи');

    const allClosed = sessions().map((session) => ({ ...session, lifecycle: 'closed' as const }));
    expect(build(entryOf({ sessions: allClosed })).subtitle).toBe('Created by you · 3 agents · Платежи');
  });

  it('карта до 2026-09-29 без lead и proposal читается: ведущий — первый из members', () => {
    const legacy = room();
    Reflect.deleteProperty(legacy, 'lead');
    Reflect.deleteProperty(legacy, 'proposal');
    const model = build(entryOf({ room: legacy }));
    expect(model.subtitle).toContain('lead S01');
    expect(model.proposal).toBeNull();
    expect(model.participants.filter((participant) => participant.lead).map((participant) => participant.id)).toEqual(['s-01']);
  });

  it('пустое название — запасное «Room»', () => {
    expect(build(entryOf({ room: room({ title: '' }) })).title).toBe('Room');
  });
});

describe('buildRoomModel — лента участников', () => {
  it('порядок: создатель-сессия, затем members; человек не участник-агент; удалённая сессия не выводится', () => {
    const entry = entryOf({ room: room({ creator: 's-03', members: ['s-01', 's-09', 's-02'] }) });
    entry.map.work.deletedSessions = ['s-09'];
    expect(build(entry).participants.map((participant) => participant.id)).toEqual(['s-03', 's-01', 's-02']);
  });

  it('подписи, провайдер, задача и ведущий', () => {
    const [first, , third] = build(entryOf()).participants;
    expect(first).toMatchObject({
      id: 's-01',
      label: 'S01 архитектор',
      rawLabel: 'архитектор',
      provider: 'claude',
      providerName: 'Claude Code',
      task: 'Спроектировать возвраты',
      lead: true,
      closed: false,
    });
    expect(third).toMatchObject({ id: 's-03', label: 'S03 ревью', provider: 'codex', providerName: 'Codex', lead: false });
  });

  it('незнакомый провайдер — метка хоста из providers.list, а без неё — его id', () => {
    const custom = sessions();
    custom[1] = makeSession('s-02', 'бэкенд', { provider: 'aider' });
    custom[2] = makeSession('s-03', 'ревью', { provider: 'mystery' });
    const [, second, third] = build(entryOf({ sessions: custom })).participants;
    expect(second?.providerName).toBe('Aider');
    expect(third?.providerName).toBe('mystery');
  });

  it('состояние и слово — из живой активности; подкраска по вниманию', () => {
    const activity = activityMap([
      makeActivity(REF('s-01'), 'working'),
      makeActivity(REF('s-02'), 'blocked'),
      makeActivity(REF('s-03'), 'unseen'),
    ]);
    const participants = build(entryOf(), activity).participants;
    expect(participants.map((participant) => [participant.state, participant.word, participant.attention])).toEqual([
      ['working', 'working', 'working'],
      ['blocked', 'needs you', 'needs-you'],
      ['unseen', 'done · unseen', 'unseen'],
    ]);
  });

  it('без активности живая сессия — idle; не запущенная — «not started»; закрытая — «closed» и closed: true', () => {
    const mixed = sessions();
    mixed[1] = makeSession('s-02', 'бэкенд', { lifecycle: 'pending' });
    mixed[2] = makeSession('s-03', 'ревью', { lifecycle: 'closed' });
    const participants = build(entryOf({ sessions: mixed })).participants;
    expect(participants.map((participant) => [participant.word, participant.closed])).toEqual([
      ['idle', false],
      ['not started', false],
      ['closed', true],
    ]);
  });
});

describe('buildRoomModel — модель участника из живых метрик', () => {
  const metrics = (model: string | null) => ({ tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 0, model });
  const withModels = (models: Record<string, string | null>) =>
    activityMap(Object.entries(models).map(([id, model]) => makeActivity(REF(id), 'working', { metrics: metrics(model) })));

  it('короткое имя с версией: claude-opus-5-5 → Opus 5.5, gpt-5.5 → GPT-5.5', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5-20260101', 's-03': 'gpt-5.5' });
    expect(build(entryOf(), activity).participants.map((participant) => participant.model)).toEqual(['Opus 5.5', null, 'GPT-5.5']);
  });

  it('модель неизвестна — null: нет активности, нет метрик, метрики без модели, служебная <synthetic>', () => {
    const noMetrics = activityMap([makeActivity(REF('s-01'), 'working')]);
    expect(build(entryOf(), noMetrics).participants.map((participant) => participant.model)).toEqual([null, null, null]);
    const synthetic = withModels({ 's-01': null, 's-02': '<synthetic>' });
    expect(build(entryOf(), synthetic).participants.map((participant) => participant.model)).toEqual([null, null, null]);
    expect(build(entryOf()).participants.map((participant) => participant.model)).toEqual([null, null, null]);
  });

  it('имя, которое лишь повторяет провайдера (gpt-5.2-codex у Codex), моделью не считается: «Codex · Codex» не нужно', () => {
    const activity = withModels({ 's-03': 'gpt-5.2-codex', 's-01': 'claude-sonnet-5' });
    expect(build(entryOf(), activity).participants.map((participant) => participant.model)).toEqual(['Sonnet 5', null, null]);
  });

  it('модель берётся у своей сессии: чужая активность не подмешивается', () => {
    const activity = withModels({ 's-02': 'claude-haiku-4-5' });
    expect(build(entryOf(), activity).participants.map((participant) => [participant.id, participant.model])).toEqual([
      ['s-01', null],
      ['s-02', 'Haiku 4.5'],
      ['s-03', null],
    ]);
  });
});

describe('buildRoomModel — сообщения', () => {
  it('по времени; отправитель и адресаты подписаны ярлыками', () => {
    const entry = entryOf({
      messages: [
        message('m-2', { from: 's-03', to: ['s-01'], at: '2026-09-27T09:02:00.000Z', text: 'Готово' }),
        message('m-1', { from: 'human', to: [], at: '2026-09-27T09:00:00.000Z', text: 'Задача' }),
        message('m-3', { from: 's-01', to: ['s-02', 's-03'], at: '2026-09-27T09:05:00.000Z', text: '@s02 и @s03', kind: 'question' }),
      ],
    });
    const messages = build(entry).messages;
    expect(messages.map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(messages.map((item) => [item.from, item.to, item.kind])).toEqual([
      ['You', 'all', 'note'],
      ['S03 ревью', 'S01 архитектор', 'note'],
      ['S01 архитектор', 'S02 бэкенд, S03 ревью', 'question'],
    ]);
  });

  it('вид отправителя для аватара и провайдер агента', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 'human' }),
        message('m-2', { from: 'system', to: ['human'], readBy: { human: 'x' } }),
        message('m-3', { from: 's-03' }),
      ],
    });
    expect(build(entry).messages.map((item) => item.sender)).toEqual([
      { kind: 'human', provider: null },
      { kind: 'system', provider: null },
      { kind: 'agent', provider: 'codex' },
    ]);
  });

  it('★ — у сообщений ведущего', () => {
    const entry = entryOf({ messages: [message('m-1', { from: 's-01' }), message('m-2', { from: 's-02' }), message('m-3', { from: 'human' })] });
    expect(build(entry).messages.map((item) => item.lead)).toEqual([true, false, false]);
  });

  it('системная строка (to: [human]) — без адресата «→ you» и без непрочитанного', () => {
    const entry = entryOf({
      messages: [message('m-1', { from: 'system', to: ['human'], text: 'You accepted the decision', readBy: {} })],
    });
    const [line] = build(entry).messages;
    expect(line?.to).toBeNull();
    expect(line?.unread).toBe(false);
    expect(line?.from).toBe('harnas');
  });

  it('удалённый отправитель — «S05 (deleted)», неизвестный id — как есть; провайдера у них нет', () => {
    const entry = entryOf({ messages: [message('m-1', { from: 's-05' }), message('m-2', { from: 'ghost' })] });
    entry.map.work.deletedSessions = ['s-05'];
    const messages = build(entry).messages;
    expect(messages.map((item) => item.from)).toEqual(['S05 (deleted)', 'ghost']);
    expect(messages.map((item) => item.sender.provider)).toEqual([null, null]);
  });

  it('точка «непрочитано» — по человеку (isHumanUnread), не по агентам', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-02' }),
        message('m-2', { from: 's-02', readBy: { human: '2026-09-27T09:00:00.000Z' } }),
        message('m-3', { from: 'human' }),
      ],
    });
    expect(build(entry).messages.map((item) => item.unread)).toEqual([true, false, false]);
  });

  it('needsRead — кандидат в mail.markRead: и системная строка без отметки человека, у неё точки нет', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-02' }),
        message('m-2', { from: 'system', to: ['human'], readBy: {} }),
        message('m-3', { from: 'system', to: ['human'], readBy: { human: '2026-09-27T09:00:00.000Z' } }),
        message('m-4', { from: 'human' }),
      ],
    });
    const messages = build(entry).messages;
    expect(messages.map((item) => item.needsRead)).toEqual([true, true, false, false]);
    expect(messages.map((item) => item.unread)).toEqual([true, false, false, false]);
  });

  it('письма других комнат и без комнаты в ленту не попадают', () => {
    const entry = entryOf({ messages: [message('m-1'), message('m-2', { roomId: 'r-02' }), message('m-3', { roomId: null })] });
    expect(build(entry).messages.map((item) => item.id)).toEqual(['m-1']);
  });
});

describe('buildRoomModel — строка ожидания по readBy', () => {
  it('рассылка человека: те из участников, кто ещё не прочитал', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { 's-02': '2026-09-27T09:01:00.000Z' } })] });
    expect(build(entry).messages[0]?.waiting).toEqual(['S01', 'S03']);
  });

  it('все прочитали — строки нет', () => {
    const entry = entryOf({
      messages: [message('m-1', { readBy: { 's-01': 'x', 's-02': 'x', 's-03': 'x' } })],
    });
    expect(build(entry).messages[0]?.waiting).toEqual([]);
  });

  it('адресные: только названные; сообщение агента — без самого отправителя', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { to: ['s-02', 's-03'], readBy: { 's-03': 'x' } }),
        message('m-2', { from: 's-01', to: [] }),
      ],
    });
    const [addressed, broadcast] = build(entry).messages;
    expect(addressed?.waiting).toEqual(['S02']);
    expect(broadcast?.waiting).toEqual(['S02', 'S03']);
  });

  it('закрытые и удалённые не ждутся: они не прочитают; не запущенная сессия — ждётся', () => {
    const mixed = sessions();
    mixed[0] = makeSession('s-01', 'архитектор', { lifecycle: 'closed' });
    mixed[1] = makeSession('s-02', 'бэкенд', { lifecycle: 'pending' });
    const entry = entryOf({ sessions: mixed, room: room({ members: ['s-01', 's-02', 's-03', 's-09'] }), messages: [message('m-1', { readBy: { 's-03': 'x' } })] });
    entry.map.work.deletedSessions = ['s-09'];
    expect(build(entry).messages[0]?.waiting).toEqual(['S02']);
  });

  it('письмо человеку (to: [human]) агентов не ждёт', () => {
    const entry = entryOf({ messages: [message('m-1', { from: 's-02', to: ['human'] })] });
    expect(build(entry).messages[0]?.waiting).toEqual([]);
  });
});

describe('buildRoomModel — блок Decisions', () => {
  it('сообщения вида decision: последние пять и счёт прежних', () => {
    const decisions = Array.from({ length: 7 }, (_, index) =>
      message(`m-${index}`, { from: 's-01', kind: 'decision', text: `Решение ${index}`, at: `2026-09-27T09:0${index}:00.000Z` }),
    );
    const model = build(entryOf({ messages: [...decisions, message('m-note', { kind: 'note', text: 'не решение' })] }));
    expect(model.decisions.earlier).toBe(2);
    expect(model.decisions.shown.map((item) => item.text)).toEqual(['Решение 2', 'Решение 3', 'Решение 4', 'Решение 5', 'Решение 6']);
    expect(model.decisions.shown[0]).toMatchObject({ from: 'S01 архитектор' });
  });

  it('решений нет — пусто', () => {
    expect(build(entryOf()).decisions).toEqual({ shown: [], earlier: 0 });
  });
});

describe('buildRoomModel — карточка решения и пустая комната', () => {
  const PROPOSAL = { id: 'p-01', from: 's-01', text: 'Части: @s02 — код', rev: 2, at: '2026-09-27T09:10:00.000Z' };

  it('решение ждёт: id, версия, автор с провайдером, текст', () => {
    const model = build(entryOf({ room: room({ proposal: PROPOSAL }) }));
    expect(model.proposal).toEqual({
      id: 'p-01',
      rev: 2,
      at: '2026-09-27T09:10:00.000Z',
      text: 'Части: @s02 — код',
      from: 'S01 архитектор',
      provider: 'claude',
    });
  });

  it('пустая комната — без сообщений и без решения; решение само делает комнату непустой', () => {
    expect(build(entryOf()).empty).toBe(true);
    expect(build(entryOf({ room: room({ proposal: PROPOSAL }) })).empty).toBe(false);
    expect(build(entryOf({ messages: [message('m-1')] })).empty).toBe(false);
  });
});
