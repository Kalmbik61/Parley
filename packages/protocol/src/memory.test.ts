import { describe, expect, it } from 'vitest';
import { memoryMethodSchemas, memorySnapshot } from './memory.js';
import { METHODS } from './methods.js';

const item = { id: 'm-001', kind: 'lesson', fact: 'PTY tests flake', details: '', state: 'current', author: 'agent', by: 's-02', onRequest: false, amended: false };
const snapshot = {
  projectPath: '/p', file: { relativePath: '.parley/memory.md', exists: true }, version: 'v1', items: [item],
  suggestions: [{ id: 'ms-01', kind: 'fact', fact: 'Build with pnpm', details: '', why: 'Asked', workId: 'w-0001', sessionId: 's-01', createdAt: '2026-10-05T10:00:00.000Z' }],
  undoable: [{ operationId: 'remember:ms-02', memoryId: 'm-002', fact: 'Close with consent', workId: 'w-0001', sessionId: 's-01' }],
  diagnostics: [],
};

describe('память проекта: методы окна', () => {
  it('методы входят в общую таблицу протокола', () => {
    for (const name of Object.keys(memoryMethodSchemas)) expect(Object.keys(METHODS)).toContain(name);
  });
  it('memory.add: фраза одной строкой без служебных скобок, вид из трёх', () => {
    const schema = memoryMethodSchemas['memory.add'];
    expect(schema.safeParse({ projectPath: '/p', kind: 'fact', fact: 'Build with pnpm', details: 'More' }).success).toBe(true);
    for (const fact of ['', '  ', 'a\nb', 'x <!-- m-001 -->', 'x --> y', 'a\0b']) expect(schema.safeParse({ projectPath: '/p', kind: 'fact', fact }).success, JSON.stringify(fact)).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', kind: 'note', fact: 'x' }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', kind: 'fact', fact: 'x', origin: 'agent' }).success).toBe(false);
  });
  it('memory.update: id и версия обязательны, пустая правка не проходит', () => {
    const schema = memoryMethodSchemas['memory.update'];
    expect(schema.safeParse({ projectPath: '/p', id: 'm-001', version: 'v1', patch: { fact: 'New' } }).success).toBe(true);
    expect(schema.safeParse({ projectPath: '/p', id: 'm-001', patch: { fact: 'New' } }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', id: 'm-001', version: 'v1', patch: {} }).success).toBe(false);
    expect(schema.safeParse({ projectPath: '/p', id: '1', version: 'v1', patch: { fact: 'New' } }).success).toBe(false);
  });
  it('accept, dismiss и undo принимают только свои идентификаторы', () => {
    expect(memoryMethodSchemas['memory.accept'].safeParse({ projectPath: '/p', id: 'ms-01', fact: 'Edited' }).success).toBe(true);
    expect(memoryMethodSchemas['memory.accept'].safeParse({ projectPath: '/p', id: 'm-001' }).success).toBe(false);
    expect(memoryMethodSchemas['memory.dismiss'].safeParse({ projectPath: '/p', id: 'ms-01' }).success).toBe(true);
    expect(memoryMethodSchemas['memory.undo'].safeParse({ projectPath: '/p', operationId: 'remember:ms-02' }).success).toBe(true);
    expect(memoryMethodSchemas['memory.undo'].safeParse({ projectPath: '/p', operationId: '../x' }).success).toBe(false);
    expect(memoryMethodSchemas['memory.get'].safeParse({ projectPath: '/p/a\0b' }).success).toBe(false);
  });
  it('снимок строгий: лишние поля и абсолютные пути файла не проходят', () => {
    expect(memorySnapshot.safeParse(snapshot).success).toBe(true);
    expect(memorySnapshot.safeParse({ ...snapshot, file: { relativePath: '/abs/memory.md', exists: true } }).success).toBe(false);
    expect(memorySnapshot.safeParse({ ...snapshot, items: [{ ...item, secret: 1 }] }).success).toBe(false);
    expect(memorySnapshot.safeParse({ ...snapshot, undoable: Array.from({ length: 21 }, () => snapshot.undoable[0]) }).success).toBe(false);
  });
});
