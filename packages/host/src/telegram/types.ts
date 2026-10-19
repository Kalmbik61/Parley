/** Общие типы канала Telegram: форма апдейтов Bot API (только то, что читаем) и файл состояния на диске. */

import type { SessionRef } from '@parley/protocol';

export interface TgFrom {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgFrom;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgFrom;
  message?: { message_id: number; chat: { id: number; type: string } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: unknown;
  callback_query?: TgCallbackQuery;
  [key: string]: unknown;
}

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface TelegramOwner {
  userId: number;
  chatId: number;
  username: string | null;
  linkedAt: string;
}

export interface PendingLink {
  codeHash: string;
  expiresAt: string;
  attempts: number;
}

export type CardRecord =
  | {
      kind: 'feed';
      ref: SessionRef;
      cardId: string;
      cardKind: 'permission' | 'question' | 'plan';
      sessionName: string;
      chatId: number;
      messageId: number;
      at: string;
      question: number;
      wait?: { kind: 'other'; until: string };
    }
  | {
      kind: 'room';
      projectPath: string;
      workId: string;
      roomId: string;
      roomTitle: string;
      from: string;
      proposalId: string;
      rev: number;
      planId?: string;
      planRev?: number;
      chatId: number;
      messageId: number;
      at: string;
      wait?: { kind: 'note'; until: string };
    }
  | { kind: 'assistant'; proposalId: string; chatId: number; messageId: number; at: string };

export interface LetterRecord {
  projectPath: string;
  workId: string;
  roomId: string | null;
  from: string;
  at: string;
}

export interface TelegramStateFile {
  version: 1;
  botId: string | null;
  tokenFingerprint: string | null;
  botUsername: string | null;
  owner: TelegramOwner | null;
  pendingLink: PendingLink | null;
  offset: number | null;
  seen: number[];
  cards: Record<string, CardRecord>;
  letters: Record<string, LetterRecord>;
}

export interface AuditEntry {
  at: string;
  kind: 'decision' | 'assistant' | 'reply' | 'link' | 'unlink' | 'voice';
  shortId?: string;
  cardId?: string;
  text?: string;
  result: string;
}
