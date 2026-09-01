import { describe, expect, it } from 'vitest';
import { adapterV1 } from './adapter-v1.js';

const map = adapterV1.toSessionRecord;

describe('adapterV1', () => {
  it('раскладывает запись assistant по типизированным полям', () => {
    const record = map({
      type: 'assistant',
      uuid: 'u1',
      parentUuid: 'u0',
      timestamp: '2026-09-01T14:58:28.073Z',
      sessionId: 's1',
      cwd: '/work',
      gitBranch: 'main',
      version: '2.1.247',
      isSidechain: false,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'готово' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    });

    expect(record.type).toBe('assistant');
    expect(record.model).toBe('claude-opus-5');
    expect(record.role).toBe('assistant');
    expect(record.toolUses).toEqual(['Bash', 'Read']);
    expect(record.text).toBe('готово');
    expect(record.isSidechain).toBe(false);
  });

  it('пустая запись не роняет адаптер — всё в null', () => {
    const record = map({});
    expect(record.type).toBeNull();
    expect(record.model).toBeNull();
    expect(record.text).toBeNull();
    expect(record.toolUses).toEqual([]);
    expect(record.isSidechain).toBe(false);
  });

  it('принимает session_id наравне с sessionId', () => {
    expect(map({ session_id: 's2' }).sessionId).toBe('s2');
    expect(map({ sessionId: 's1', session_id: 's2' }).sessionId).toBe('s1');
  });

  it('заголовок берётся и из customTitle, и из aiTitle', () => {
    expect(map({ type: 'custom-title', customTitle: 'мой заголовок' }).title).toBe('мой заголовок');
    expect(map({ type: 'ai-title', aiTitle: 'сгенерённый' }).title).toBe('сгенерённый');
  });

  it('last-prompt отдаёт lastPrompt и leafUuid', () => {
    const record = map({ type: 'last-prompt', leafUuid: 'u9', lastPrompt: 'сделай X' });
    expect(record.lastPrompt).toBe('сделай X');
    expect(record.leafUuid).toBe('u9');
  });

  it('строковый content становится текстом', () => {
    expect(map({ message: { role: 'user', content: 'привет' } }).text).toBe('привет');
  });

  it('isSidechain: только строгий true', () => {
    expect(map({ isSidechain: true }).isSidechain).toBe(true);
    expect(map({ isSidechain: 'true' }).isSidechain).toBe(false);
    expect(map({}).isSidechain).toBe(false);
  });

  it('неизвестные поля сохраняются в raw', () => {
    const raw = { type: 'frame-link', неизвестное: { вложенное: 1 } };
    expect(map(raw).raw).toBe(raw);
  });

  it('мусор вместо message игнорируется', () => {
    expect(map({ message: 'строка' }).role).toBeNull();
    expect(map({ message: [1, 2] }).model).toBeNull();
    expect(map({ message: { content: [null, 'строка', { type: 'text' }] } }).text).toBeNull();
  });
});
