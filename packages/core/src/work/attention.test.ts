import { describe, expect, it } from 'vitest';
import {
  ATTENTION_RANK,
  humanUnreadLetters,
  humanDecisionOutcome,
  humanUnreadMentions,
  needsYouCount,
  needsYouItems,
  needsYouWorkOfMap,
  isHumanMention,
  isHumanUnread,
  plainHumanMention,
  roomAwaitsDecision,
  sessionAttention,
  sessionNeed,
} from './attention.js';
import type { SessionActivity } from './activity.js';
import { ACCEPTED_LETTER, RETURNED_LETTER } from './proposals.js';
import type { SessionNeed } from './stuck.js';
import type { Message, Room, WindowWorkMap, WorkMap, WorkSession } from './types.js';

const session = (lifecycle: string): WorkSession => ({ id: 's1', lifecycle }) as unknown as WorkSession;
const live = (activity: string, need?: SessionNeed | null): SessionActivity =>
  ({ activity, ...(need === undefined ? {} : { need }) }) as unknown as SessionActivity;
const limitNeed: SessionNeed = { kind: 'limit', since: '2026-10-21T10:00:00.000Z', detail: null, resetsAt: null, window: null, account: null };

function message(over: Partial<Message> & { id: string }): Message {
  return {
    roomId: null,
    from: 's1',
    to: ['human'],
    at: '2026-10-20T10:00:00.000Z',
    text: 'hi',
    kind: 'note',
    readBy: {},
    ...over,
  } as unknown as Message;
}

const room = (over: Record<string, unknown>): Room => ({ id: 'r1', members: [], ...over }) as unknown as Room;
const mapOf = (messages: Message[], rooms: Room[] = []): WorkMap => ({ messages, rooms }) as unknown as WorkMap;
const anyMention = (text: string): boolean => text.includes('@human');

describe('sessionAttention', () => {
  it('закрытая сессия — off', () => {
    expect(sessionAttention(session('closed'), live('blocked'))).toBe('off');
  });

  it('не active (pending, sleeping) — idle', () => {
    expect(sessionAttention(session('sleeping'), live('blocked'))).toBe('idle');
    expect(sessionAttention(session('pending'), null)).toBe('idle');
  });

  it('active: blocked — needs-you, unseen, working, прочее и без activity — idle', () => {
    expect(sessionAttention(session('active'), live('blocked'))).toBe('needs-you');
    expect(sessionAttention(session('active'), live('unseen'))).toBe('unseen');
    expect(sessionAttention(session('active'), live('working'))).toBe('working');
    expect(sessionAttention(session('active'), null)).toBe('idle');
  });

  it('ранги упорядочены от off к needs-you', () => {
    expect(ATTENTION_RANK['needs-you']).toBeGreaterThan(ATTENTION_RANK.unseen);
    expect(ATTENTION_RANK.idle).toBeGreaterThan(ATTENTION_RANK.off);
  });

  // Спека застрявших 7.3: `need` — «нужен ты» до разбора activity; лимит и вход оставляют ход законченным (3.1).
  it('живая сессия с need — needs-you при любой activity', () => {
    for (const activity of ['working', 'unseen', 'idle', 'blocked']) {
      expect(sessionAttention(session('active'), live(activity, limitNeed))).toBe('needs-you');
    }
  });

  it('need у спящей — idle, у закрытой — off, у ожидающей запуска — idle: процесса нет, ждать человека некому', () => {
    expect(sessionAttention(session('sleeping'), live('idle', limitNeed))).toBe('idle');
    expect(sessionAttention(session('pending'), live('idle', limitNeed))).toBe('idle');
    expect(sessionAttention(session('closed'), live('idle', limitNeed))).toBe('off');
  });

  it('need: null и хост прежней версии без поля — как раньше (спека застрявших 8, п. 10)', () => {
    expect(sessionAttention(session('active'), live('unseen', null))).toBe('unseen');
    expect(sessionAttention(session('active'), live('unseen'))).toBe('unseen');
  });
});

describe('sessionNeed', () => {
  it('need живой сессии — как есть; без need, без activity и у хоста прежней версии — null', () => {
    expect(sessionNeed(session('active'), live('idle', limitNeed))).toBe(limitNeed);
    expect(sessionNeed(session('active'), live('idle', null))).toBeNull();
    expect(sessionNeed(session('active'), live('idle'))).toBeNull();
    expect(sessionNeed(session('active'), null)).toBeNull();
  });

  it('у спящей, ожидающей запуска и закрытой — null, даже если запись активности осталась', () => {
    for (const lifecycle of ['sleeping', 'pending', 'closed']) {
      expect(sessionNeed(session(lifecycle), live('idle', limitNeed))).toBeNull();
    }
  });
});

