import { describe, expect, it } from 'vitest';
import { codexHookFlags } from './codex-hooks.js';

describe('codexHookFlags', () => {
  it('пара -c на каждое событие; таймаут PermissionRequest 600, прочих 30; путь в TOML-кавычках', () => {
    const flags = codexHookFlags('/Users/me/.parley/bin/parley-codex-hook');
    expect(flags).toHaveLength(14);
    expect(flags[0]).toBe('-c');
    expect(flags[1]).toBe('hooks.SessionStart=[{hooks=[{type="command",command="/Users/me/.parley/bin/parley-codex-hook",timeout=30}]}]');
    expect(flags).toContain('hooks.PermissionRequest=[{hooks=[{type="command",command="/Users/me/.parley/bin/parley-codex-hook",timeout=600}]}]');
  });
  it('стабильно: два вызова — тот же текст побайтно', () => {
    expect(codexHookFlags('/a b/hook').join('\u0000')).toBe(codexHookFlags('/a b/hook').join('\u0000'));
  });
});
