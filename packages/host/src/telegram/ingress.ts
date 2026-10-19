/** Разбор входящих апдейтов Telegram: чистая классификация до любых действий, чужим не отвечаем. */

import type { PendingLink, TelegramOwner, TgFrom, TgUpdate } from './types.js';

export type Inbound =
  | { kind: 'start'; code: string | null; from: TgFrom; chatId: number }
  | { kind: 'command'; name: 'status' | 'new' | 'help' | 'skip'; messageId: number }
  | { kind: 'text'; text: string; messageId: number; replyTo: number | null }
  | { kind: 'voice'; fileId: string; duration: number; messageId: number }
  | { kind: 'callback'; id: string; data: string; messageId: number | null }
  | { kind: 'foreign-callback'; id: string }
  | { kind: 'ignored'; reason: 'foreign' | 'group' | 'edited' | 'unsupported' | 'no-owner' };

const COMMANDS = ['status', 'new', 'help', 'skip'] as const;

/** `/name`, `/name@bot` и необязательный хвост; имя в нижнем регистре. */
function parseCommand(text: string): { name: string; rest: string } | null {
  const m = /^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() } : null;
}

export function classify(update: TgUpdate, owner: TelegramOwner | null, pendingLink: PendingLink | null): Inbound {
  const cb = update.callback_query;
  if (cb) {
    if (!owner) return { kind: 'ignored', reason: 'no-owner' };
    const chat = cb.message?.chat;
    if (cb.from.id !== owner.userId || !chat || chat.id !== owner.chatId || chat.type !== 'private' || cb.data === undefined) {
      return { kind: 'foreign-callback', id: cb.id };
    }
    return { kind: 'callback', id: cb.id, data: cb.data, messageId: cb.message?.message_id ?? null };
  }

  const msg = update.message;
  if (!msg) return { kind: 'ignored', reason: update.edited_message !== undefined ? 'edited' : 'unsupported' };
  if (msg.chat.type !== 'private') return { kind: 'ignored', reason: 'group' };

  const command = msg.text !== undefined ? parseCommand(msg.text) : null;
  if (command?.name === 'start' && pendingLink && msg.from) {
    return { kind: 'start', code: command.rest === '' ? null : command.rest, from: msg.from, chatId: msg.chat.id };
  }
  if (!owner) return { kind: 'ignored', reason: 'no-owner' };
  if (msg.chat.id !== owner.chatId || msg.from?.id !== owner.userId) return { kind: 'ignored', reason: 'foreign' };

  if (command) {
    const name = COMMANDS.find((c) => c === command.name);
    if (name) return { kind: 'command', name, messageId: msg.message_id };
  }
  if (msg.voice) return { kind: 'voice', fileId: msg.voice.file_id, duration: msg.voice.duration, messageId: msg.message_id };
  if (msg.text !== undefined) {
    return { kind: 'text', text: msg.text, messageId: msg.message_id, replyTo: msg.reply_to_message?.message_id ?? null };
  }
  return { kind: 'ignored', reason: 'unsupported' };
}
