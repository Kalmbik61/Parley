import { describe, expect, it } from 'vitest';
import { classify } from './ingress.js';
import type { PendingLink, TelegramOwner, TgUpdate } from './types.js';

const owner: TelegramOwner = { userId: 7, chatId: 7, username: 'me', linkedAt: '2026-10-20T10:00:00.000Z' };
const pending: PendingLink = { codeHash: 'x', expiresAt: '2026-10-20T10:10:00.000Z', attempts: 0 };

function message(over: { text?: string; userId?: number; chatId?: number; chatType?: string; voice?: boolean; replyTo?: number }): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: over.chatId ?? 7, type: over.chatType ?? 'private' },
      from: { id: over.userId ?? 7 },
      ...(over.text !== undefined ? { text: over.text } : {}),
      ...(over.voice ? { voice: { file_id: 'f1', duration: 3 } } : {}),
      ...(over.replyTo !== undefined ? { reply_to_message: { message_id: over.replyTo } } : {}),
    },
  };
}

function press(userId: number, chatId = 7): TgUpdate {
  return { update_id: 2, callback_query: { id: 'cb1', from: { id: userId }, data: 'pc1:aB3dE9fG:q2', message: { message_id: 5, chat: { id: chatId, type: 'private' } } } };
}

describe('classify', () => {
  it('текст владельца', () => {
    expect(classify(message({ text: 'привет' }), owner, null)).toEqual({ kind: 'text', text: 'привет', messageId: 11, replyTo: null });
  });
  it('ответ владельца на сообщение', () => {
    expect(classify(message({ text: 'ok', replyTo: 4 }), owner, null)).toMatchObject({ kind: 'text', replyTo: 4 });
  });
  it('текст чужого → foreign', () => {
    expect(classify(message({ text: 'hi', userId: 9, chatId: 9 }), owner, null)).toEqual({ kind: 'ignored', reason: 'foreign' });
  });
  it('нажатие владельца', () => {
    expect(classify(press(7), owner, null)).toEqual({ kind: 'callback', id: 'cb1', data: 'pc1:aB3dE9fG:q2', messageId: 5 });
  });
  it('нажатие чужого → foreign-callback', () => {
    expect(classify(press(9), owner, null)).toEqual({ kind: 'foreign-callback', id: 'cb1' });
  });
  it('edited_message → edited', () => {
    expect(classify({ update_id: 3, edited_message: {} }, owner, null)).toEqual({ kind: 'ignored', reason: 'edited' });
  });
  it('прочий апдейт → unsupported', () => {
    expect(classify({ update_id: 3, poll: {} }, owner, null)).toEqual({ kind: 'ignored', reason: 'unsupported' });
  });
  it('группа → group', () => {
    expect(classify(message({ text: 'hi', chatType: 'supergroup', chatId: -100 }), owner, null)).toEqual({ kind: 'ignored', reason: 'group' });
  });
  it('/start CODE при живом pendingLink от любого отправителя', () => {
    expect(classify(message({ text: '/start ABCD-EFGH', userId: 9, chatId: 9 }), null, pending)).toEqual({
      kind: 'start', code: 'ABCD-EFGH', from: { id: 9 }, chatId: 9,
    });
  });
  it('/start без кода → code: null', () => {
    expect(classify(message({ text: '/start@parley_bot' }), owner, pending)).toMatchObject({ kind: 'start', code: null });
  });
  it('/start без pendingLink и без владельца → no-owner', () => {
    expect(classify(message({ text: '/start ABCD' }), null, null)).toEqual({ kind: 'ignored', reason: 'no-owner' });
  });
  it('/status@parley_bot → command', () => {
    expect(classify(message({ text: '/status@parley_bot' }), owner, null)).toEqual({ kind: 'command', name: 'status', messageId: 11 });
  });
  it('голосовое владельца', () => {
    expect(classify(message({ voice: true }), owner, null)).toEqual({ kind: 'voice', fileId: 'f1', duration: 3, messageId: 11 });
  });
});
