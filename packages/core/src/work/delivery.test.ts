import { describe, expect, it } from 'vitest';
import type { SessionActivity } from './activity.js';
import { oneLine } from '../counters.js';
import { deliveryAction, isPointerText, pointerText } from './delivery.js';
import type { Message, Room, WorkSession } from './types.js';

const sessionOf = (patch: Partial<WorkSession> = {}): WorkSession => ({
  id: 's-01',
  provider: 'claude',
  label: 'сессия',
  task: '',
  parent: null,
  contextFrom: [],
  lifecycle: 'active',
  result: null,
  resultAt: null,
  closedAt: null,
  history: [],
  startedAt: null,
  endedAt: null,
  pid: null,
  startedAtProcess: null,
  launchedBy: 'host',
  providerSessionId: null,
  metrics: null,
  summary: null,
  summarySource: null,
  artifacts: [],
  agent: null,
  ...patch,
});

const messageOf = (patch: Partial<Message> = {}): Message => ({
  id: 'm-01',
  roomId: null,
  from: 's-00',
  to: ['s-01'],
  at: new Date().toISOString(),
  text: 'привет',
  kind: 'note',
  readBy: {},
  ...patch,
});

const activityOf = (
  activity: SessionActivity['activity'],
  patch: Partial<SessionActivity> = {},
): SessionActivity => ({
  activity,
  subagents: 0,
  tasks: [],
  waitingFor: null,
  heldByBackground: false,
  turnEndedAt: null,
  lastEventAt: null,
  source: 'hooks',
  exited: false,
  hooksMissing: false,
  ...patch,
});

const roomOf = (id: string, title: string): Room => ({
  id,
  title,
  creator: 's-01',
  members: ['s-02'],
  createdAt: new Date().toISOString(),
  lead: null,
  proposal: null,
  archivedAt: null,
});

describe('pointerText', () => {
  const rooms = [roomOf('r-01', 'Ревью «схемы» — ёж'), roomOf('r-02', 'Вторая')];

  it('одно прямое письмо', () => {
    expect(pointerText([messageOf()], rooms)).toBe('New messages (1). Call check_inbox.');
  });

  it('три прямых письма', () => {
    const letters = ['m-01', 'm-02', 'm-03'].map((id) => messageOf({ id }));
    expect(pointerText(letters, rooms)).toBe('New messages (3). Call check_inbox.');
  });

  it('все из одной комнаты — id и название; кириллица и кавычки целы', () => {
    const letters = [messageOf({ id: 'm-01', roomId: 'r-01' }), messageOf({ id: 'm-02', roomId: 'r-01' })];
    expect(pointerText(letters, rooms)).toBe(
      'New messages (2) in r-01 "Ревью «схемы» — ёж". Call check_inbox.',
    );
  });

  it('из нескольких комнат — список id', () => {
    const letters = [messageOf({ id: 'm-01', roomId: 'r-02' }), messageOf({ id: 'm-02', roomId: 'r-01' })];
    expect(pointerText(letters, rooms)).toBe('New messages (2) in r-01, r-02. Call check_inbox.');
  });

  it('комнаты вместе с прямыми — «and direct»', () => {
    const letters = [messageOf({ id: 'm-01', roomId: 'r-01' }), messageOf({ id: 'm-02' })];
    expect(pointerText(letters, rooms)).toBe('New messages (2) in r-01 and direct. Call check_inbox.');
  });

  describe('задача человека всем в комнате — пометка перед точкой головы', () => {
    // Задача всем: от человека, в комнате и без адресата.
    const taskOf = (patch: Partial<Message> = {}): Message =>
      messageOf({ from: 'human', to: [], roomId: 'r-01', ...patch });

    it('в одной комнате — пометка после названия', () => {
      expect(pointerText([taskOf()], rooms)).toBe(
        'New messages (1) in r-01 "Ревью «схемы» — ёж" (a task for everyone). Call check_inbox.',
      );
    });

    it('в двух комнатах — пометка после списка id', () => {
      const letters = [taskOf({ id: 'm-01' }), messageOf({ id: 'm-02', roomId: 'r-02' })];
      expect(pointerText(letters, rooms)).toBe(
        'New messages (2) in r-01, r-02 (a task for everyone). Call check_inbox.',
      );
    });

    it('комнаты вместе с прямыми — пометка после «and direct»', () => {
      const letters = [taskOf({ id: 'm-01' }), messageOf({ id: 'm-02' })];
      expect(pointerText(letters, rooms)).toBe(
        'New messages (2) in r-01 and direct (a task for everyone). Call check_inbox.',
      );
    });

    it('комнаты в карте нет — пометка и после одного id', () => {
      expect(pointerText([taskOf({ roomId: 'r-09' })], rooms)).toBe(
        'New messages (1) in r-09 (a task for everyone). Call check_inbox.',
      );
    });

    it('рассылка агента без адресата и письмо человека адресату — без пометки', () => {
      const agentBroadcast = messageOf({ from: 's-02', to: [], roomId: 'r-01' });
      const addressed = taskOf({ to: ['s-01'] });
      expect(pointerText([agentBroadcast], rooms)).toBe(
        'New messages (1) in r-01 "Ревью «схемы» — ёж". Call check_inbox.',
      );
      expect(pointerText([addressed], rooms)).toBe(
        'New messages (1) in r-01 "Ревью «схемы» — ёж". Call check_inbox.',
      );
    });

    it('только прямые письма — указатель прежний', () => {
      expect(pointerText([messageOf({ from: 'human' })], rooms)).toBe('New messages (1). Call check_inbox.');
    });

    it('isPointerText узнаёт указатель с пометкой — и обрезанный oneLine', () => {
      for (const letters of [[taskOf()], [taskOf({ id: 'm-01' }), messageOf({ id: 'm-02' })]]) {
        const text = pointerText(letters, rooms);
        expect(isPointerText(text), text).toBe(true);
        expect(isPointerText(oneLine(text)), text).toBe(true);
      }
    });
  });
});

