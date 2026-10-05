import { describe, expect, it } from 'vitest';
import { historyMethodSchemas, historySearchResult } from './history.js';
import { METHODS } from './methods.js';

const hit = { source: 'memory', title: 'PTY tests flake', excerpt: 'PTY tests flake in worktrees', date: null, file: '.parley/memory.md', line: 4, id: 'm-001', complete: true };

describe('поиск по прошлому: метод окна', () => {
  it('метод входит в общую таблицу протокола', () => {
    expect(Object.keys(METHODS)).toContain('history.search');
  });
  it('запрос: непустой, область из семи, лимит 1–30, лишних полей нет', () => {
    const schema = historyMethodSchemas['history.search'];
    expect(schema.safeParse({ projectPath: '/p', query: 'pty' }).success).toBe(true);
    expect(schema.safeParse({ projectPath: '/p', query: 'pty', scope: 'all', limit: 30 }).success).toBe(true);
    for (const bad of [{ query: '' }, { query: 'x'.repeat(1001) }, { query: 'x', scope: 'skills' }, { query: 'x', limit: 31 }, { query: 'x', limit: 0 }, { query: 'x', limit: 1.5 }, { query: 'x', file: '/etc/passwd' }])
      expect(schema.safeParse({ projectPath: '/p', ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
  it('ответ строгий: файл — относительный, у итога сессии файла нет, лишнее не проходит', () => {
    const base = { query: 'pty', scope: 'all', limit: 10, total: 1, hits: [hit], unavailable: [] };
    expect(historySearchResult.safeParse(base).success).toBe(true);
    expect(historySearchResult.safeParse({ ...base, hits: [{ source: 'sessions', title: 'Done', excerpt: 'Done', date: '2026-10-05T10:00:00.000Z', workId: 'w-0001', sessionId: 's-01', complete: true }] }).success).toBe(true);
    expect(historySearchResult.safeParse({ ...base, hits: [{ ...hit, hash: 'abc' }] }).success).toBe(false);
    expect(historySearchResult.safeParse({ ...base, hits: [{ ...hit, source: 'skills' }] }).success).toBe(false);
    expect(historySearchResult.safeParse({ ...base, hits: Array.from({ length: 31 }, () => hit) }).success).toBe(false);
  });
});
