import { describe, expect, it } from 'vitest';
import { DECISION_FILE_NAME, decisionRef, decisionsListResult, journalMethodSchemas, roomHistoryStatus } from './journal.js';
import { METHODS } from './methods.js';

const room = { projectPath: '/project', workId: 'w-0001', roomId: 'r-01' };
const ref = {
  file: '2026-10-05-w-0001-r-01-p-01-rev-02.md', workId: 'w-0001', roomId: 'r-01', proposalId: 'p-01', rev: 2,
  acceptedAt: '2026-10-05T10:00:00.000Z', title: 'Ship it', kind: 'decision', state: 'accepted', openable: true,
};

describe('журнал решений и история комнат: методы окна', () => {
  it('методы входят в общую таблицу протокола', () => {
    for (const name of Object.keys(journalMethodSchemas)) expect(Object.keys(METHODS)).toContain(name);
  });
  it('decisions.list: строгая форма, фильтр и лимит ограничены', () => {
    const schema = journalMethodSchemas['decisions.list'];
    expect(schema.safeParse({ projectPath: '/p' }).success).toBe(true);
    expect(schema.safeParse({ projectPath: '/p', query: 'ship', limit: 200 }).success).toBe(true);
    expect(schema.safeParse({ projectPath: '/p', limit: 201 }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', query: 'x'.repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '', query: 'a' }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', file: 'x' }).success).toBe(false);
  });
  it('Share требует явного подтверждения и версию; Unshare обходится без подтверждения, но с версией', () => {
    const share = journalMethodSchemas['rooms.history.share'];
    expect(share.safeParse({ ...room, expectedVersion: 'missing', confirmed: true }).success).toBe(true);
    expect(share.safeParse({ ...room, expectedVersion: 'missing' }).success).toBe(false);
    expect(share.safeParse({ ...room, expectedVersion: 'missing', confirmed: false }).success).toBe(false);
    expect(share.safeParse({ ...room, confirmed: true }).success).toBe(false);
    expect(journalMethodSchemas['rooms.history.unshare'].safeParse({ ...room, expectedVersion: 'v1' }).success).toBe(true);
    expect(journalMethodSchemas['rooms.history.unshare'].safeParse({ ...room, expectedVersion: 'v1', confirmed: true }).success).toBe(false);
  });
  it('идентификаторы работы и комнаты — только w-N и r-N, без путей', () => {
    for (const name of ['rooms.history.get', 'rooms.history.share', 'rooms.history.unshare'] as const) {
      const extra = name === 'rooms.history.get' ? {} : name === 'rooms.history.share' ? { expectedVersion: 'v', confirmed: true } : { expectedVersion: 'v' };
      expect(journalMethodSchemas[name].safeParse({ ...room, ...extra }).success).toBe(true);
      expect(journalMethodSchemas[name].safeParse({ ...room, workId: '../w-1', ...extra }).success).toBe(false);
      expect(journalMethodSchemas[name].safeParse({ ...room, roomId: 'room', ...extra }).success).toBe(false);
    }
  });
  it('ссылка на решение: имя файла только из каталога журнала, без путей и лишних полей', () => {
    expect(decisionRef.safeParse(ref).success).toBe(true);
    for (const file of ['../2026-10-05-w-0001-r-01-p-01-rev-02.md', '/abs/2026-10-05-w-0001-r-01-p-01-rev-02.md', 'notes.md', ref.file + 'x'])
      expect(decisionRef.safeParse({ ...ref, file }).success).toBe(false);
    expect(DECISION_FILE_NAME.test(ref.file)).toBe(true);
    expect(decisionRef.safeParse({ ...ref, absolutePath: '/x' }).success).toBe(false);
    expect(decisionRef.safeParse({ ...ref, state: 'trusted' }).success).toBe(false);
  });
  it('ответы строгие: частичный результат и ошибки чтения видны, лишнее не проходит', () => {
    expect(decisionsListResult.safeParse({ decisions: [ref], total: 1, partial: true, errors: [{ code: 'file-unreadable', count: 2 }] }).success).toBe(true);
    expect(decisionsListResult.safeParse({ decisions: [], total: 0, partial: false, errors: [], body: 'x' }).success).toBe(false);
    expect(decisionsListResult.safeParse({ decisions: [], total: 0, partial: false, errors: [{ code: 'secret', count: 1 }] }).success).toBe(false);
    expect(roomHistoryStatus.safeParse({ state: 'shared', sharedAt: '2026-10-05T10:00:00.000Z', version: 'v1', diagnostics: [] }).success).toBe(true);
    expect(roomHistoryStatus.safeParse({ state: 'shared', sharedAt: 'yesterday', version: 'v1', diagnostics: [] }).success).toBe(false);
    expect(roomHistoryStatus.safeParse({ state: 'not-shared', sharedAt: null, version: 'missing', diagnostics: [], receipt: {} }).success).toBe(false);
  });
});
