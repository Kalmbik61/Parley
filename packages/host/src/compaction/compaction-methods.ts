/** Методы сжатия (спека 2026-10-15, 5.1): тонкая обёртка над `CompactionService`; зовёт только окно по клику человека. */

import type { Handler } from '../context.js';
import type { CompactionService } from './compaction-service.js';

export function createCompactionMethods(compaction: Pick<CompactionService, 'compact' | 'cancel'>): {
  compact: Handler<'sessions.compact'>;
  cancel: Handler<'sessions.cancelCompact'>;
} {
  return {
    compact: async ({ ref, instructions }) => compaction.compact(ref, instructions),
    cancel: async ({ ref }) => ({ cancelled: compaction.cancel(ref) }),
  };
}
