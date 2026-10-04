/**
 * Модель вкладки комнаты (спека окна 2026-09-29, 1.3, 2.4, решения контролёра 1, 3, 4 куска 6):
 * шапка, лента участников, сообщения с адресатами и строкой доставки, блок `Decisions`, карточка
 * решения. Ведущий — `roomLiveLead`, своей копии правила здесь нет.
 */

import { describe, expect, it } from 'vitest';
import type { Message, Room, WorkEntry, WorkSession } from '@parley/core';
import type { LiveMetrics, LiveTask, MailWait } from '@parley/protocol';
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

describe('buildRoomModel — чем занят участник (Parley 0.2.0)', () => {
  const metrics = (extra: Partial<LiveMetrics>): LiveMetrics => ({
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
    unread: 0,
    subagents: 0,
    model: null,
    ...extra,
  });
  const task = (id: string, extra: Partial<LiveTask> = {}): LiveTask => ({
    id,
    agentType: 'general-purpose',
    description: `Задача ${id}`,
    background: true,
    ...extra,
  });
  /** Участник `s-01` с живой активностью и данными хоста. */
  const doingOf = (extra: Partial<LiveMetrics>, sessionsOver?: WorkSession[]) => {
    const activity = activityMap([
      makeActivity(REF('s-01'), 'working', { metrics: metrics(extra) }),
    ]);
    const first = build(
      entryOf(sessionsOver === undefined ? {} : { sessions: sessionsOver }),
      activity,
    ).participants[0];
    return { doing: first?.doing, doingDetail: first?.doingDetail };
  };

  it('ничего не делает — null; хост прежней версии не присылает полей — тоже null', () => {
    expect(doingOf({})).toEqual({ doing: null, doingDetail: null });
    expect(doingOf({ tasks: [], waitingFor: null })).toEqual({ doing: null, doingDetail: null });
    expect(
      build(entryOf()).participants.map((participant) => [
        participant.doing,
        participant.doingDetail,
      ]),
    ).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it('один субагент — «Subagent: описание»; без описания — тип агента; без обоих — просто «Subagent»', () => {
    expect(doingOf({ tasks: [task('a', { description: 'Orca mobile app research' })] })).toEqual({
      doing: 'Subagent: Orca mobile app research',
      doingDetail: 'Subagent: Orca mobile app research',
    });
    expect(doingOf({ tasks: [task('a', { description: null })] }).doing).toBe(
      'Subagent: general-purpose',
    );
    expect(doingOf({ tasks: [task('a', { description: null, agentType: null })] }).doing).toBe(
      'Subagent',
    );
  });

  it('несколько — «N subagents: первое описание», а подсказка — весь список', () => {
    const tasks = [
      task('a', { description: 'Orca mobile app research' }),
      task('b', { description: 'Docs lookup', background: false }),
      task('c', { description: null, agentType: null }),
    ];
    expect(doingOf({ tasks })).toEqual({
      doing: '3 subagents: Orca mobile app research',
      doingDetail: '3 subagents\n• Orca mobile app research\n• Docs lookup\n• Subagent',
    });
  });

  it('у первого субагента нет ни описания, ни типа — «первым» берётся первое известное название', () => {
    const tasks = [
      task('a', { description: null, agentType: null }),
      task('b', { description: 'Docs lookup' }),
    ];
    expect(doingOf({ tasks }).doing).toBe('2 subagents: Docs lookup');
    expect(
      doingOf({
        tasks: [
          task('a', { description: null, agentType: null }),
          task('b', { description: null, agentType: null }),
        ],
      }).doing,
    ).toBe('2 subagents');
  });

  it('ожидание сессии — «Waiting for S03» (тег сессии), inbox — «Waiting for messages»', () => {
    expect(doingOf({ waitingFor: 's-03' })).toEqual({
      doing: 'Waiting for S03',
      doingDetail: 'Waiting for S03',
    });
    expect(doingOf({ waitingFor: 'inbox' })).toEqual({
      doing: 'Waiting for messages',
      doingDetail: 'Waiting for messages',
    });
    // Чужой id остаётся как есть, как и в подписях переписки.
    expect(doingOf({ waitingFor: 'ghost' }).doing).toBe('Waiting for ghost');
  });

  it('ожидание в строке важнее субагентов — оно держит агента прямо сейчас; подсказка несёт оба', () => {
    expect(
      doingOf({ waitingFor: 's-02', tasks: [task('a', { description: 'Docs lookup' })] }),
    ).toEqual({
      doing: 'Waiting for S02',
      doingDetail: 'Waiting for S02\nSubagent: Docs lookup',
    });
  });

  // Кусок 4b плана 2026-10-01: поповер на строке субагентов получает их списком.
  it('agents — те же субагенты для поповера: список, пока строка — субагенты; ожидание важнее — пусто; ничем не занят — пусто', () => {
    const agentsOf = (extra: Partial<LiveMetrics>, sessionsOver?: WorkSession[]) =>
      build(
        entryOf(sessionsOver === undefined ? {} : { sessions: sessionsOver }),
        activityMap([makeActivity(REF('s-01'), 'working', { metrics: metrics(extra) })]),
      ).participants[0]?.agents;
    const tasks = [task('a'), task('b', { background: false })];
    expect(agentsOf({ tasks })).toEqual(tasks);
    expect(agentsOf({ tasks: [task('a')] })).toEqual([task('a')]);
    expect(agentsOf({ tasks, waitingFor: 's-02' })).toEqual([]);
    expect(agentsOf({ tasks: [], waitingFor: null })).toEqual([]);
    expect(agentsOf({})).toEqual([]);
    // Нет активности вовсе — пусто, а не «неизвестно».
    expect(build(entryOf()).participants.map((participant) => participant.agents)).toEqual([[], [], []]);
    // Только у живой сессии: у закрытой, спящей и не запущенной метрики — след прошлого процесса.
    for (const lifecycle of ['closed', 'sleeping', 'pending'] as const) {
      const custom = sessions();
      custom[0] = makeSession('s-01', 'архитектор', { lifecycle });
      expect(agentsOf({ tasks }, custom), lifecycle).toEqual([]);
    }
  });

  it('данные только у живой сессии: закрытая, спящая и не запущенная ничем не заняты', () => {
    const busy = { tasks: [task('a')], waitingFor: 's-02' };
    for (const lifecycle of ['closed', 'sleeping', 'pending'] as const) {
      const custom = sessions();
      custom[0] = makeSession('s-01', 'архитектор', { lifecycle });
      expect(doingOf(busy, custom), lifecycle).toEqual({ doing: null, doingDetail: null });
    }
  });

  it('сессия с фоновыми субагентами — working: состояние приходит с хоста, окно его не понижает', () => {
    const activity = activityMap([
      makeActivity(REF('s-01'), 'working', {
        metrics: metrics({ subagents: 3, tasks: [task('a'), task('b'), task('c')] }),
      }),
    ]);
    const [first] = build(entryOf(), activity).participants;
    expect([first?.state, first?.word, first?.attention]).toEqual([
      'working',
      'working',
      'working',
    ]);
  });

  it('данные берутся у своей сессии: чужая активность не подмешивается', () => {
    const activity = activityMap([
      makeActivity(REF('s-02'), 'working', { metrics: metrics({ waitingFor: 'inbox' }) }),
    ]);
    expect(build(entryOf(), activity).participants.map((participant) => participant.doing)).toEqual(
      [null, 'Waiting for messages', null],
    );
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
    expect(line?.from).toBe('Parley');
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

  it('mentionsYou — агент назвал человека (@human) по правилу ленты: код и ссылка не в счёт, свои и системные — нет', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-02', text: 'Готово, @human' }),
        message('m-2', { from: 's-02', text: 'Готово, `@human`' }),
        message('m-3', { from: 's-02', text: '[ask @human](https://x.dev)' }),
        message('m-4', {
          from: 's-02',
          text: '_@human_ решает',
          readBy: { human: '2026-09-27T09:00:00.000Z' },
        }),
        message('m-5', { from: 'human', text: 'я сам, @human' }),
        message('m-6', { from: 'system', to: ['human'], text: '@human' }),
        message('m-7', { from: 's-02', text: 'без упоминаний' }),
        message('m-8', { from: 's-02', text: 'ask the @humans' }),
      ],
    });
    const messages = build(entry).messages;
    expect(messages.map((item) => item.mentionsYou)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    // Прочитанность — отдельно: упоминание m-4 уже прочитано, и открытие комнаты (`unread && mentionsYou`) его не ищет.
    expect(
      messages.filter((item) => item.unread && item.mentionsYou).map((item) => item.id),
    ).toEqual(['m-1']);
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

describe('buildRoomModel — ответы: Message.replyTo (Parley 0.3.0)', () => {
  it('сообщение без replyTo — reply: null', () => {
    const entry = entryOf({ messages: [message('m-1'), message('m-2', { from: 's-02' })] });
    expect(build(entry).messages.map((item) => item.reply)).toEqual([null, null]);
  });

  it('ответ на вопрос человека: оригинал найден, подпись «You», выдержка — первый абзац текста', () => {
    const entry = entryOf({
      messages: [
        message('m-1', {
          text: 'Что с миграцией?\nИ ещё вопрос\n\nВторой абзац',
          kind: 'question',
          at: '2026-09-27T09:00:00.000Z',
        }),
        message('m-2', {
          from: 's-02',
          to: ['human'],
          text: 'Готово',
          replyTo: 'm-1',
          at: '2026-09-27T09:01:00.000Z',
        }),
      ],
    });
    const [question, answer] = build(entry).messages;
    expect(question?.reply).toBeNull();
    expect(answer?.reply).toEqual({
      id: 'm-1',
      from: 'You',
      excerpt: 'Что с миграцией? И ещё вопрос',
      found: true,
    });
  });

  it('подпись оригинала — как у сообщения в ленте: ярлык с номером, Parley у системной строки, «(deleted)» у удалённой сессии', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-03', text: 'Ревью готово', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', {
          from: 'system',
          to: ['human'],
          text: 'You accepted the decision',
          at: '2026-09-27T09:01:00.000Z',
        }),
        message('m-3', { from: 's-05', text: 'Ушла', at: '2026-09-27T09:02:00.000Z' }),
        message('m-4', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:03:00.000Z' }),
        message('m-5', { from: 's-02', replyTo: 'm-2', at: '2026-09-27T09:04:00.000Z' }),
        message('m-6', { from: 's-02', replyTo: 'm-3', at: '2026-09-27T09:05:00.000Z' }),
      ],
    });
    entry.map.work.deletedSessions = ['s-05'];
    const replies = build(entry)
      .messages.slice(3)
      .map((item) => item.reply);
    expect(replies.map((reply) => [reply?.from, reply?.excerpt, reply?.found])).toEqual([
      ['S03 ревью', 'Ревью готово', true],
      ['Parley', 'You accepted the decision', true],
      ['S05 (deleted)', 'Ушла', true],
    ]);
  });

  it('оригинал из другой комнаты или несуществующий — found: false, подпись и выдержка пусты, id остаётся', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { roomId: 'r-02', text: 'В чужой комнате', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', { roomId: null, text: 'Без комнаты', at: '2026-09-27T09:01:00.000Z' }),
        message('m-3', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:02:00.000Z' }),
        message('m-4', { from: 's-02', replyTo: 'm-2', at: '2026-09-27T09:03:00.000Z' }),
        message('m-5', { from: 's-02', replyTo: 'm-99', at: '2026-09-27T09:04:00.000Z' }),
      ],
    });
    const messages = build(entry).messages;
    expect(messages.map((item) => item.id)).toEqual(['m-3', 'm-4', 'm-5']);
    expect(messages.map((item) => item.reply)).toEqual([
      { id: 'm-1', from: '', excerpt: '', found: false },
      { id: 'm-2', from: '', excerpt: '', found: false },
      { id: 'm-99', from: '', excerpt: '', found: false },
    ]);
  });

  it('порядок хранения не важен: оригинал ищется и когда лежит в массиве позже ответа', () => {
    const entry = entryOf({
      messages: [
        message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
        message('m-1', { text: 'Вопрос', at: '2026-09-27T09:00:00.000Z' }),
      ],
    });
    const [question, answer] = build(entry).messages;
    expect(question?.id).toBe('m-1');
    expect(answer?.reply).toEqual({ id: 'm-1', from: 'You', excerpt: 'Вопрос', found: true });
  });

  it('выдержка из оригинала: разметка снята, упоминания — ярлыками участников, как у чипов ленты', () => {
    const entry = entryOf({
      messages: [
        message('m-1', {
          from: 's-01',
          text: '## **@s02**, @human и @s09: что с [API](https://example.com)?',
          at: '2026-09-27T09:00:00.000Z',
        }),
        message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
      ],
    });
    expect(build(entry).messages[1]?.reply).toEqual({
      id: 'm-1',
      from: 'S01 архитектор',
      excerpt: '@S02 бэкенд, @you и @S09: что с API?',
      found: true,
    });
  });

  it('выдержка из оригинала — по правилам excerpt.ts: разрыв и пустой блок кода пропущены, флажок снят, упоминание в коде остаётся кодом', () => {
    const entry = entryOf({
      messages: [
        message('m-1', {
          from: 's-01',
          text: '---\n> ```ts\n- [ ] проверить `@human` и @s02',
          at: '2026-09-27T09:00:00.000Z',
        }),
        message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
      ],
    });
    expect(build(entry).messages[1]?.reply?.excerpt).toBe('проверить @human и @S02 бэкенд');
  });

  it('выдержка — из того же разбора, что лента: @human в подписи ссылки и в коде остаётся буквальным', () => {
    const entry = entryOf({
      messages: [
        message('m-1', {
          from: 's-01',
          text: 'Спросить [@human](https://example.com) про `@human` и @human',
          at: '2026-09-27T09:00:00.000Z',
        }),
        message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
      ],
    });
    expect(build(entry).messages[1]?.reply?.excerpt).toBe('Спросить @human про @human и @you');
  });

  it('оригинал человека: его @human в цитате — текст, как в ленте; у агента и системной строки — «@you»', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { text: 'Сам себе, @human', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', {
          from: 's-01',
          text: 'Нужен ответ, @human',
          at: '2026-09-27T09:01:00.000Z',
        }),
        message('m-3', {
          from: 'system',
          to: ['human'],
          text: 'Writing to @human',
          at: '2026-09-27T09:02:00.000Z',
        }),
        message('m-4', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:03:00.000Z' }),
        message('m-5', { from: 's-02', replyTo: 'm-2', at: '2026-09-27T09:04:00.000Z' }),
        message('m-6', { from: 's-02', replyTo: 'm-3', at: '2026-09-27T09:05:00.000Z' }),
      ],
    });
    const replies = build(entry).messages.slice(3);
    expect(replies.map((item) => item.reply?.excerpt)).toEqual([
      'Сам себе, @human',
      'Нужен ответ, @you',
      'Writing to @you',
    ]);
  });

  it('ответ на ответ: цитата ведёт к ближайшему сообщению, а не по цепочке; текст самого ответа не подмешивается', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { text: 'Первый вопрос', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', {
          from: 's-02',
          replyTo: 'm-1',
          text: 'Первый ответ',
          at: '2026-09-27T09:01:00.000Z',
        }),
        message('m-3', {
          from: 's-03',
          replyTo: 'm-2',
          text: 'Второй ответ',
          at: '2026-09-27T09:02:00.000Z',
        }),
      ],
    });
    const messages = build(entry).messages;
    expect(messages[2]?.reply).toEqual({
      id: 'm-2',
      from: 'S02 бэкенд',
      excerpt: 'Первый ответ',
      found: true,
    });
    expect(messages[2]?.text).toBe('Второй ответ');
  });
});

