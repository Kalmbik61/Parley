/**
 * Место под память помощника (спека 2026-11-03, C4): только тип и каталог. Таблиц и реализации нет — схема БД не
 * менялась; хранение и поиск придут отдельной задачей (P2).
 *
 * Инвариант PA-05: личная память (`scope: 'personal'`) не попадает в git и не пишется в `.parley/memory.md`, которую
 * читают агенты проекта: она живёт только в данных хоста владельца. В общие каналы уходит лишь то, что явно помечено
 * видимым (`visibility`).
 */

export type AssistantMemoryScope = 'personal' | 'workspace' | `project:${string}`;
export type AssistantMemoryStatus = 'proposed' | 'active' | 'superseded' | 'forgotten';
export type AssistantMemoryVisibility = 'private' | 'shared';

/** Откуда известен факт: чтобы его можно было проверить и забыть вместе с источником. */
export interface AssistantMemoryProvenance {
  /** Канал или объект-источник: `island`, `telegram`, `room:<id>`, `session:<id>`. */
  source: string;
  at: number;
  /** Ссылка на конкретное сообщение или запись источника, если она есть. */
  ref?: string;
}

export interface AssistantMemoryEntry {
  id: string;
  ownerId: string;
  scope: AssistantMemoryScope;
  /** Род записи: `preference`, `fact`, `decision`… Список не закрыт. */
  kind: string;
  statement: string;
  provenance: AssistantMemoryProvenance[];
  status: AssistantMemoryStatus;
  /** Растёт на каждое изменение записи и только вверх. */
  revision: number;
  visibility: AssistantMemoryVisibility;
}

export interface AssistantMemoryStore {
  get(id: string): AssistantMemoryEntry | null;
  list(filter: { ownerId: string; scope?: AssistantMemoryScope; status?: AssistantMemoryStatus }): AssistantMemoryEntry[];
  put(entry: AssistantMemoryEntry): AssistantMemoryEntry;
}
