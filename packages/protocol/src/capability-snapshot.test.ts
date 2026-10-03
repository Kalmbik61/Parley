import { describe, expect, expectTypeOf, it } from 'vitest';
import { capabilitySnapshot } from './capability-snapshot.js';
import type { CapabilitySnapshot } from './capability-snapshot.js';
import { METHODS } from './methods.js';
import type { Result } from './methods.js';
import type { EventData } from './events.js';

const presence = (id: string) => ({ id, scope: 'extra', source: null, documentPath: `/skills/${id}/SKILL.md`,
  description: 'Review code', installed: true, enabled: null, status: 'unknown', summary: null,
  modelAvailable: false, unavailableReason: 'availability-unverified' });
const snapshot = () => ({ projectPath: '/project', revision: 1,
  columns: { claude: { phase: 'loading', diagnostics: [] }, codex: { phase: 'partial', diagnostics: [{ code: 'resolver-partial' }] } },
  rows: [{ id: 'skill:review', kind: 'skill', name: 'review', description: 'Review code', separateCopies: false,
    claude: [], codex: [presence('first'), presence('second')] }] });

describe('safe capability snapshot wire', () => {
  it('retains same-name canonical identities, unknown enabled and independent column readiness', () => {
    const result = capabilitySnapshot.parse(snapshot());
    expect(result.rows[0]?.codex.map(item => item.documentPath)).toEqual(['/skills/first/SKILL.md', '/skills/second/SKILL.md']);
    expect(result.columns.claude.phase).toBe('loading');
    expect(result.rows[0]?.codex[0]?.enabled).toBeNull();
  });
  it.each(['user', 'project', 'local', 'plugin', 'builtin', 'system', 'admin', 'extra', 'claude.ai', null])('preserves native scope %s', scope => {
    const value = snapshot();
    return expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], codex: [{ ...presence('first'), scope }] }] }).success).toBe(true);
  });
  it('rejects raw config/CLI fields instead of carrying secret extras across the wire', () => {
    const value = snapshot();
    for (const field of ['env', 'args', 'config', 'stdout', 'stderr', 'headers', 'transport']) {
      expect(capabilitySnapshot.safeParse({ ...value, [field]: 'FIXTURE_SECRET' }).success).toBe(false);
      expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], codex: [{ ...presence('first'), [field]: 'FIXTURE_SECRET' }] }] }).success).toBe(false);
    }
  });
  it('does not permit a transport/config locator or model availability on MCP/plugin rows', () => {
    const value = snapshot();
    for (const kind of ['mcp', 'plugin'])
      expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], kind }] }).success).toBe(false);
  });
  it('only exposes safe diagnostic codes and positions', () => {
    const value = snapshot();
    expect(capabilitySnapshot.safeParse({ ...value, columns: { ...value.columns, codex: { phase: 'error', diagnostics: [{ code: 'failed FIXTURE_SECRET', message: 'source' }] } } }).success).toBe(false);
  });
  it('adds get/refresh without changing legacy list and rejects undeclared Check/raw fields', () => {
    for (const method of ['capabilities.get', 'capabilities.refresh'] as const) {
      expect(METHODS[method].safeParse({ projectPath: '/project' }).success).toBe(true);
      expect(METHODS[method].safeParse({ projectPath: '' }).success).toBe(false);
      expect(METHODS[method].safeParse({ projectPath: '/project', check: true }).success).toBe(false);
    }
    expect(METHODS['capabilities.list'].safeParse({ projectPath: '/project', provider: 'claude' }).success).toBe(true);
    expectTypeOf<Result<'capabilities.get'>>().toEqualTypeOf<CapabilitySnapshot>();
    expectTypeOf<EventData<'capabilities.changed'>>().toEqualTypeOf<{ projectPath: string; snapshot: CapabilitySnapshot }>();
  });
});
