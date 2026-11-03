import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@parley/core';
import type { RemoteClient } from '@parley/remote-client';
import {
  deliveryLine,
  filterMentionable,
  insertMention,
  letterProblem,
  lines,
  mentionQuery,
  quote,
  recipientsOf,
  roomComposer,
  roomHeader,
  roomOutgoing,
  sendLetter,
  toLine,
  uiOfRoomSend,
  type Mentionable,
} from './model';

const A: Mentionable = { id: 's-1', label: 'Greta', meta: 'opus · idle' };
const B: Mentionable = { id: 's-2', label: 'Critic-A1', meta: 'sonnet · working' };
const msg = (id: string, from: string, at: string, over: Partial<Message> = {}): Message =>
  ({ id, roomId: 'r-1', from, to: [], at, text: id, kind: 'note', readBy: {}, ...over }) as Message;

describe('mentions', () => {
  it('finds the @word being typed at the end only', () => {
    expect(mentionQuery('hello @gr')).toEqual({ start: 6, query: 'gr' });
    expect(mentionQuery('@')).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail@x.com')).toBeNull();
    expect(mentionQuery('hello @Greta done')).toBeNull();
  });
  it('filters by the typed part; an empty query lists everyone', () => {
    expect(filterMentionable([A, B], '').map((a) => a.id)).toEqual(['s-1', 's-2']);
    expect(filterMentionable([A, B], 'crit').map((a) => a.id)).toEqual(['s-2']);
    expect(filterMentionable([A, B], 'zzz')).toEqual([]);
  });
  it('a chosen agent replaces the typed part by a chip text', () => {
    expect(insertMention('please @gr', 'Greta')).toBe('please @Greta ');
    expect(insertMention('', 'Greta')).toBe('@Greta ');
  });
  it('recipients come from the chips still in the text, once each; typed-by-hand ids stay text', () => {
    expect(recipientsOf('@Greta please', [A, B]).map((a) => a.id)).toEqual(['s-1']);
    expect(recipientsOf('@Greta and @Critic-A1', [A, B, A]).map((a) => a.id)).toEqual(['s-1', 's-2']);
    expect(recipientsOf('@s-1 hi', [A])).toEqual([]);
    expect(recipientsOf('Gretam @Gretam', [A])).toEqual([]);
    expect(toLine([])).toBe('To everyone');
    expect(toLine(['Greta', 'Critic-A1'])).toBe('To Greta, Critic-A1');
  });
});

