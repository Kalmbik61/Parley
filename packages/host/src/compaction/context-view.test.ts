import { describe, expect, it } from 'vitest';
import { contextView } from './context-view.js';

const fill = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };

describe('contextView (спека 4.4, 5.6)', () => {
  it('нет сжатия — наблюдение как есть', () => {
    expect(contextView(fill, undefined)).toEqual({ context: fill, compaction: null });
    expect(contextView(null, undefined)).toEqual({ context: null, compaction: null });
  });

  it('ждёт или идёт — фаза и прежнее наблюдение', () => {
    expect(contextView(fill, { phase: 'pending', finishedAt: null })).toEqual({ context: fill, compaction: 'pending' });
    expect(contextView(fill, { phase: 'running', finishedAt: '2026-10-15T11:00:00.000Z' })).toEqual({ context: fill, compaction: 'running' });
  });

  it('наблюдение старше конца сжатия — процента нет, compacted', () => {
    expect(contextView(fill, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: null, compaction: 'compacted' });
    expect(contextView(null, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: null, compaction: 'compacted' });
  });

  it('наблюдение новее конца сжатия — снова процент', () => {
    const fresh = { ...fill, usedPercent: 12, at: '2026-10-15T10:06:00.000Z' };
    expect(contextView(fresh, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: fresh, compaction: null });
  });
});
