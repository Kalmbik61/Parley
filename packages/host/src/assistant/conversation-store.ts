/**
 * Durable-история разговора помощника (спека 2026-11-03, C1): ходы ask/answer острова и Telegram пишутся в одну
 * базу, канал — атрибут сообщения. Идентификатор CLI-сессии сюда не попадает: он живёт в памяти сервиса.
 * Запись идемпотентна: `(разговор, turnKey, роль)` уникален, повтор события стрима обновляет ту же строку.
 */

import type { DatabaseSync } from 'node:sqlite';

export type MessageChannel = 'island' | 'telegram' | 'reminder' | 'voice';
export type MessageRole = 'user' | 'assistant';

export interface ConversationMessage {
  turnKey: string;
  role: MessageRole;
  channel: MessageChannel;
  text: string;
  createdAt: number;
}

export interface ConversationStore {
  /** Id текущего разговора — последнего созданного; нет ни одного — создаётся. */
  current(now: number): string;
  /** Новый разговор (после `reset`): история прошлых остаётся в базе. */
  startNew(now: number): string;
  /** Запись хода. Повтор с тем же `turnKey` и ролью меняет текст, а не добавляет строку. */
  write(entry: { turnKey: string; role: MessageRole; channel: MessageChannel; text: string }, now: number): void;
  /** Последние `limit` сообщений текущего разговора, старые первыми. */
  history(limit: number): ConversationMessage[];
}

interface Raw {
  turn_key: string;
  role: MessageRole;
  channel: MessageChannel;
  text: string;
  created_at: number;
}

export function createConversationStore(db: DatabaseSync): ConversationStore {
  const latest = (): string | null => {
    const row = db.prepare('SELECT id FROM assistant_conversations ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id: string } | undefined;
    return row?.id ?? null;
  };
  const create = (now: number): string => {
    const id = `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare('INSERT INTO assistant_conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
    return id;
  };
  const current = (now: number): string => latest() ?? create(now);
  return {
    current,
    startNew: create,
    write(entry, now) {
      const id = current(now);
      db.prepare(
        `INSERT INTO assistant_messages (conversation_id, turn_key, role, channel, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, turn_key, role) DO UPDATE SET text = excluded.text`,
      ).run(id, entry.turnKey, entry.role, entry.channel, entry.text, now);
      db.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(now, id);
    },
    history(limit) {
      const id = latest();
      if (id === null) return [];
      const rows = db
        .prepare('SELECT turn_key, role, channel, text, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
        .all(id, limit) as unknown as Raw[];
      return rows.reverse().map((row) => ({ turnKey: row.turn_key, role: row.role, channel: row.channel, text: row.text, createdAt: row.created_at }));
    },
  };
}
