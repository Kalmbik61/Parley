import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { buildReplySnapshot, clipReply, NO_TEXT_NOTE, REPLY_LIMIT, UNREADABLE_NOTE } from './reply-snapshot.js';
import type { WatchEvent } from './reply-watch.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const prompt = (id: string, ms: number): FeedItem => ({ id, at: iso(ms), kind: 'prompt', text: 'go', images: 0 });
const text = (id: string, ms: number, body: string): FeedItem => ({ id, at: iso(ms), kind: 'text', messageId: id, text: body, streaming: false });

const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const turnEnd = (boundaryMs: number, endMs: number): WatchEvent => ({ watchId: 'w-1', ref, name: 'Vera', event: 'turn-end', key: `turn:${T0 + endMs}`, boundary: T0 + boundaryMs, turnEndedAt: T0 + endMs });

describe('reply-snapshot', () => {
  it('RW-08: снимок закреплён за своим ходом, а не за последним', () => {
    const items = [prompt('p1', 0), text('t1', 5000, 'first reply'), prompt('p2', 20_000), text('t2', 30_000, 'second reply')];
    const snapshot = buildReplySnapshot({ event: turnEnd(0, 10_000), items, sent: [] });
    expect(snapshot).toMatchObject({ event: 'turn-end', session: 'Vera', reply: 'first reply', replyNote: null });
    const second = buildReplySnapshot({ event: turnEnd(20_000, 35_000), items, sent: [] });
    expect(second.reply).toBe('second reply');
  });

  it('RW-09: 20 000 знаков — голова 1500, хвост 4500 с отметкой пропуска, вывод в конце сохранён', () => {
    const body = `${'a'.repeat(19_000)}${'RESULT-AT-THE-END '.repeat(50)}`.slice(0, 19_950) + 'FINAL OUTPUT: 42';
    const snapshot = buildReplySnapshot({ event: turnEnd(0, 10_000), items: [prompt('p1', 0), text('t1', 5000, body)], sent: [] });
    expect(snapshot.reply).toContain('FINAL OUTPUT: 42');
    expect(snapshot.reply?.startsWith(body.slice(0, 1500))).toBe(true);
    expect(snapshot.reply).toContain(`[… ${body.length - 6000} characters omitted …]`);
    expect(snapshot.reply?.endsWith(body.slice(-4500))).toBe(true);
  });

  it('текст до предела не режется', () => {
    expect(clipReply('x'.repeat(REPLY_LIMIT))).toHaveLength(REPLY_LIMIT);
  });

  it('RW-09: лента недоступна — отметка «ответ прочитать не удалось»', () => {
    const snapshot = buildReplySnapshot({ event: turnEnd(0, 10_000), items: null, sent: [] });
    expect(snapshot).toMatchObject({ reply: null, replyNote: UNREADABLE_NOTE });
  });

  it('ход без текста — отметка NO_TEXT_NOTE', () => {
    const snapshot = buildReplySnapshot({ event: turnEnd(0, 10_000), items: [prompt('p1', 0)], sent: [] });
    expect(snapshot).toMatchObject({ reply: null, replyNote: NO_TEXT_NOTE });
  });

  it('«ждёт человека»: вид ожидания, ждущая карточка и последнее письмо помощника', () => {
    const card: FeedItem = { id: 'c1', cardId: 'c1', at: iso(1000), kind: 'permission', state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, suggestions: [], notified: false };
    const event: WatchEvent = { watchId: 'w-1', ref, name: 'Vera', event: 'needs-human', key: 'need:permission:x', boundary: T0, need: { kind: 'permission', since: iso(1000), detail: 'Bash' } };
    const snapshot = buildReplySnapshot({ event, items: [prompt('p1', 0), card], sent: [{ text: 'old' }, { text: 'clean the build' }] });
    expect(snapshot.waiting).toEqual({ kind: 'permission', detail: 'Bash', card: { type: 'permission', text: expect.stringContaining('rm -rf build') } });
    expect(snapshot.lastLetter).toBe('clean the build');
    expect(snapshot.reply).toBeNull();
  });
});
