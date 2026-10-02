import { describe, expect, it } from 'vitest';
import { claudeCommands } from './claude-commands.js';

describe('claudeCommands', () => {
  const commands = claudeCommands();

  it('имена без «/» и уникальны', () => {
    const names = commands.map((c) => c.name);
    expect(names.every((n) => n !== '' && !n.includes('/') && !n.includes(' '))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('у всех есть описание, у terminal-команд — тем более', () => {
    for (const c of commands) expect(c.description.length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.terminal).length).toBeGreaterThan(0);
  });

  it('model с аргументом — не terminal; memory и resume — terminal', () => {
    const byName = new Map(commands.map((c) => [c.name, c]));
    expect(byName.get('model')?.terminal).toBe(false);
    expect(byName.get('memory')?.terminal).toBe(true);
    expect(byName.get('resume')?.terminal).toBe(true);
    for (const n of ['clear', 'compact', 'context', 'cost', 'effort', 'fast', 'help', 'init', 'plan', 'review', 'status', 'usage', 'add-dir', 'export', 'exit']) {
      expect(byName.get(n)?.terminal).toBe(false);
    }
  });
});