describe('buildRoomModel — доставка: кто забрал сообщение и кто ещё нет', () => {
  const T1 = '2026-09-27T09:01:00.000Z';
  const T2 = '2026-09-27T09:02:00.000Z';
  const T3 = '2026-09-27T09:03:00.000Z';
  const deliveryOf = (entry: WorkEntry, activity = {}, index = 0) => build(entry, activity).messages[index]?.delivery;
  /** Живые метрики сессий с причиной ожидания; `undefined` — метрики есть, а поля `mailWaiting` нет (хост прежней версии). */
  const withMailWaiting = (reasons: Record<string, MailWait | null | undefined>) =>
    activityMap(
      Object.entries(reasons).map(([id, mailWaiting]) =>
        makeActivity(REF(id), 'working', {
          metrics: {
            tokensIn: null,
            tokensOut: null,
            durationMs: null,
            unread: 0,
            subagents: 0,
            model: null,
            ...(mailWaiting === undefined ? {} : { mailWaiting }),
          },
        }),
      ),
    );

  it('рассылка человека: забравшие — с временем из readBy, остальные ждут', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { 's-02': T1 } })] });
    expect(deliveryOf(entry)).toEqual({
      picked: [{ tag: 'S02', at: T1 }],
      waiting: [
        { tag: 'S01', reason: null },
        { tag: 'S03', reason: null },
      ],
    });
  });

  it('никто не забрал — забравших нет; все забрали — ждущих нет, порядок как у адресатов, а не по времени отметки', () => {
    expect(deliveryOf(entryOf({ messages: [message('m-1')] }))?.picked).toEqual([]);
    const entry = entryOf({ messages: [message('m-1', { readBy: { 's-03': T1, 's-01': T2, 's-02': T3 } })] });
    expect(deliveryOf(entry)).toEqual({
      picked: [
        { tag: 'S01', at: T2 },
        { tag: 'S02', at: T3 },
        { tag: 'S03', at: T1 },
      ],
      waiting: [],
    });
  });

  it('адресные: только названные, в порядке `to`; сообщение агента — без самого отправителя', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { to: ['s-03', 's-02'], readBy: { 's-03': T1 } }),
        message('m-2', { from: 's-01', to: [] }),
      ],
    });
    const [addressed, broadcast] = build(entry).messages;
    expect(addressed?.delivery).toEqual({
      picked: [{ tag: 'S03', at: T1 }],
      waiting: [{ tag: 'S02', reason: null }],
    });
    expect(broadcast?.delivery.picked).toEqual([]);
    expect(broadcast?.delivery.waiting.map((item) => item.tag)).toEqual(['S02', 'S03']);
  });

  it('закрытую и удалённую не ждём, а забравшая до закрытия остаётся в записи; не запущенная сессия ждётся', () => {
    const mixed = sessions();
    mixed[0] = makeSession('s-01', 'архитектор', { lifecycle: 'closed' });
    mixed[1] = makeSession('s-02', 'бэкенд', { lifecycle: 'pending' });
    const entry = entryOf({
      sessions: mixed,
      room: room({ members: ['s-01', 's-02', 's-03', 's-09'] }),
      // Закрытая сессия успела забрать сообщение, прежде чем закрылась: запись о том, что было, остаётся.
      messages: [message('m-1', { readBy: { 's-01': T1, 's-03': T2 } })],
    });
    entry.map.work.deletedSessions = ['s-09'];
    expect(deliveryOf(entry)).toEqual({
      picked: [
        { tag: 'S01', at: T1 },
        { tag: 'S03', at: T2 },
      ],
      waiting: [{ tag: 'S02', reason: null }],
    });
  });

  it('человек и система не «забирают»: письмо человеку, системная строка и они среди названных — не в счёт', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-02', to: ['human'], readBy: { human: T1 } }),
        message('m-2', { from: 'system', to: ['human'] }),
        message('m-3', { from: 's-01', to: ['human', 'system', 's-02'] }),
      ],
    });
    const [toHuman, system, mixed] = build(entry).messages;
    expect(toHuman?.delivery).toEqual({ picked: [], waiting: [] });
    expect(system?.delivery).toEqual({ picked: [], waiting: [] });
    expect(mixed?.delivery).toEqual({ picked: [], waiting: [{ tag: 'S02', reason: null }] });
  });

  it('причина — metrics.mailWaiting сессии; нет активности, нет метрик, нет поля и null дают reason: null', () => {
    const entry = entryOf({ messages: [message('m-1')] });
    const reasons = (activity = {}) => deliveryOf(entry, activity)?.waiting.map((item) => item.reason);
    expect(reasons(withMailWaiting({ 's-01': 'busy', 's-02': 'draft', 's-03': 'paused' }))).toEqual(['busy', 'draft', 'paused']);
    // Хост прежней версии: метрики есть, поля нет.
    expect(reasons(withMailWaiting({ 's-01': undefined, 's-02': undefined, 's-03': undefined }))).toEqual([null, null, null]);
    expect(reasons(withMailWaiting({ 's-01': null }))).toEqual([null, null, null]);
    // Метрик нет вовсе: активность без метрик и пустая карта активности.
    expect(reasons(activityMap([makeActivity(REF('s-01'), 'working')]))).toEqual([null, null, null]);
    expect(reasons()).toEqual([null, null, null]);
  });

  it('причина берётся у своей сессии: чужая активность не подмешивается; забравшему причина не нужна', () => {
    const entry = entryOf({ messages: [message('m-1', { to: ['s-01', 's-02'], readBy: { 's-02': T1 } })] });
    const delivery = deliveryOf(entry, withMailWaiting({ 's-02': 'busy', 's-03': 'sleeping' }));
    expect(delivery).toEqual({
      picked: [{ tag: 'S02', at: T1 }],
      waiting: [{ tag: 'S01', reason: null }],
    });
  });

  it('причина есть и у не активной сессии: sleeping, resuming и pending приходят именно для спящих и не запущенных', () => {
    for (const [lifecycle, reason] of [
      ['sleeping', 'sleeping'],
      ['sleeping', 'resuming'],
      ['pending', 'pending'],
    ] as const) {
      const custom = sessions();
      custom[0] = makeSession('s-01', 'архитектор', { lifecycle });
      const entry = entryOf({ sessions: custom, messages: [message('m-1', { to: ['s-01'] })] });
      expect(deliveryOf(entry, withMailWaiting({ 's-01': reason }))?.waiting, `${lifecycle}/${reason}`).toEqual([
        { tag: 'S01', reason },
      ]);
    }
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

it('projects native plan/proposal identities and treats Parley as coordination without losing unread', () => {
 const entry=entryOf({messages:[message('m-01',{from:'parley',to:['human'],readBy:{},text:'Plan ready'})]});
 entry.map.rooms[0]!.mode='verified';
 const plan: import('@parley/core').RoomPlan={id:'pl-01',roomId:'r-01',rev:2,mode:'verified',status:'completing',goal:'Goal',items:[],backlog:[],acceptedAt:'x',completedAt:null,cancelledAt:null,completionSummary:null};
 entry.map.plans=[plan]; entry.map.rooms[0]!.proposal={id:'p-01',rev:1,from:'s-01',at:'x',text:'Complete',kind:'completion',planId:'pl-01',planRev:2};
 const model=build(entry); expect(model.mode).toBe('verified');expect(model.plan).toBe(plan);expect(model.proposal).toMatchObject({kind:'completion',planId:'pl-01',planRev:2});
 expect(model.messages[0]).toMatchObject({from:'Parley',sender:{kind:'system',provider:null},unread:true,needsRead:true,to:'You'});
});