describe('roomAwaitsDecision', () => {
  it('открытая комната с proposal ждёт решения', () => {
    expect(roomAwaitsDecision(room({ proposal: { text: 'x' } }))).toBe(true);
  });

  it('комната без proposal не ждёт', () => {
    expect(roomAwaitsDecision(room({}))).toBe(false);
    expect(roomAwaitsDecision(room({ proposal: null }))).toBe(false);
  });

  it('архивная комната с proposal не ждёт', () => {
    expect(roomAwaitsDecision(room({ proposal: { text: 'x' }, archivedAt: '2026-10-20T09:00:00.000Z' }))).toBe(false);
  });
});

describe('isHumanUnread и письма', () => {
  it('письмо человеку без readBy.human не прочитано', () => {
    expect(isHumanUnread(message({ id: 'm1' }))).toBe(true);
  });

  it('письмо от human не unread', () => {
    expect(isHumanUnread(message({ id: 'm1', from: 'human' }))).toBe(false);
  });

  it('прочитанное и чужое письмо не unread', () => {
    expect(isHumanUnread(message({ id: 'm1', readBy: { human: '2026-10-20T10:01:00.000Z' } }))).toBe(false);
    expect(isHumanUnread(message({ id: 'm2', to: ['s2'] }))).toBe(false);
  });

  it('сообщение комнаты unread и без адресата human', () => {
    expect(isHumanUnread(message({ id: 'm1', roomId: 'r1', to: [] }))).toBe(true);
  });

  it('humanUnreadLetters берёт только письма без комнаты', () => {
    const map = mapOf([message({ id: 'a' }), message({ id: 'b', roomId: 'r1' })]);
    expect(humanUnreadLetters(map).map((m) => m.id)).toEqual(['a']);
  });
});

describe('упоминания', () => {
  it('isHumanMention: нужна комната, автор не human и не system, и совпадение hasMention', () => {
    const base = { id: 'm1', roomId: 'r1', text: 'ping @human' };
    expect(isHumanMention(message(base), anyMention)).toBe(true);
    expect(isHumanMention(message({ ...base, roomId: null }), anyMention)).toBe(false);
    expect(isHumanMention(message({ ...base, from: 'human' }), anyMention)).toBe(false);
    expect(isHumanMention(message({ ...base, from: 'system' }), anyMention)).toBe(false);
    expect(isHumanMention(message({ ...base, text: 'no' }), anyMention)).toBe(false);
  });

  it('humanUnreadMentions пропускает прочитанные и архивные комнаты', () => {
    const map = mapOf(
      [
        message({ id: 'a', roomId: 'r1', text: '@human' }),
        message({ id: 'b', roomId: 'r1', text: '@human', readBy: { human: 'x' } }),
        message({ id: 'c', roomId: 'r2', text: '@human' }),
      ],
      [room({ id: 'r1' }), room({ id: 'r2', archivedAt: '2026-10-20T09:00:00.000Z' })],
    );
    expect(humanUnreadMentions(map, anyMention).map((m) => m.id)).toEqual(['a']);
  });
});

describe('plainHumanMention', () => {
  it('@human посреди текста и в начале — упоминание', () => {
    expect(plainHumanMention('ping @human please')).toBe(true);
    expect(plainHumanMention('@human')).toBe(true);
  });

  it('адрес почты и слово длиннее — не упоминание', () => {
    expect(plainHumanMention('mail@humanity.org')).toBe(false);
    expect(plainHumanMention('@humanoid')).toBe(false);
  });
});

describe('humanDecisionOutcome', () => {
  it('"Decision accepted." — accepted, "Returned for rework…" с заметкой и без — returned, прочее — null', () => {
    expect(humanDecisionOutcome('Decision accepted.')).toBe('accepted');
    expect(humanDecisionOutcome('Returned for rework.')).toBe('returned');
    expect(humanDecisionOutcome('Returned for rework: add tests')).toBe('returned');
    expect(humanDecisionOutcome('просто слова')).toBeNull();
    expect(humanDecisionOutcome('Completion accepted.')).toBeNull();
    // Принятие — только полное слово письма, возврат — его начало, как у окна.
    expect(humanDecisionOutcome('Decision accepted. Thanks!')).toBeNull();
    expect(humanDecisionOutcome('Please: Returned for rework')).toBeNull();
    expect(humanDecisionOutcome('')).toBeNull();
  });

  it('слова те же, что пишет resolveProposal: ACCEPTED_LETTER и RETURNED_LETTER из proposals.ts', () => {
    expect(humanDecisionOutcome(ACCEPTED_LETTER)).toBe('accepted');
    expect(humanDecisionOutcome(`${RETURNED_LETTER}.`)).toBe('returned');
    expect(humanDecisionOutcome(`${RETURNED_LETTER}: заметка`)).toBe('returned');
  });
});