describe('isPointerText', () => {
  const rooms = [roomOf('r-01', 'Second'), roomOf('r-02', 'Ревью «схемы»')];
  const forms = [
    [messageOf()],
    [messageOf({ id: 'm-01', roomId: 'r-01' })],
    [messageOf({ id: 'm-01', roomId: 'r-02' }), messageOf({ id: 'm-02', roomId: 'r-01' })],
    [messageOf({ id: 'm-01', roomId: 'r-01' }), messageOf({ id: 'm-02' })],
    // Комнаты в карте нет — в указателе один id.
    [messageOf({ id: 'm-01', roomId: 'r-09' })],
  ];

  it('узнаёт каждую форму pointerText — и ярлык, каким его записал автозаголовок (oneLine)', () => {
    for (const letters of forms) {
      const text = pointerText(letters, rooms);
      expect(isPointerText(text), text).toBe(true);
      expect(isPointerText(oneLine(text)), text).toBe(true);
    }
    // Ярлык из карты пользователя (w-0043, сборка 0.7.0).
    expect(isPointerText('New messages (1) in r-01 "Second". Call check_inbox.')).toBe(true);
  });

  it('длинное название комнаты: oneLine обрезал хвост `Call check_inbox.` — всё равно указатель', () => {
    const text = pointerText([messageOf({ roomId: 'r-01' })], [roomOf('r-01', 'очень длинное название '.repeat(10))]);
    const cut = oneLine(text);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('check_inbox');
    expect(isPointerText(cut)).toBe(true);
  });

  it('обычные реплики и ярлыки — не указатель, даже похожие', () => {
    for (const text of [
      'бэкенд',
      'new session',
      'New messages',
      'New messages (1)',
      'New messages (1). Call check_inbox. А потом почини парсер',
      'Проверь new messages (1). Call check_inbox.',
      'New messages (1) in the inbox…',
      'Проверка входящих сообщений',
    ]) {
      expect(isPointerText(text), text).toBe(false);
    }
  });
});

