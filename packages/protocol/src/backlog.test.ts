import { describe, expect, it } from 'vitest';
import { backlogMethodSchemas, backlogSnapshot } from './backlog.js';

describe('backlog wire boundary', () => {
  it('preserves handwritten nullable IDs, exact versions, Unicode line-local text and legacy shared path', () => {
    const data = { projectPath: '/linked/nested', sharedProjectPath: '/main/nested', file: { relativePath: '.harnas/backlog.md', exists: true },
      version: 'opaque-version', items: [{ id: null, title: 'Title\u2028text', details: 'Details', checked: false, section: 'Ideas', taken: 'foreign human text' }],
      suggestions: [], rule: 'problems', diagnostics: [{ code: 'parley-gitignore-custom' }] };
    expect(backlogSnapshot.parse(data)).toEqual(data);
  });
  it('does not let a snapshot invent arbitrary file/directory operations or terminal suggestion rows', () => {
    const data = { projectPath: '/project', sharedProjectPath: '/project', file: { relativePath: '.parley/backlog.md', exists: false },
      version: 'missing', items: [], suggestions: [], rule: 'ask', diagnostics: [] };
    expect(backlogSnapshot.safeParse({ ...data, file: { relativePath: '../secret', exists: true } }).success).toBe(false);
    expect(backlogSnapshot.safeParse({ ...data, rawConfig: 'untrusted' }).success).toBe(false);
    expect(backlogSnapshot.safeParse({ ...data, suggestions: [{ id: 'sg-01', kind: 'idea', title: 'Idea', details: '', why: 'Why', workId: 'w-0001', sessionId: 's-03', createdAt: 'now', status: 'accepted' }] }).success).toBe(false);
  });
  it('requires optimistic versions for destructive edits and accepts only one created target', () => {
    expect(backlogMethodSchemas['backlog.update'].safeParse({ projectPath: '/project', id: 'b-001', patch: { checked: true } }).success).toBe(false);
    expect(backlogMethodSchemas['backlog.update'].safeParse({ projectPath: '/project', id: 'b-001', version: 'v', patch: {} }).success).toBe(false);
    expect(backlogMethodSchemas['backlog.update'].safeParse({ projectPath: '/project', id: 'b-001', version: 'v', patch: { taken: 'w-01/r-01', done: '2026-10-04' } }).success).toBe(false);
    const handwritten = { projectPath: '/project', index: 0, version: 'v', patch: { title: 'Edit' } };
    expect(backlogMethodSchemas['backlog.update'].parse(handwritten)).toEqual(handwritten);
    expect(backlogMethodSchemas['backlog.update'].safeParse({ ...handwritten, id: 'b-001' }).success).toBe(false);
    expect(backlogMethodSchemas['backlog.update'].safeParse({ ...handwritten, index: -1 }).success).toBe(false);
    const base = { projectPath: '/project', id: 'b-001', version: 'v', target: { projectPath: '/project', workId: 'w-0001', roomId: 'r-01' } };
    expect(backlogMethodSchemas['backlog.take'].parse(base)).toEqual(base);
    expect(backlogMethodSchemas['backlog.take'].safeParse({ ...base, target: { ...base.target, sessionId: 's-01' } }).success).toBe(false);
  });
  it('bounds the assembled UTF-8 output below the framing limit, including multibyte text', () => {
    const base = { projectPath: '/project', sharedProjectPath: '/project', file: { relativePath: '.parley/backlog.md', exists: true }, version: 'v', suggestions: [], rule: 'ask', diagnostics: [] };
    const item = { id: null, title: 'x'.repeat(1024 * 1024), details: '', checked: false, section: null };
    expect(backlogSnapshot.safeParse({ ...base, items: Array(5).fill(item) }).success).toBe(false);
    expect(backlogSnapshot.safeParse({ ...base, items: [{ ...item, title: 'я'.repeat(1024 * 1024) }, { ...item, title: 'я'.repeat(1024 * 1024) }] }).success).toBe(false);
  });
  it('bounds new input and preserves LS/PS rather than silently changing title semantics', () => {
    for (const title of ['Title\u2028text', 'Title\u2029text']) expect(backlogMethodSchemas['backlog.add'].safeParse({ projectPath: '/project', title }).success).toBe(true);
    for (const title of ['', '   ', 'New\nline', 'Nul\0', 'x'.repeat(4097)]) expect(backlogMethodSchemas['backlog.add'].safeParse({ projectPath: '/project', title }).success).toBe(false);
    expect(backlogMethodSchemas['backlog.preferences.set'].safeParse({ projectPath: '/project', rule: 'silently-accept' }).success).toBe(false);
  });
});