describe('history', () => {
  it('groups the same sender within five minutes; a gap, another sender or the system start a new header', () => {
    const l = lines([
      msg('m-1', 's-1', '2026-11-01T10:00:00.000Z'),
      msg('m-2', 's-1', '2026-11-01T10:04:00.000Z'),
      msg('m-3', 's-1', '2026-11-01T10:10:00.000Z'),
      msg('m-4', 's-2', '2026-11-01T10:10:30.000Z'),
      msg('m-5', 'system', '2026-11-01T10:11:00.000Z'),
      msg('m-6', 'system', '2026-11-01T10:11:10.000Z'),
    ]);
    expect(l.map((x) => x.header)).toEqual([true, false, true, true, true, true]);
  });

  it('delivery line: picked up by all / not picked up yet by the rest; none for other senders', () => {
    const label = (id: string): string => ({ 's-1': 'Greta', 's-2': 'Critic-A1' })[id] ?? id;
    const own = msg('m-1', 'human', 'x', { to: ['s-1'], readBy: { 's-1': 'T' } });
    expect(deliveryLine(own, ['s-1', 's-2'], label)).toBe('✓ Picked up by Greta');
    const all = msg('m-2', 'human', 'x', { readBy: { 's-1': 'T' } });
    expect(deliveryLine(all, ['s-1', 's-2'], label)).toBe('▤ Not picked up yet by Critic-A1');
    expect(deliveryLine(msg('m-3', 's-1', 'x'), ['s-1'], label)).toBeNull();
  });

  it('quotes in a line', () => {
    expect(quote('  a\n\n b ')).toBe('a b');
    expect(quote('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

describe('header and composer', () => {
  const room = (over: object = {}) => ({ id: 'r-1', title: 'T', members: [], lead: null, ownerId: null, mode: 'free', archived: false, proposal: null, messages: null, ...over }) as never;
  it('state words in the order of the design', () => {
    expect(roomHeader(room({ proposal: { id: 'p' } }), [], 1, 1, 'Greta').state).toBe('decision');
    expect(roomHeader(room(), [], 1, 1, null).state).toBe('needs-you');
    expect(roomHeader(room(), [], 0, 2, 'Greta')).toMatchObject({ state: 'working', word: '2 working', subtitle: '2 working · 0 agents · lead Greta · free' });
    expect(roomHeader(room(), [], 0, 0, null).word).toBe('Idle');
  });
  it('the composer table: autonomous, archived, no method, offline', () => {
    expect(roomComposer({ mode: 'free', archived: false }, true, true)).toEqual({ kind: 'input', sendEnabled: true, note: null });
    expect(roomComposer({ mode: 'free', archived: false }, true, false)).toMatchObject({ sendEnabled: false, note: 'Reconnecting — actions are paused' });
    expect(roomComposer({ mode: 'autonomous', archived: false }, true, true).kind).toBe('hidden');
    expect(roomComposer({ mode: 'free', archived: true }, true, true)).toEqual({ kind: 'hidden', text: 'This room is archived' });
    expect(roomComposer({ mode: 'free', archived: false }, false, true).kind).toBe('hidden');
  });
  it('the text rules', () => {
    expect(letterProblem(' ')).not.toBeNull();
    expect(letterProblem('a'.repeat(16 * 1024))).toBeNull();
    expect(letterProblem('a'.repeat(16 * 1024 + 1))).not.toBeNull();
  });
});

describe('sending', () => {
  const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1' };
  const client = (o: unknown) => ({ sendRoomMessage: vi.fn(async () => o) }) as unknown as RemoteClient & { sendRoomMessage: ReturnType<typeof vi.fn> };

  it('goes as a note with the chips as recipients and the reply link; no Face ID, no key', async () => {
    const c = client({ outcome: 'sent', messageId: 'm-9' });
    expect(await sendLetter(c, room, '@Greta go', ['s-1'], 'm-3')).toEqual({ kind: 'sent', messageId: 'm-9' });
    expect(c.sendRoomMessage).toHaveBeenCalledWith({ ...room, text: '@Greta go', kind: 'note', to: ['s-1'], replyTo: 'm-3' });
    await sendLetter(c, room, 'hi', [], null);
    expect(c.sendRoomMessage.mock.calls[1]![0]).toEqual({ ...room, text: 'hi', kind: 'note', to: [] });
  });

  it('refusals keep the host words; the Mac switch has its own line; a lost answer says Retry', () => {
    expect(uiOfRoomSend({ outcome: 'rejected', code: 'bad_request', message: 'not a member' })).toEqual({ kind: 'refused', message: 'Not sent — not a member', hideComposer: false });
    expect(uiOfRoomSend({ outcome: 'rejected', code: 'unknown_method', message: '' })).toMatchObject({ hideComposer: true });
    expect(uiOfRoomSend({ outcome: 'lost' })).toEqual({ kind: 'not-sent', message: 'Not sent · Retry' });
  });
});

import { visibleOutLetters, type OutLetter } from './out-letters';

describe('visibleOutLetters', () => {
  const T = Date.parse('2026-11-01T10:00:00.000Z');
  const out = (over: Partial<OutLetter> = {}): OutLetter => ({ id: 'o1', text: 'go', to: [], replyTo: null, at: T, state: 'sent', note: null, messageId: 'm-9', ...over });
  it('a sent letter merges into the history by id or by text after the send — one bubble, not two', () => {
    expect(visibleOutLetters([out()], [msg('m-9', 'human', '2026-11-01T10:00:02.000Z')])).toEqual([]);
    expect(visibleOutLetters([out({ messageId: null })], [msg('m-5', 'human', '2026-11-01T10:00:02.000Z', { text: 'go' })])).toEqual([]);
  });
  it('sending, failed, and sent-but-not-yet-in-history letters stay; an old letter with the same text is not ours', () => {
    expect(visibleOutLetters([out({ state: 'sending' }), out({ id: 'o2', state: 'failed' })], [])).toHaveLength(2);
    expect(visibleOutLetters([out()], [])).toHaveLength(1);
    expect(visibleOutLetters([out({ messageId: null })], [msg('m-1', 'human', '2026-11-01T08:00:00.000Z', { text: 'go' })])).toHaveLength(1);
  });
});

describe('roomOutgoing (Reply with selection, D1 §9.7)', () => {
  const m = { id: 'm-9', roomId: 'r-1', from: 's-1', to: [], at: '2026-11-03T10:00:00.000Z', text: 'Wave 3 is merged; next A27 goes in parallel.', kind: 'note', readBy: {} } as Message;
  it('no reply: the text as typed, no replyTo', () => {
    expect(roomOutgoing('hello', null)).toEqual({ text: 'hello', replyTo: null });
  });
  it('a plain Reply: replyTo, the text as typed', () => {
    expect(roomOutgoing('ok', { message: m, selected: '' })).toEqual({ text: 'ok', replyTo: 'm-9' });
  });
  it('Reply with selection: replyTo and the fragment as a quote block', () => {
    expect(roomOutgoing('why?', { message: m, selected: ' A27 goes in parallel ' })).toEqual({ text: '> A27 goes in parallel\n\nwhy?', replyTo: 'm-9' });
  });
});