describe('deliveryAction', () => {
  const base: Parameters<typeof deliveryAction>[0] = {
    session: sessionOf(),
    activity: activityOf('unseen'),
    hasDraft: false,
    paused: false,
    unread: [messageOf()],
    rooms: [],
    pointed: new Set<string>(),
    inFlight: false,
    resumeAllowed: true,
    hooked: true,
  };

  it('1. пауза — none(paused), даже если остальные условия тоже нарушены', () => {
    expect(
      deliveryAction({
        ...base,
        paused: true,
        session: sessionOf({ lifecycle: 'sleeping' }),
        hasDraft: true,
      }),
    ).toEqual({ kind: 'none', reason: 'paused' });
  });

  it('2а. нет непрочитанных — none(no-letters)', () => {
    expect(deliveryAction({ ...base, unread: [] })).toEqual({ kind: 'none', reason: 'no-letters' });
  });

  it('2б. все непрочитанные уже указаны — none(already-pointed)', () => {
    const message = messageOf({ id: 'm-01' });
    expect(
      deliveryAction({ ...base, unread: [message], pointed: new Set(['m-01']) }),
    ).toEqual({ kind: 'none', reason: 'already-pointed' });
  });

  it('2в. удалённые письма в счёт не идут', () => {
    const deleted = messageOf({ id: 'm-01', deleted: true });
    expect(deliveryAction({ ...base, unread: [deleted] })).toEqual({
      kind: 'none',
      reason: 'no-letters',
    });
  });

  it('3. pending — none(not-live): её поднимает autoLaunch, а не письмо', () => {
    expect(deliveryAction({ ...base, session: sessionOf({ lifecycle: 'pending' }) })).toEqual({
      kind: 'none',
      reason: 'not-live',
    });
  });

  it('3.4-1. closed — none(closed); sleeping поднимается письмом, сверх лимита — none(resume-limit)', () => {
    expect(deliveryAction({ ...base, session: sessionOf({ lifecycle: 'closed' }) })).toEqual({
      kind: 'none',
      reason: 'closed',
    });
    // Закрытую не поднимает и лимит: отказ раньше него.
    expect(
      deliveryAction({ ...base, session: sessionOf({ lifecycle: 'closed' }), resumeAllowed: false }),
    ).toEqual({ kind: 'none', reason: 'closed' });

    const sleeping = sessionOf({ lifecycle: 'sleeping' });
    const a = messageOf({ id: 'm-01' });
    const b = messageOf({ id: 'm-02' });
    expect(deliveryAction({ ...base, session: sleeping, unread: [a, b], activity: null })).toEqual({
      kind: 'resume',
      text: 'New messages (2). Call check_inbox.',
      letterIds: ['m-01', 'm-02'],
    });
    expect(deliveryAction({ ...base, session: sleeping, resumeAllowed: false })).toEqual({
      kind: 'none',
      reason: 'resume-limit',
    });
    // Пауза держит и подъём; уже указанные письма второй раз не поднимают.
    expect(deliveryAction({ ...base, session: sleeping, paused: true })).toEqual({
      kind: 'none',
      reason: 'paused',
    });
    expect(
      deliveryAction({ ...base, session: sleeping, unread: [a], pointed: new Set(['m-01']) }),
    ).toEqual({ kind: 'none', reason: 'already-pointed' });
  });

  it('4а. активности не известно — none(busy)', () => {
    expect(deliveryAction({ ...base, activity: null })).toEqual({ kind: 'none', reason: 'busy' });
  });

  it('4б. working или blocked — none(busy)', () => {
    expect(deliveryAction({ ...base, activity: activityOf('working') })).toEqual({
      kind: 'none',
      reason: 'busy',
    });
    expect(deliveryAction({ ...base, activity: activityOf('blocked') })).toEqual({
      kind: 'none',
      reason: 'busy',
    });
  });

  it('4в. живой процесс без единого хука с запуска — none(no-hooks), idle и unseen тоже (fix-final-b)', () => {
    // Свежая сессия на вопросе доверия к папке хуков не шлёт, и активность у неё idle:
    // указатель с Enter подтвердил бы диалог (рамка 15.1).
    expect(deliveryAction({ ...base, hooked: false })).toEqual({ kind: 'none', reason: 'no-hooks' });
    expect(deliveryAction({ ...base, hooked: false, activity: activityOf('idle') })).toEqual({
      kind: 'none',
      reason: 'no-hooks',
    });
    // Спящую поднимает новый процесс — хуки старого тут ни при чём.
    expect(
      deliveryAction({ ...base, hooked: false, session: sessionOf({ lifecycle: 'sleeping' }), activity: null }).kind,
    ).toBe('resume');
  });

  describe('queueWhileBusy — Codex принимает письмо занятому агенту в очередь (Tab)', () => {
    const queued = { ...base, queueWhileBusy: true };

    it('working → печать указателя с пометкой queue: он уйдёт в очередь, а не вмешается в ход', () => {
      expect(deliveryAction({ ...queued, activity: activityOf('working') })).toEqual({
        kind: 'type-pointer',
        text: 'New messages (1). Call check_inbox.',
        letterIds: ['m-01'],
        queue: true,
      });
    });

    it('без queueWhileBusy working по-прежнему busy: Claude ждёт конца хода', () => {
      expect(deliveryAction({ ...base, activity: activityOf('working') })).toEqual({
        kind: 'none',
        reason: 'busy',
      });
      expect(
        deliveryAction({ ...base, queueWhileBusy: false, activity: activityOf('working') }),
      ).toEqual({ kind: 'none', reason: 'busy' });
    });

    it('blocked — busy и с очередью: диалог отвечать нельзя ни Enter, ни Tab', () => {
      expect(deliveryAction({ ...queued, activity: activityOf('blocked') })).toEqual({
        kind: 'none',
        reason: 'busy',
      });
    });

    it('у приглашения (idle, unseen) пометки queue нет: письмо уходит Enter как обычно', () => {
      for (const state of ['idle', 'unseen'] as const) {
        const action = deliveryAction({ ...queued, activity: activityOf(state) });
        expect(action).toEqual({
          kind: 'type-pointer',
          text: 'New messages (1). Call check_inbox.',
          letterIds: ['m-01'],
        });
        expect(action).not.toHaveProperty('queue');
      }
    });

    it('активности не известно — busy, а не «в очередь наугад»', () => {
      expect(deliveryAction({ ...queued, activity: null })).toEqual({
        kind: 'none',
        reason: 'busy',
      });
    });

    it('остальные правила действуют: без хука, черновик человека, указатель в полёте', () => {
      const working = { ...queued, activity: activityOf('working') };
      expect(deliveryAction({ ...working, hooked: false })).toEqual({
        kind: 'none',
        reason: 'no-hooks',
      });
      expect(deliveryAction({ ...working, hasDraft: true })).toEqual({
        kind: 'none',
        reason: 'draft',
      });
      expect(deliveryAction({ ...working, inFlight: true })).toEqual({
        kind: 'none',
        reason: 'in-flight',
      });
      expect(deliveryAction({ ...working, paused: true })).toEqual({
        kind: 'none',
        reason: 'paused',
      });
      expect(deliveryAction({ ...working, pointed: new Set(['m-01']) })).toEqual({
        kind: 'none',
        reason: 'already-pointed',
      });
    });

    it('спящую очередь не касается: подъём как был', () => {
      expect(
        deliveryAction({ ...queued, session: sessionOf({ lifecycle: 'sleeping' }), activity: null })
          .kind,
      ).toBe('resume');
    });
  });

  describe('heldByBackground — лид закончил ход и ждёт фоновых субагентов (Parley 0.2.0)', () => {
    const task = {
      id: 'a1',
      agentType: 'general-purpose',
      description: 'Orca research',
      background: true,
      transcriptPath: null,
    };
    // working выставлено только удержанием фоновых: родитель стоит у приглашения и ввод принимает.
    const held = activityOf('working', { heldByBackground: true, subagents: 1, tasks: [task] });
    const lead = { ...base, activity: held };

    it('указатель печатается Enter-ом, как простаивающему: без пометки queue', () => {
      const action = deliveryAction(lead);

      expect(action).toEqual({
        kind: 'type-pointer',
        text: 'New messages (1). Call check_inbox.',
        letterIds: ['m-01'],
      });
      expect(action).not.toHaveProperty('queue');
    });

    it('остальные правила действуют: черновик, указатель в полёте, нет хуков, пауза, уже указано', () => {
      expect(deliveryAction({ ...lead, hasDraft: true })).toEqual({
        kind: 'none',
        reason: 'draft',
      });
      expect(deliveryAction({ ...lead, inFlight: true })).toEqual({
        kind: 'none',
        reason: 'in-flight',
      });
      expect(deliveryAction({ ...lead, hooked: false })).toEqual({
        kind: 'none',
        reason: 'no-hooks',
      });
      expect(deliveryAction({ ...lead, paused: true })).toEqual({ kind: 'none', reason: 'paused' });
      expect(deliveryAction({ ...lead, pointed: new Set(['m-01']) })).toEqual({
        kind: 'none',
        reason: 'already-pointed',
      });
    });

    it('в вызове wait_for — busy: агент внутри инструмента, Enter вмешался бы в ход', () => {
      const waiting = activityOf('working', { waitingFor: 's-02', tasks: [task], subagents: 1 });

      expect(deliveryAction({ ...base, activity: waiting })).toEqual({
        kind: 'none',
        reason: 'busy',
      });
    });

    it('агент работает сам, хотя фоновые идут (флага нет) — busy, как у обычной working', () => {
      const working = activityOf('working', { tasks: [task], subagents: 1 });

      expect(deliveryAction({ ...base, activity: working })).toEqual({
        kind: 'none',
        reason: 'busy',
      });
    });

    it('флаг касается только working: blocked остаётся busy', () => {
      expect(
        deliveryAction({ ...base, activity: activityOf('blocked', { heldByBackground: true }) }),
      ).toEqual({
        kind: 'none',
        reason: 'busy',
      });
    });

    it('с queueWhileBusy — всё равно Enter, а не очередь: агент у приглашения, очередь ему ни к чему', () => {
      const action = deliveryAction({ ...lead, queueWhileBusy: true });

      expect(action).toMatchObject({ kind: 'type-pointer', letterIds: ['m-01'] });
      expect(action).not.toHaveProperty('queue');
    });

    it('спящую флаг не касается: подъём как был', () => {
      expect(
        deliveryAction({ ...lead, session: sessionOf({ lifecycle: 'sleeping' }), activity: null })
          .kind,
      ).toBe('resume');
    });
  });

  it('5. черновик человека — none(draft)', () => {
    expect(deliveryAction({ ...base, hasDraft: true })).toEqual({ kind: 'none', reason: 'draft' });
  });

  it('6. указатель уже в полёте — none(in-flight)', () => {
    expect(deliveryAction({ ...base, inFlight: true })).toEqual({ kind: 'none', reason: 'in-flight' });
  });

  it('7. иначе — печать указателя со всеми id непрочитанных, unseen и idle разрешены', () => {
    const a = messageOf({ id: 'm-01' });
    const b = messageOf({ id: 'm-02' });
    expect(deliveryAction({ ...base, unread: [a, b] })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (2). Call check_inbox.',
      letterIds: ['m-01', 'm-02'],
    });
    expect(deliveryAction({ ...base, activity: activityOf('idle') })).toMatchObject({
      kind: 'type-pointer',
    });
  });
});
