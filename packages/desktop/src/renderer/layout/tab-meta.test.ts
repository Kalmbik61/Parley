/**
 * Тесты 6 и 7 куска 2.4: заголовки всех шести видов вкладок (спека 5.3) и
 * обрезка заголовка по кодовым точкам (план, «Числа»: 40).
 */

import { describe, expect, it } from 'vitest';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import { tabMeta, truncateTitle } from './tab-meta.js';

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
  };
}

function room(id: string, title: string): Room {
  return { id, title, creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' };
}

function entry(sessions: WorkSession[], rooms: Room[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms,
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

describe('tabMeta — тест 6', () => {
  const e = entry([session('s-02', 'исполнитель')], [room('r-01', 'общая')]);

  it('terminal: ярлык сессии, значок terminal, сессия для точки состояния', () => {
    const meta = tabMeta({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }, e);
    expect(meta.title).toBe('S02 исполнитель');
    expect(meta.icon).toBe('terminal');
    expect(meta.session?.id).toBe('s-02');
    expect(meta.unread).toBe(false);
    expect(meta.dirty).toBe(false);
    expect(meta.favicon).toBeNull();
  });

  it('terminal без сессии в карте — тег без ярлыка, session: null', () => {
    const meta = tabMeta({ kind: 'terminal', id: 'terminal:s-09', sessionId: 's-09' }, e);
    expect(meta.title).toBe('S09');
    expect(meta.session).toBeNull();
  });

  it('mail: «Mail», значок mail', () => {
    const meta = tabMeta({ kind: 'mail', id: 'mail' }, e);
    expect(meta.title).toBe('Mail');
    expect(meta.icon).toBe('mail');
  });

  it('room: название комнаты, значок room', () => {
    const meta = tabMeta({ kind: 'room', id: 'room:r-01', roomId: 'r-01' }, e);
    expect(meta.title).toBe('общая');
    expect(meta.icon).toBe('room');
  });

  it('room без комнаты в карте — запасной заголовок', () => {
    const meta = tabMeta({ kind: 'room', id: 'room:r-09', roomId: 'r-09' }, e);
    expect(meta.title).toBe('Room');
  });

  it('diff без коммита: «Changes S02»', () => {
    const meta = tabMeta({ kind: 'diff', id: 'diff:s-02', sessionId: 's-02', commit: null }, e);
    expect(meta.title).toBe('Changes S02');
    expect(meta.icon).toBe('diff');
  });

  it('diff с коммитом: «Changes S02 · <7 символов hash>»', () => {
    const meta = tabMeta(
      { kind: 'diff', id: 'diff:s-02:abcdef1234', sessionId: 's-02', commit: 'abcdef1234567' },
      e,
    );
    expect(meta.title).toBe('Changes S02 · abcdef1');
  });

  it('file: имя файла из пути', () => {
    const meta = tabMeta({ kind: 'file', id: 'file:p:src/index.ts', root: { kind: 'project' }, path: 'src/index.ts' }, e);
    expect(meta.title).toBe('index.ts');
    expect(meta.icon).toBe('file');
  });

  it('browser: адрес — заголовка страницы ещё нет (этап 9)', () => {
    const meta = tabMeta({ kind: 'browser', id: 'browser:abc123', url: 'https://example.com' }, e);
    expect(meta.title).toBe('https://example.com');
    expect(meta.icon).toBe('browser');
  });

  it('entry: null — все виды не падают', () => {
    expect(tabMeta({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }, null).title).toBe('S02');
    expect(tabMeta({ kind: 'room', id: 'room:r-01', roomId: 'r-01' }, null).title).toBe('Room');
  });
});

describe('truncateTitle — тест 7', () => {
  it('короче предела — не трогает', () => {
    expect(truncateTitle('S02 исполнитель', 40)).toBe('S02 исполнитель');
  });

  it('50 эмодзи, предел 40 — 40 эмодзи и «…», без одиночных суррогатов', () => {
    const result = truncateTitle('🙂'.repeat(50), 40);
    const codePoints = Array.from(result);
    expect(codePoints).toHaveLength(41);
    expect(codePoints.slice(0, 40).every((ch) => ch === '🙂')).toBe(true);
    expect(codePoints[40]).toBe('…');
    // Ни один суррогат не остался в одиночестве: строка целиком — валидные code points.
    expect(result).toBe('🙂'.repeat(40) + '…');
  });
});
