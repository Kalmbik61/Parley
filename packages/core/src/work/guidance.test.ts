import { describe, expect, it } from 'vitest';
import { GUIDE } from './guide.js';
import { systemGuidance } from './guidance.js';
import type { WorkMap } from './types.js';

/** Карта из двух полей: вставке нужны только работа и id сессии. */
function mapOf(title: string, goal: string): WorkMap {
  return {
    schemaVersion: 1,
    work: {
      id: 'w-0001',
      title,
      goal,
      status: 'active',
      createdAt: '2026-09-06T10:00:00.000Z',
      updatedAt: '2026-09-06T10:00:00.000Z',
    },
    sessions: [],
    messages: [],
  };
}

/** Семь инструментов сервера: вставка называет каждый, иначе агент о нём не узнает. */
const TOOLS = [
  'get_map',
  'report',
  'spawn_session',
  'wait_for',
  'send_message',
  'check_inbox',
  'read_guide',
];

describe('системная вставка', () => {
  it('короткая, называет работу, сессию и все семь инструментов', () => {
    const text = systemGuidance(mapOf('Авторизация', 'логин по e-mail'), 's-03');
    const lines = text.split('\n');

    expect(lines.length).toBeLessThanOrEqual(12);
    expect(text).toContain('w-0001');
    expect(text).toContain('Авторизация');
    expect(text).toContain('s-03');
    for (const tool of TOOLS) expect(text).toContain(tool);
    // Правило предпочтения: длинная или параллельная подзадача — подсессия работы.
    expect(text).toMatch(/параллельно/);
    expect(text).toMatch(/субагент/);
  });

  it('цель работы пуста — строки цели нет', () => {
    const text = systemGuidance(mapOf('Авторизация', ''), 's-01');
    expect(text).not.toContain('Цель работы');
    expect(text.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('кавычки и переносы в заголовке не ломают счёт строк', () => {
    const text = systemGuidance(mapOf('«Вход»\nи выход', 'первый\nвторой'), 's-01');

    expect(text.split('\n').length).toBeLessThanOrEqual(12);
    expect(text).toContain('«Вход» и выход');
    expect(text).toContain('первый второй');
  });
});

describe('подробный гид', () => {
  it('объясняет предпочтение подсессий и состояние deleted', () => {
    expect(GUIDE).toContain('spawn_session');
    expect(GUIDE).toContain('state: deleted');
    expect(GUIDE.split('\n').length).toBeGreaterThan(30);
  });

  it('запрещает удалять и переносить каталоги .harnas руками', () => {
    // Агент без инструмента удаления не должен идти в shell: удаление сессии —
    // только из TUI, удаления работы пока нет вовсе.
    expect(GUIDE).toMatch(/[Нн]е удаля[^\n]*\.harnas/);
    expect(GUIDE).toContain('из TUI');
  });
});
