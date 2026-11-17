import { describe, expect, it } from 'vitest';
import { agentColourIndex, agentColourVar } from './agent-colour.js';

describe('agentColourIndex', () => {
  it('s-1…s-8 дают восемь разных номеров', () => {
    const indexes = Array.from({ length: 8 }, (_, i) => agentColourIndex(`s-${i + 1}`));
    expect(new Set(indexes).size).toBe(8);
    for (const index of indexes) expect(index).toBeGreaterThanOrEqual(0);
  });

  it('s-9 совпадает с s-1, s-512 даёт 0', () => {
    expect(agentColourIndex('s-9')).toBe(agentColourIndex('s-1'));
    expect(agentColourIndex('s-512')).toBe(0);
  });

  it('human, engine, пустая строка, мусор, null — цвета нет', () => {
    for (const id of ['human', 'engine', '', 's-', 's-x', 'x-1', 's-1a', ' s-1', null, undefined]) {
      expect(agentColourIndex(id)).toBeNull();
      expect(agentColourVar(id)).toBeNull();
    }
  });
});

describe('agentColourVar', () => {
  it('отдаёт имя токена по номеру', () => {
    expect(agentColourVar('s-3')).toBe('var(--agent-colour-3)');
    expect(agentColourVar('s-8')).toBe('var(--agent-colour-0)');
  });
});
