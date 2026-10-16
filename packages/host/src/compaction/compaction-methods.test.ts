import { describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { CompactionService } from './compaction-service.js';
import { createCompactionMethods } from './compaction-methods.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };

describe('createCompactionMethods (спека 5.1)', () => {
  it('compact отдаёт ответ сервиса, cancelCompact — { cancelled }', async () => {
    const compaction = {
      compact: vi.fn(() => ({ state: 'pending' as const })),
      cancel: vi.fn(() => true),
    } as unknown as CompactionService;
    const methods = createCompactionMethods(compaction);
    await expect(Promise.resolve(methods.compact({ ref, instructions: 'x' }, undefined as never))).resolves.toEqual({ state: 'pending' });
    expect(compaction.compact).toHaveBeenCalledWith(ref, 'x');
    await expect(Promise.resolve(methods.cancel({ ref }, undefined as never))).resolves.toEqual({ cancelled: true });
  });
});
