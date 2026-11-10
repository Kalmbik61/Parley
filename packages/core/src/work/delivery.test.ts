import { describe, expect, it } from 'vitest';
import { activityOf as foldActivity, presentedActivity, type SessionActivity } from './activity.js';
import { bareEvent } from './events.js';
import { oneLine } from '../counters.js';
import {
  deliveryAction,
  heldWarning,
  isPointerText,
  LIMIT_RETURN_TEXT,
  limitReturnText,
  pointerText,
  SETTLE_MAX_MS,
  SETTLE_MS,
  settleDelayMs,
  wakesAtOnce,
} from './delivery.js';
import { reportLetterText } from './task-giver.js';
import type { SessionNeed } from './stuck.js';
import { HUMAN, SYSTEM, type Message, type Room, type WorkSession } from './types.js';

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
  turnBoundaryAt: null,
  lastEventAt: null,
  source: 'hooks',
  hooksMissing: false,
  need: null,
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

describe('pointerText: название, записанное в карту мимо addRoom', () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;
  const dirty = [roomOf('r-01', 'a\r\x1b[201~!rm -rf\n')];
  const letters = [messageOf({ roomId: 'r-01' })];

  it('указатель без управляющих знаков и узнаётся isPointerText', () => {
    const text = pointerText(letters, dirty);
    expect(text).not.toMatch(CONTROL_CHAR);
    expect(isPointerText(text)).toBe(true);
  });

  it('возврат после лимита тоже чистый и узнаётся isPointerText', () => {
    const text = limitReturnText(letters, dirty);
    expect(text).not.toMatch(CONTROL_CHAR);
    expect(isPointerText(text)).toBe(true);
  });

  it('название в 500 знаков: указатель не длиннее постоянной части плюс 80', () => {
    const empty = pointerText(letters, [roomOf('r-01', '')]);
    const text = pointerText(letters, [roomOf('r-01', 'я'.repeat(500))]);
    expect(Array.from(text).length).toBeLessThanOrEqual(Array.from(empty).length + 80);
    expect(isPointerText(text)).toBe(true);
  });

  it('id комнаты из повреждённой карты тоже чистится', () => {
    const text = pointerText([messageOf({ roomId: 'r-01\r!x' })], []);
    expect(text).not.toMatch(CONTROL_CHAR);
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
    // Указатель сборок до 0.33: название комнаты тогда не резалось (сейчас `pointerText` режет его до 80 знаков).
    const text = `New messages (1) in r-01 "${'очень длинное название '.repeat(10)}". Call check_inbox.`;
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

describe('limitReturnText — возврат после сброса лимита (спека «Застрявшие сессии», 6.3)', () => {
  const rooms = [roomOf('r-01', 'Second'), roomOf('r-02', 'Ревью «схемы»')];

  it('без писем — одна просьба продолжить, байт в байт', () => {
    expect(LIMIT_RETURN_TEXT).toBe(
      'Your usage limit has reset. Read your inbox first, then continue the task the limit interrupted.',
    );
    expect(limitReturnText([], rooms)).toBe(LIMIT_RETURN_TEXT);
  });

  it('с письмами — через пробел указатель на них', () => {
    const letters = [messageOf({ id: 'm-01', roomId: 'r-01' }), messageOf({ id: 'm-02', roomId: 'r-01' })];
    expect(limitReturnText(letters, rooms)).toBe(`${LIMIT_RETURN_TEXT} ${pointerText(letters, rooms)}`);
    expect(limitReturnText([messageOf()], rooms)).toBe(`${LIMIT_RETURN_TEXT} New messages (1). Call check_inbox.`);
  });

  it('isPointerText узнаёт возврат — и обрезанный oneLine, и с длинным названием комнаты', () => {
    const long = [roomOf('r-01', 'очень длинное название '.repeat(10))];
    for (const text of [
      limitReturnText([], rooms),
      limitReturnText([messageOf()], rooms),
      limitReturnText([messageOf({ roomId: 'r-02' }), messageOf({ id: 'm-02' })], rooms),
      limitReturnText([messageOf({ roomId: 'r-01' })], long),
    ]) {
      expect(isPointerText(text), text).toBe(true);
      expect(isPointerText(oneLine(text)), text).toBe(true);
    }
    expect(oneLine(limitReturnText([messageOf({ roomId: 'r-01' })], long)).endsWith('…')).toBe(true);
  });

  it('чужое после просьбы или вместо указателя — не указатель', () => {
    for (const text of [
      `${LIMIT_RETURN_TEXT} А потом почини парсер`,
      `${LIMIT_RETURN_TEXT} New messages (1). Call check_inbox. А потом почини парсер`,
      `Проверь: ${LIMIT_RETURN_TEXT}`,
      'Your usage limit has reset.',
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
    // Часы далеко после писем фикстур (`new Date()`): окно тишины давно вышло, прежние ожидания целы.
    now: Date.parse('2099-01-01T00:00:00.000Z'),
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

  it('2б-1. частичное чтение: указанные письма нового указателя не дают, новое письмо — один указатель на всё', () => {
    const ids = Array.from({ length: 70 }, (_, index) => `m-${String(index + 1).padStart(2, '0')}`);
    const unread = ids.map((id) => messageOf({ id }));
    const pointed = new Set(ids);
    expect(deliveryAction({ ...base, unread, pointed })).toEqual({ kind: 'none', reason: 'already-pointed' });
    const fresh = messageOf({ id: 'm-71' });
    expect(deliveryAction({ ...base, unread: [...unread, fresh], pointed })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (71). Call check_inbox.',
      letterIds: [...ids, 'm-71'],
    });
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

  describe('need — сессия ждёт человека или сброса лимита (спека «Застрявшие сессии», 6.1)', () => {
    const needOf = (kind: SessionNeed['kind'], patch: Partial<SessionNeed> = {}): SessionNeed => ({
      kind,
      since: '2026-10-12T10:00:00.000Z',
      detail: null,
      resetsAt: null,
      window: null,
      account: null,
      ...patch,
    });
    const limit = needOf('limit', {
      detail: "You've hit your limit",
      resetsAt: '2026-10-12T19:27:00.000Z',
      window: 'session',
    });
    const stuck = { kind: 'none', reason: 'stuck' } as const;

    it('unseen и idle с need limit и письмом — none(stuck); тот же снимок без need — указатель', () => {
      for (const state of ['unseen', 'idle'] as const) {
        expect(deliveryAction({ ...base, activity: activityOf(state, { need: limit }) }), state).toEqual(stuck);
        expect(deliveryAction({ ...base, activity: activityOf(state, { need: null }) }), state).toEqual({
          kind: 'type-pointer',
          text: 'New messages (1). Call check_inbox.',
          letterIds: ['m-01'],
        });
      }
    });

    it('любой вид need держит письма: одобрение и вопрос у blocked раньше были busy, экран старта — no-hooks', () => {
      for (const kind of ['approval', 'question'] as const) {
        expect(deliveryAction({ ...base, activity: activityOf('blocked', { need: needOf(kind) }) }), kind).toEqual(stuck);
      }
      // Экран старта: хуков с запуска ещё нет, но «застрял» точнее, чем «нет хуков».
      expect(
        deliveryAction({ ...base, hooked: false, activity: activityOf('blocked', { need: needOf('startup') }) }),
      ).toEqual(stuck);
      expect(
        deliveryAction({ ...base, activity: activityOf('idle', { need: needOf('sign-in', { account: 'auth' }) }) }),
      ).toEqual(stuck);
    });

    it('need — только у живой сессии: пауза, закрытая, pending и отсутствие писем отвечают по-прежнему, черновик и указатель в полёте уступают ему', () => {
      const waiting = { ...base, activity: activityOf('unseen', { need: limit }) };

      expect(deliveryAction({ ...waiting, paused: true })).toEqual({ kind: 'none', reason: 'paused' });
      expect(deliveryAction({ ...waiting, session: sessionOf({ lifecycle: 'closed' }) })).toEqual({
        kind: 'none',
        reason: 'closed',
      });
      expect(deliveryAction({ ...waiting, unread: [] })).toEqual({ kind: 'none', reason: 'no-letters' });
      expect(deliveryAction({ ...waiting, session: sessionOf({ lifecycle: 'pending' }) })).toEqual({
        kind: 'none',
        reason: 'not-live',
      });

      expect(deliveryAction({ ...waiting, hasDraft: true })).toEqual(stuck);
      expect(deliveryAction({ ...waiting, inFlight: true })).toEqual(stuck);
    });

    it('указатель на все письма уже напечатан, а сессия застряла — none(stuck), а не already-pointed; без need — как раньше', () => {
      // Человек должен видеть, что сессия застряла, и когда указатель был напечатан ещё до этого.
      const pointed = new Set(['m-01']);

      expect(deliveryAction({ ...base, pointed, activity: activityOf('unseen', { need: limit }) })).toEqual(stuck);
      expect(deliveryAction({ ...base, pointed, activity: activityOf('unseen', { need: null }) })).toEqual({
        kind: 'none',
        reason: 'already-pointed',
      });
    });

    it('спящую need не держит: пришёл старый снимок — письмо по-прежнему поднимает её, сверх лимита — resume-limit', () => {
      const sleeping = sessionOf({ lifecycle: 'sleeping' });
      const old = activityOf('unseen', { need: limit });

      expect(deliveryAction({ ...base, session: sleeping, activity: old })).toEqual({
        kind: 'resume',
        text: 'New messages (1). Call check_inbox.',
        letterIds: ['m-01'],
      });
      expect(deliveryAction({ ...base, session: sleeping, activity: old, resumeAllowed: false })).toEqual({
        kind: 'none',
        reason: 'resume-limit',
      });
    });
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

  it('10. тишина открытого хода (false-done): письмо печатается по сырому значению, показанное — busy', () => {
    // Настоящая свёртка: `UserPromptSubmit`, последняя запись +5 с, сейчас +45 с, `Stop` не приходил.
    const at = (s: number): string => new Date(Date.parse('2026-09-05T10:00:00.000Z') + s * 1000).toISOString();
    const raw = foldActivity({
      events: [bareEvent(at(0), 'UserPromptSubmit')],
      log: { lastRecordAt: at(5), lastUserRecordAt: null },
      now: Date.parse(at(45)),
      silenceThresholdMs: 30_000,
    });
    expect(raw.quietTurn).toBe(true);
    expect(deliveryAction({ ...base, activity: raw })).toMatchObject({ kind: 'type-pointer' });
    // Клиентам тот же ход показан как идущий: на доставку это не влияет, она читает сырое значение.
    expect(deliveryAction({ ...base, activity: presentedActivity(raw) })).toEqual({ kind: 'none', reason: 'busy' });
  });
});

describe('wakesAtOnce — срочность письма для получателя s-02', () => {
  // Заметка всем в комнате: от агента, без адресата, без упоминания.
  const broadcast = (patch: Partial<Message> = {}): Message =>
    messageOf({ from: 's-01', to: [], roomId: 'r-01', kind: 'note', text: 'got it, starting', ...patch });

  it('письмо человека — сразу, даже заметкой всем', () => {
    expect(wakesAtOnce(broadcast({ from: HUMAN }), 's-02')).toBe(true);
  });

  it('адресное письмо (to не пусто) — сразу', () => {
    expect(wakesAtOnce(broadcast({ to: ['s-02'] }), 's-02')).toBe(true);
  });

  it('question и decision — сразу', () => {
    expect(wakesAtOnce(broadcast({ kind: 'question' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ kind: 'decision' }), 's-02')).toBe(true);
  });

  it('заметка с упоминанием получателя — сразу', () => {
    expect(wakesAtOnce(broadcast({ text: '@s02 take the schema' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'thanks, @s02, done' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'ping (@s02)' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'ping @S02.' }), 's-02')).toBe(true);
  });

  it('упоминание в форме id (@s-02) тоже будит s-02, с любым регистром и границами', () => {
    expect(wakesAtOnce(broadcast({ text: '@s-02 take the schema' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'thanks, @s-02, done' }), 's-02')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'ping (@S-02).' }), 's-02')).toBe(true);
  });

  it('@s-020 и @s020 не будят s-02; @s-02 внутри слова и адреса — тоже нет', () => {
    expect(wakesAtOnce(broadcast({ text: '@s-020 take the schema' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: '@s020 take the schema' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: 'a@s-02' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: '@@s-02' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: '@s-03 take the schema' }), 's-02')).toBe(false);
  });

  it('заметка всем без упоминания — не сразу', () => {
    expect(wakesAtOnce(broadcast(), 's-02')).toBe(false);
  });

  it('упоминание другого — не сразу; @s020 для s-02 — тоже', () => {
    expect(wakesAtOnce(broadcast({ text: '@s03 take the schema' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: '@s020 take the schema' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: 'see @s0200' }), 's-02')).toBe(false);
  });

  it('@s02 внутри слова и адреса (a@s02, mail@s02.org) — не упоминание, как у plainHumanMention', () => {
    expect(wakesAtOnce(broadcast({ text: 'a@s02' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: 'write to mail@s02.org' }), 's-02')).toBe(false);
    expect(wakesAtOnce(broadcast({ text: '@@s02' }), 's-02')).toBe(false);
  });

  it('чужая форма id упоминается как есть и экранируется для регулярного выражения', () => {
    expect(wakesAtOnce(broadcast({ text: 'ping @a.b+c' }), 'a.b+c')).toBe(true);
    expect(wakesAtOnce(broadcast({ text: 'ping @axb+c' }), 'a.b+c')).toBe(false);
  });
});

describe('settleDelayMs — сколько ещё ждать тишины', () => {
  const T0 = Date.parse('2026-10-27T10:00:00.000Z');
  const note = (id: string, offsetMs: number, patch: Partial<Message> = {}): Message =>
    messageOf({
      id,
      from: 's-01',
      to: [],
      roomId: 'r-01',
      text: 'got it, starting',
      at: new Date(T0 + offsetMs).toISOString(),
      ...patch,
    });

  it('одна заметка всем: в её момент — SETTLE_MS, по ходу убывает, через SETTLE_MS — 0', () => {
    expect(SETTLE_MS).toBe(30_000);
    expect(SETTLE_MAX_MS).toBe(120_000);
    expect(settleDelayMs([note('m-01', 0)], 's-02', T0)).toBe(30_000);
    expect(settleDelayMs([note('m-01', 0)], 's-02', T0 + 10_000)).toBe(20_000);
    expect(settleDelayMs([note('m-01', 0)], 's-02', T0 + 30_000)).toBe(0);
    expect(settleDelayMs([note('m-01', 0)], 's-02', T0 + 90_000)).toBe(0);
  });

  it('заметки каждые 20 с сдвигают срок, но не дальше SETTLE_MAX_MS от первой', () => {
    const chatter = [0, 20_000, 40_000, 60_000, 80_000, 100_000].map((offset, index) => note(`m-0${index + 1}`, offset));
    // Последняя заметка в 100 с: 100 + 30 = 130 с, потолок 0 + 120 = 120 с.
    expect(settleDelayMs(chatter, 's-02', T0 + 100_000)).toBe(20_000);
    expect(settleDelayMs(chatter, 's-02', T0 + 110_000)).toBe(10_000);
    expect(settleDelayMs(chatter, 's-02', T0 + 120_000)).toBe(0);
    // Пока потолок далёк, решает самая новая: заметки 0..40 с, сейчас 50 с → 40 + 30 − 50.
    expect(settleDelayMs(chatter.slice(0, 3), 's-02', T0 + 50_000)).toBe(20_000);
  });

  it('срочное письмо среди заметок — 0', () => {
    const letters = [note('m-01', 0), note('m-02', 5_000, { kind: 'question' }), note('m-03', 10_000)];
    expect(settleDelayMs(letters, 's-02', T0 + 10_000)).toBe(0);
    expect(settleDelayMs([note('m-01', 0), note('m-02', 5_000, { text: '@s02 look' })], 's-02', T0 + 5_000)).toBe(0);
  });

  it('писем нет — 0', () => {
    expect(settleDelayMs([], 's-02', T0)).toBe(0);
  });

  it('нечитаемый at не задерживает доставку — 0', () => {
    expect(settleDelayMs([note('m-01', 0, { at: 'not-a-date' })], 's-02', T0)).toBe(0);
    expect(settleDelayMs([note('m-01', 0), note('m-02', 0, { at: '' })], 's-02', T0)).toBe(0);
  });

  it('заметка с at на 10 минут вперёд — 0: ждать тишины от метки из будущего нечего', () => {
    expect(settleDelayMs([note('m-01', 600_000)], 's-02', T0)).toBe(0);
    expect(settleDelayMs([note('m-01', 0), note('m-02', 600_000)], 's-02', T0)).toBe(0);
    // Далёкое будущее не должно дать срок за 2^31−1 мс.
    expect(settleDelayMs([note('m-01', 0, { at: '9999-12-31T00:00:00.000Z' })], 's-02', T0)).toBe(0);
  });

  it('заметка с at на 1 с вперёд — около SETTLE_MS + 1 с, но не выше потолка', () => {
    expect(settleDelayMs([note('m-01', 1_000)], 's-02', T0)).toBe(SETTLE_MS + 1_000);
    // Метка на 1 с вперёд при settleMs 10 с, settleMaxMs 5 с: min(11 с, 6 с) = 6 с, а потолок — 5 с.
    expect(settleDelayMs([note('m-01', 1_000)], 's-02', T0, 10_000, 5_000)).toBe(5_000);
    expect(settleDelayMs([note('m-01', 1_000)], 's-02', T0)).toBeLessThanOrEqual(SETTLE_MAX_MS);
  });

  it('settleMs и settleMaxMs можно задать', () => {
    expect(settleDelayMs([note('m-01', 0)], 's-02', T0, 1_000, 5_000)).toBe(1_000);
    const letters = [note('m-01', 0), note('m-02', 4_000)];
    // 4 + 1 = 5 с против потолка 0 + 5 = 5 с.
    expect(settleDelayMs(letters, 's-02', T0 + 4_000, 1_000, 5_000)).toBe(1_000);
    expect(settleDelayMs(letters, 's-02', T0 + 4_500, 10_000, 5_000)).toBe(500);
  });
});

describe('deliveryAction — окно тишины (план «меньше ходов», C1.2)', () => {
  const T0 = Date.parse('2026-10-27T10:00:00.000Z');
  const note = (id: string, offsetMs: number, patch: Partial<Message> = {}): Message =>
    messageOf({
      id,
      from: 's-02',
      to: [],
      roomId: 'r-01',
      text: 'got it, starting',
      at: new Date(T0 + offsetMs).toISOString(),
      ...patch,
    });
  const idle: Parameters<typeof deliveryAction>[0] = {
    session: sessionOf(),
    activity: activityOf('idle'),
    hasDraft: false,
    paused: false,
    unread: [note('m-01', 0)],
    rooms: [],
    pointed: new Set<string>(),
    inFlight: false,
    resumeAllowed: true,
    hooked: true,
    now: T0,
  };
  const sleeping = { ...idle, session: sessionOf({ lifecycle: 'sleeping' }), activity: null };

  it('простаивающая сессия и одна заметка всем: settling на SETTLE_MS, через SETTLE_MS — указатель', () => {
    expect(deliveryAction(idle)).toEqual({ kind: 'none', reason: 'settling', retryInMs: 30_000 });
    expect(deliveryAction({ ...idle, now: T0 + 12_000 })).toEqual({ kind: 'none', reason: 'settling', retryInMs: 18_000 });
    expect(deliveryAction({ ...idle, now: T0 + 30_000 })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (1) in r-01. Call check_inbox.',
      letterIds: ['m-01'],
    });
  });

  it('пачка заметок: указатель на все после тишины, срок — от самой новой', () => {
    const unread = [note('m-01', 0), note('m-02', 10_000)];
    expect(deliveryAction({ ...idle, unread, now: T0 + 30_000 })).toEqual({
      kind: 'none',
      reason: 'settling',
      retryInMs: 10_000,
    });
    expect(deliveryAction({ ...idle, unread, now: T0 + 40_000 })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (2) in r-01. Call check_inbox.',
      letterIds: ['m-01', 'm-02'],
    });
  });

  it('срочное письмо среди заметок будит сразу и забирает пачку с собой', () => {
    const unread = [note('m-01', 0), note('m-02', 2_000, { kind: 'question' }), note('m-03', 4_000)];
    expect(deliveryAction({ ...idle, unread, now: T0 + 4_000 })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (3) in r-01. Call check_inbox.',
      letterIds: ['m-01', 'm-02', 'm-03'],
    });
    // Упоминание получателя и письмо человека — то же.
    const mention = [note('m-01', 0), note('m-02', 1_000, { text: 'hey @s01' })];
    expect(deliveryAction({ ...idle, unread: mention, now: T0 + 1_000 }).kind).toBe('type-pointer');
    const human = [note('m-01', 0), note('m-02', 1_000, { from: HUMAN })];
    expect(deliveryAction({ ...idle, unread: human, now: T0 + 1_000 }).kind).toBe('type-pointer');
  });

  it('болтовня каждые 20 с: указатель не позже SETTLE_MAX_MS от первой заметки', () => {
    const unread = [0, 20_000, 40_000, 60_000, 80_000, 100_000].map((offset, index) => note(`m-0${index + 1}`, offset));
    expect(deliveryAction({ ...idle, unread, now: T0 + 100_000 })).toEqual({
      kind: 'none',
      reason: 'settling',
      retryInMs: 20_000,
    });
    expect(deliveryAction({ ...idle, unread, now: T0 + SETTLE_MAX_MS })).toMatchObject({
      kind: 'type-pointer',
      letterIds: ['m-01', 'm-02', 'm-03', 'm-04', 'm-05', 'm-06'],
    });
  });

  it('срок считается по ещё не указанным письмам, а текст указателя — по всем непрочитанным', () => {
    const unread = [note('m-01', 0), note('m-02', 100_000)];
    const pointed = new Set(['m-01']);
    // Свежая одна, в 100 с: 100 + 30 − 110 = 20 с (по всем решал бы потолок первой — 10 с).
    expect(deliveryAction({ ...idle, unread, pointed, now: T0 + 110_000 })).toEqual({
      kind: 'none',
      reason: 'settling',
      retryInMs: 20_000,
    });
    expect(deliveryAction({ ...idle, unread, pointed, now: T0 + 130_000 })).toEqual({
      kind: 'type-pointer',
      text: 'New messages (2) in r-01. Call check_inbox.',
      letterIds: ['m-01', 'm-02'],
    });
  });

  it('settleMs и settleMaxMs из входа', () => {
    expect(deliveryAction({ ...idle, settleMs: 2_000 })).toEqual({ kind: 'none', reason: 'settling', retryInMs: 2_000 });
    expect(deliveryAction({ ...idle, settleMs: 2_000, now: T0 + 2_000 }).kind).toBe('type-pointer');
  });

  it('спящая сессия и одна заметка: сначала settling, потом resume; лимит подъёмов раньше окна', () => {
    expect(deliveryAction(sleeping)).toEqual({ kind: 'none', reason: 'settling', retryInMs: 30_000 });
    expect(deliveryAction({ ...sleeping, now: T0 + 30_000 })).toEqual({
      kind: 'resume',
      text: 'New messages (1) in r-01. Call check_inbox.',
      letterIds: ['m-01'],
    });
    expect(deliveryAction({ ...sleeping, resumeAllowed: false })).toEqual({ kind: 'none', reason: 'resume-limit' });
  });

  it('спящая сессия и срочное письмо: resume сразу', () => {
    const unread = [note('m-01', 0), note('m-02', 1_000, { to: ['s-01'] })];
    expect(deliveryAction({ ...sleeping, unread, now: T0 + 1_000 })).toMatchObject({
      kind: 'resume',
      letterIds: ['m-01', 'm-02'],
    });
  });

  it('прежние причины и их порядок не меняются: окно тишины — после них', () => {
    expect(deliveryAction({ ...idle, activity: activityOf('working') })).toEqual({ kind: 'none', reason: 'busy' });
    expect(deliveryAction({ ...idle, activity: null })).toEqual({ kind: 'none', reason: 'busy' });
    expect(deliveryAction({ ...idle, paused: true })).toEqual({ kind: 'none', reason: 'paused' });
    expect(deliveryAction({ ...idle, session: sessionOf({ lifecycle: 'closed' }) })).toEqual({
      kind: 'none',
      reason: 'closed',
    });
    expect(deliveryAction({ ...idle, session: sessionOf({ lifecycle: 'pending' }) })).toEqual({
      kind: 'none',
      reason: 'not-live',
    });
    expect(deliveryAction({ ...idle, hooked: false })).toEqual({ kind: 'none', reason: 'no-hooks' });
    expect(deliveryAction({ ...idle, hasDraft: true })).toEqual({ kind: 'none', reason: 'draft' });
    expect(deliveryAction({ ...idle, inFlight: true })).toEqual({ kind: 'none', reason: 'in-flight' });
    expect(deliveryAction({ ...idle, pointed: new Set(['m-01']) })).toEqual({
      kind: 'none',
      reason: 'already-pointed',
    });
    expect(deliveryAction({ ...idle, unread: [] })).toEqual({ kind: 'none', reason: 'no-letters' });
    const need: SessionNeed = {
      kind: 'question',
      since: new Date(T0).toISOString(),
      detail: null,
      resetsAt: null,
      window: null,
      account: null,
    };
    expect(deliveryAction({ ...idle, activity: activityOf('idle', { need }) })).toEqual({
      kind: 'none',
      reason: 'stuck',
    });
  });

  it('Codex: заметка занятому агенту тоже ждёт тишины, срочная идёт в очередь сразу', () => {
    const codex = { ...idle, activity: activityOf('working'), queueWhileBusy: true };
    expect(deliveryAction(codex)).toEqual({ kind: 'none', reason: 'settling', retryInMs: 30_000 });
    expect(deliveryAction({ ...codex, now: T0 + 30_000 })).toMatchObject({ kind: 'type-pointer', queue: true });
    expect(deliveryAction({ ...codex, unread: [note('m-01', 0, { kind: 'question' })] })).toMatchObject({
      kind: 'type-pointer',
      queue: true,
    });
  });
});

describe('письмо-обновление итога — не срочное', () => {
  const T0 = Date.parse('2026-10-27T10:00:00.000Z');
  const report = (update: boolean): Message =>
    messageOf({ id: 'm-01', from: SYSTEM, to: ['s-02'], roomId: null, kind: 'note', at: new Date(T0).toISOString(),
      text: reportLetterText('s-03', 'done', 'Ready', update ? { rooms: ['r-01'], update: true } : { rooms: ['r-01'] }) });
  const idle: Parameters<typeof deliveryAction>[0] = {
    session: sessionOf({ id: 's-02' }),
    activity: activityOf('idle'),
    hasDraft: false,
    paused: false,
    unread: [report(true)],
    rooms: [],
    pointed: new Set<string>(),
    inFlight: false,
    resumeAllowed: true,
    hooked: true,
    now: T0,
  };

  it('wakesAtOnce: обновление — нет, обычное письмо о сдаче — да', () => {
    expect(wakesAtOnce(report(true), 's-02')).toBe(false);
    expect(wakesAtOnce(report(false), 's-02')).toBe(true);
  });

  it('settleDelayMs: обновление ждёт SETTLE_MS', () => {
    expect(settleDelayMs([report(true)], 's-02', T0)).toBe(SETTLE_MS);
  });

  it('deliveryAction: одно обновление — settling, с обычным письмом о сдаче — указатель', () => {
    expect(deliveryAction(idle)).toEqual({ kind: 'none', reason: 'settling', retryInMs: SETTLE_MS });
    const regular = { ...report(false), id: 'm-02' };
    expect(deliveryAction({ ...idle, unread: [report(true), regular] }).kind).toBe('type-pointer');
  });
});

describe('heldWarning — send_message предупреждает об адресате, которого письмо не поднимет', () => {
  const asleep = (patch: Partial<WorkSession> = {}): WorkSession =>
    sessionOf({ id: 's-02', lifecycle: 'sleeping', providerSessionId: 'p-1', ...patch });

  it('wakeBlocked: предупреждение с причиной', () => {
    const blocked = sessionOf({ id: 's-02', wakeBlocked: { since: '2026-11-10T10:00:00.000Z', reason: 'role-provider-mismatch' } });
    expect(heldWarning(blocked, 0, 6)).toBe('@s02 cannot be woken (role-provider-mismatch): it reads this when the human resumes it');
  });

  it('wakeBlocked идёт раньше прочих: спящая без id и с исчерпанным часом всё равно называет причину', () => {
    const blocked = asleep({ providerSessionId: null, wakeBlocked: { since: '2026-11-10T10:00:00.000Z', reason: 'x' } });
    expect(heldWarning(blocked, 6, 6)).toBe('@s02 cannot be woken (x): it reads this when the human resumes it');
  });

  it('спит без providerSessionId и без прежних агентов: поднимать нечем', () => {
    expect(heldWarning(asleep({ providerSessionId: null }), 0, 6)).toBe(
      '@s02 is asleep with no conversation to resume: it reads this when the human starts it',
    );
  });

  it('спит без providerSessionId, но после замены агента: будильник её поднимает — предупреждения нет', () => {
    const switched = asleep({ providerSessionId: null, previousAgents: [{ provider: 'codex' } as NonNullable<WorkSession['previousAgents']>[number]] });
    expect(heldWarning(switched, 0, 6)).toBeNull();
  });

  it('спит не по решению хоста, час подъёмов исчерпан: предупреждение о лимите', () => {
    expect(heldWarning(asleep(), 6, 6)).toBe(
      '@s02 reached its hourly resume limit: it reads this when the limit frees or the human resumes it',
    );
  });

  it('ровно resumeRate - 1 подъёмов: предупреждения нет', () => {
    expect(heldWarning(asleep(), 5, 6)).toBeNull();
  });

  it('усыплённая хостом: при исчерпанном часе то же предупреждение, ниже лимита — нет', () => {
    const slept = asleep({ autoSleep: { reason: 'idle', at: '2026-11-10T10:00:00.000Z', waitTarget: null } });
    expect(heldWarning(slept, 6, 6)).toBe(
      '@s02 reached its hourly resume limit: it reads this when the limit frees or the human resumes it',
    );
    expect(heldWarning(slept, 5, 6)).toBeNull();
  });

  it('живая и ожидающая сессия: предупреждения нет', () => {
    expect(heldWarning(sessionOf({ id: 's-02', lifecycle: 'active' }), 99, 6)).toBeNull();
    expect(heldWarning(sessionOf({ id: 's-02', lifecycle: 'pending' }), 99, 6)).toBeNull();
  });
});
