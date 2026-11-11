// T11 R1 conservation (plan acceptance 3): checkReplacement over the full, short and navigator lists, with the two T11 reads proven. The short profile
// hides memory_read and search_history (mcp-config.ts), so they must never appear migrated there.
import { describe, expect, it } from 'vitest';
import { MIGRATABLE_READS, MIGRATION_REGISTRY, checkReplacement } from '../migration-registry.js';

describe('T11 R1 conservation (plan acceptance 3)', () => {
  const T11 = ['memory_read', 'search_history'];
  /** Short profile hides these two (mcp-config.ts); every other variant lists them. */
  const lists: Record<string, string[]> = {
    full: [...MIGRATABLE_READS, 'report', 'send_message', 'browser_tabs'],
    short: [...MIGRATABLE_READS.filter((n) => !T11.includes(n)), 'report', 'send_message', 'browser_tabs'],
    navigator: [...MIGRATABLE_READS, 'find_skill', 'report'],
  };
  it.each(Object.keys(lists))('%s list: migrated and direct partition the original, nothing absent is invented', (variant) => {
    const original = lists[variant]!;
    const proven = original.filter((n) => MIGRATABLE_READS.includes(n));
    const check = checkReplacement(original, { ...MIGRATION_REGISTRY, proven });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect([...check.migrated, ...check.direct].sort()).toEqual([...original].sort());
    expect(check.migrated.filter((n) => check.direct.includes(n))).toEqual([]);
    expect(check.migrated.filter((n) => !original.includes(n))).toEqual([]);
    expect(check.migrated.includes('memory_read')).toBe(variant !== 'short');
    expect(check.migrated.includes('search_history')).toBe(variant !== 'short');
  });
  it('a proven read this launch does not list is an invalid registry, never an invented method', () => {
    expect(checkReplacement(lists['short']!, { ...MIGRATION_REGISTRY, proven: ['memory_read'] })).toEqual({ ok: false, problem: 'invalid-registry' });
  });
});
