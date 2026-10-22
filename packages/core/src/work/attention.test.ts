import { describe, expect, it } from 'vitest';
import {
  ATTENTION_RANK,
  humanUnreadLetters,
  humanUnreadMentions,
  isHumanMention,
  isHumanUnread,
  plainHumanMention,
  roomAwaitsDecision,
  sessionAttention,
  sessionNeed,
} from './attention.js';
import type { SessionActivity } from './activity.js';
import type { SessionNeed } from './stuck.js';
import type { Message, Room, WorkMap, WorkSession } from './types.js';

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
