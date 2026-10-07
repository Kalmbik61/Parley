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


describe('MCP action availability wire', () => {
  const yes = { allowed: true, reason: null };
  const no = { allowed: false, reason: 'unverified' };
  const mcp = (provider: 'claude' | 'codex' = 'claude', scope: string | null = 'user') => {
    const value = snapshot();
    const target = { ...presence('mcp'), scope, documentPath: null, modelAvailable: null, unavailableReason: null,
      mcpActions: { remove: yes, check: provider === 'codex' ? no : yes } };
    return { ...value, rows: [{ ...value.rows[0], kind: 'mcp',
      claude: provider === 'claude' ? [target] : [], codex: provider === 'codex' ? [target] : [] }] };
  };
  it('advertises provider-specific scoped Add and opaque per-presence actions without native selectors', () => {
    const value = mcp();
    const result = capabilitySnapshot.parse({ ...value, columns: { ...value.columns,
      claude: { ...value.columns.claude, mcpAdd: { user: yes, project: yes, local: yes } },
      codex: { ...value.columns.codex, mcpAdd: { user: yes, project: { allowed: false, reason: 'unsupported-scope' }, local: { allowed: false, reason: 'unsupported-scope' } } },
    } });
    expect(result.columns.claude.mcpAdd?.project.allowed).toBe(true);
    expect(result.rows[0]?.claude[0]?.mcpActions?.remove.allowed).toBe(true);
    expect(capabilitySnapshot.safeParse(mcp('codex')).success).toBe(true);
  });
  it('rejects actions attached to skills/plugins and unsupported native sources', () => {
    for (const scope of ['builtin', 'system', 'admin', 'plugin', 'extra', 'claude.ai', null])
      expect(capabilitySnapshot.safeParse(mcp('claude', scope)).success).toBe(false);
    for (const scope of ['project', 'local']) expect(capabilitySnapshot.safeParse(mcp('codex', scope)).success).toBe(false);
    const value = snapshot();
    for (const kind of ['skill', 'plugin']) expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], kind,
      codex: [{ ...presence('first'), mcpActions: { remove: no, check: no } }] }] }).success).toBe(false);
  });
  it('rejects guessed Codex connection Check and project/local Add', () => {
    const value = mcp('codex');
    expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], codex: [{ ...value.rows[0]?.codex?.[0], mcpActions: { remove: yes, check: yes } }] }] }).success).toBe(false);
    for (const scope of ['project', 'local']) expect(capabilitySnapshot.safeParse({ ...value, columns: { ...value.columns,
      codex: { ...value.columns.codex, mcpAdd: { user: yes, project: no, local: no, [scope]: yes } } } }).success).toBe(false);
  });
  it('does not carry raw identity or error strings through action support', () => {
    const value = mcp();
    for (const action of [{ allowed: true, reason: 'unverified' }, { allowed: false, reason: null },
      { allowed: false, reason: 'FIXTURE_SECRET' }, { ...yes, nativeName: 'FIXTURE_SECRET' }, { ...no, message: 'FIXTURE_SECRET' }])
      expect(capabilitySnapshot.safeParse({ ...value, rows: [{ ...value.rows[0], claude: [{ ...value.rows[0]?.claude?.[0], mcpActions: { remove: action, check: no } }] }] }).success).toBe(false);
  });
});

describe('plugin action projection', () => {
  const yes = { allowed: true, reason: null };
  const no = { allowed: false, reason: 'unverified' };
  const plugin = (provider: 'claude' | 'codex', scope: string | null, actions: Record<'uninstall' | 'enable' | 'disable' | 'details', { allowed: boolean; reason: string | null }> = { uninstall: yes, enable: no, disable: no, details: no }) => ({
    projectPath: '/project', revision: 1, columns: { claude: { phase: 'ready', diagnostics: [] }, codex: { phase: 'ready', diagnostics: [] } },
    rows: [{ id: 'opaque', kind: 'plugin', name: 'fixture@market', description: null, separateCopies: false,
      claude: provider === 'claude' ? [{ ...presence('opaque'), scope, documentPath: null, modelAvailable: null, unavailableReason: null, pluginActions: actions }] : [],
      codex: provider === 'codex' ? [{ ...presence('opaque'), scope, documentPath: null, modelAvailable: null, unavailableReason: null, pluginActions: actions }] : [] }],
  });
  it('admits positively owned human sources and retains denied unknown sources', () => {
    for (const scope of ['user', 'project', 'local']) expect(capabilitySnapshot.safeParse(plugin('claude', scope)).success).toBe(true);
    expect(capabilitySnapshot.safeParse(plugin('codex', 'user')).success).toBe(true);
    expect(capabilitySnapshot.safeParse(plugin('claude', null, { uninstall: no, enable: no, disable: no, details: no })).success).toBe(true);
  });
  it('rejects privileged/unknown targets and Codex unsupported native actions', () => {
    for (const scope of ['builtin', 'admin', 'system', 'claude.ai', null]) expect(capabilitySnapshot.safeParse(plugin('claude', scope)).success).toBe(false);
    for (const scope of ['project', 'local']) expect(capabilitySnapshot.safeParse(plugin('codex', scope)).success).toBe(false);
    for (const kind of ['enable', 'disable', 'details']) expect(capabilitySnapshot.safeParse(plugin('codex', 'user', { uninstall: yes, enable: no, disable: no, details: no, [kind]: yes })).success).toBe(false);
  });
  it('keeps raw selector/output fields outside nested action support', () => {
    const value = plugin('claude', 'user');
    value.rows[0]!.claude[0]!.pluginActions.uninstall = { ...yes, nativeId: 'SECRET_FIXTURE' } as typeof yes;
    expect(capabilitySnapshot.safeParse(value).success).toBe(false);
  });
});


describe('manual skill sharing projection', () => {
 const yes={allowed:true,reason:null},no={allowed:false,reason:'unverified'};
 const skill=(scope:string|null='project',separateCopies=false)=>{const value=snapshot();return{...value,rows:[{...value.rows[0],separateCopies,codex:[{...presence('owned'),scope,skillActions:{share:yes,unshare:no}}]}]};};
 it('keeps optional manual actions separate from native availability and preserves old snapshots',()=>{
  expect(capabilitySnapshot.safeParse(snapshot()).success).toBe(true);
  const value=capabilitySnapshot.parse(skill());expect(value.rows[0]?.codex[0]?.modelAvailable).toBe(false);expect(value.rows[0]?.codex[0]?.skillActions?.share.allowed).toBe(true);
  for(const scope of ['user','project'])expect(capabilitySnapshot.safeParse(skill(scope)).success).toBe(true);
  for(const scope of ['builtin','system','admin','plugin','extra','local',null])expect(capabilitySnapshot.safeParse(skill(scope)).success).toBe(false);
  expect(capabilitySnapshot.safeParse(skill('project',true)).success).toBe(false);
 });
 it('refuses callable actions on non-skills and raw receipt/native-proof fields',()=>{
  const value=skill();for(const kind of ['mcp','plugin'])expect(capabilitySnapshot.safeParse({...value,rows:[{...value.rows[0],kind}]}).success).toBe(false);
  for(const field of ['receipt','sourceIdentity','nativeSkill','contentHash'])expect(capabilitySnapshot.safeParse({...value,rows:[{...value.rows[0],codex:[{...value.rows[0]!.codex[0],[field]:'/secret'}]}]}).success).toBe(false);
 });
});