describe('needsYouItems / needsYouCount (спека мобильного приложения 9.2)', () => {
  const need = limitNeed;
  const sessions = [
    { id: 's-blocked', lifecycle: 'active' },
    { id: 's-limit', lifecycle: 'active' },
    { id: 's-working', lifecycle: 'active' },
    { id: 's-closed', lifecycle: 'closed' },
    { id: 's-sleeping', lifecycle: 'sleeping' },
  ] as unknown as WorkSession[];
  const lives: Record<string, SessionActivity> = {
    's-blocked': live('blocked'),
    's-limit': live('unseen', need),
    's-working': live('working'),
    's-closed': live('blocked'),
    's-sleeping': live('blocked', need),
  };
  const messages = [
    message({ id: 'm-01' }), // прямое письмо человеку
    message({ id: 'm-02', roomId: 'r-1', text: 'ping @human', to: [] }), // упоминание в комнате — не считается
    message({ id: 'm-03', readBy: { human: 'x' } }), // прочитано
  ];
  const rooms = [
    room({ id: 'r-1', proposal: { id: 'p-1', rev: 2 } }),
    room({ id: 'r-2', proposal: { id: 'p-2', rev: 0 }, archivedAt: '2026-10-01T00:00:00Z' }),
    room({ id: 'r-3', proposal: null }),
  ];
  const map = { work: { id: 'w-1', status: 'active' }, sessions, rooms, messages } as unknown as WindowWorkMap;
  const activityOf = (_p: string, _w: string, id: string) => lives[id] ?? null;

  it('счёт равен сумме предикатов окна на тех же данных', () => {
    const works = [needsYouWorkOfMap('/p', map)];
    const bySessions = sessions.filter((x) => sessionAttention(x, lives[x.id] ?? null) === 'needs-you').length;
    const byRooms = rooms.filter(roomAwaitsDecision).length;
    const byLetters = humanUnreadLetters(map).length;
    expect([bySessions, byRooms, byLetters]).toEqual([2, 1, 1]);
    expect(needsYouCount(works, activityOf)).toBe(bySessions + byRooms + byLetters);
  });

  it('пункты: сессии и решения по одному, письма — одним пунктом на работу; ключи без номера входа', () => {
    const items = needsYouItems([needsYouWorkOfMap('/p', map)], activityOf);
    expect(items.map((i) => i.key)).toEqual([
      'session:/p\u0000w-1\u0000s-blocked',
      'session:/p\u0000w-1\u0000s-limit',
      'room:/p\u0000w-1\u0000r-1:p-1:2',
      'letters:/p\u0000w-1',
    ]);
    expect(items.at(-1)).toMatchObject({ kind: 'letters', unread: 1 });
  });

  it('новый rev решения даёт другой ключ при том же счёте', () => {
    const bump = { ...map, rooms: [room({ id: 'r-1', proposal: { id: 'p-1', rev: 3 } })] } as unknown as WindowWorkMap;
    const a = needsYouItems([needsYouWorkOfMap('/p', map)], () => null);
    const b = needsYouItems([needsYouWorkOfMap('/p', bump)], () => null);
    expect(needsYouCount([needsYouWorkOfMap('/p', map)], () => null)).toBe(needsYouCount([needsYouWorkOfMap('/p', bump)], () => null));
    expect(a.find((i) => i.kind === 'room')?.key).not.toBe(b.find((i) => i.kind === 'room')?.key);
  });

  it('архивная работа в счёт не входит: ни сессии, ни решения, ни письма (как бейдж окна)', () => {
    const archived = { ...map, work: { id: 'w-1', status: 'archived' } } as unknown as WindowWorkMap;
    expect(needsYouWorkOfMap('/p', archived).archived).toBe(true);
    expect(needsYouItems([needsYouWorkOfMap('/p', archived)], activityOf)).toEqual([]);
    expect(needsYouCount([needsYouWorkOfMap('/p', archived), needsYouWorkOfMap('/q', map)], activityOf)).toBe(4);
  });

  it('счётчик писем берётся из компактной карты: v2 — rooms[""].unread, v1 — unread.letters; без записи канала — 0', () => {
    const v2 = { ...map, messages: [], compact: { version: 2, rooms: { '': { unread: 4 } }, unread: { letters: 9, rooms: {} } } } as unknown as WindowWorkMap;
    expect(needsYouWorkOfMap('/p', v2).unreadLetters).toBe(4);
    const v1 = { ...map, messages: [], compact: { version: 1, messages: { rooms: { '': {} } }, unread: { letters: 3, rooms: {} } } } as unknown as WindowWorkMap;
    expect(needsYouWorkOfMap('/p', v1).unreadLetters).toBe(3);
    const none = { ...map, messages: [], compact: { version: 1, messages: { rooms: {} }, unread: { letters: 3, rooms: {} } } } as unknown as WindowWorkMap;
    expect(needsYouWorkOfMap('/p', none).unreadLetters).toBe(0);
  });
});
