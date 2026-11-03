/**
 * Копии, которые держит окно: у вкладок редактора есть несохранённые правки, и уборка такую копию не трогает.
 * Удержание хранится на клиенте и пропадает вместе с ним — закрытое окно ничего не держит.
 */

import { refKey, WORKTREE_HOLDS_FEATURE } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { Client } from '../client.js';

export interface WorktreeHolds {
  /** Заменяет весь набор удержаний этого клиента. */
  set(client: Client, refs: SessionRef[]): void;
  /** Ключи сессий (`refKey`), удержанные любым из подключённых клиентов. */
  held(): Set<string>;
  /** Есть ли окно, умеющее держать копии: без него уборка не знает о несохранённых правках. Телефоны не считаются. */
  windowPresent(): boolean;
}

export function createWorktreeHolds(clients: () => readonly Client[]): WorktreeHolds {
  const byClient = new WeakMap<Client, Set<string>>();
  return {
    set(client, refs) {
      byClient.set(client, new Set(refs.map(refKey)));
    },
    held() {
      const all = new Set<string>();
      for (const client of clients()) {
        for (const key of byClient.get(client) ?? []) all.add(key);
      }
      return all;
    },
    windowPresent() {
      return clients().some((client) => client.role !== 'remote' && client.features.has(WORKTREE_HOLDS_FEATURE));
    },
  };
}
