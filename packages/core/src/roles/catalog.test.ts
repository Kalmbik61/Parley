import { describe, expect, it } from 'vitest';
import { buildRoleCatalog, resolveRoleChoice } from './catalog.js';
import type { ClaudeRole, CodexRole, RoleCatalog } from './types.js';
const codex: CodexRole = {
  id: 'codex:reviewer',
  source: 'codex',
  name: 'reviewer',
  description: 'Native review',
  provider: 'codex',
  readOnly: true,
  path: '/fixture/reviewer.toml',
  prompt: 'Inspect the change.',
  model: 'native-model',
  effort: 'xhigh',
  sandboxMode: 'read-only',
};
const claude: ClaudeRole = {
  id: 'claude:reviewer',
  source: 'claude',
  name: 'reviewer',
  description: 'Native review',
  provider: 'claude',
  readOnly: false,
  path: '/fixture/reviewer.md',
  nativeAgent: 'reviewer',
};
const native = (roles: RoleCatalog['roles']): RoleCatalog => ({
  roles,
  diagnostics: [],
  partial: false,
});
describe('role catalog and selection', () => {
  it('keeps qualified native/builtin collisions distinct and deterministically ordered', () => {
    const result = buildRoleCatalog(native([codex, claude]));
    expect(
      result.roles.filter((role) => role.id.endsWith(':reviewer')).map((role) => role.id),
    ).toEqual(['builtin:reviewer', 'claude:reviewer', 'codex:reviewer']);
    expect(new Set(result.roles.map((role) => role.id)).size).toBe(10);
    expect(result.partial).toBe(false);
  });
  it('rejects an ambiguous same-source identity without choosing a guessed winner', () => {
    const result = buildRoleCatalog(native([codex, { ...codex, path: '/other/file.toml' }]));
    expect(result.roles.find((role) => role.id === codex.id)).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === 'duplicate-role')).toBe(true);
    expect(result.partial).toBe(true);
  });
  it('does not allow consumers to mutate the shared builtin catalog through a snapshot', () => {
    const first = buildRoleCatalog();
    const role = first.roles.find((item) => item.id === 'builtin:reviewer');
    if (role) role.readOnly = false;
    expect(buildRoleCatalog().roles.find((item) => item.id === 'builtin:reviewer')?.readOnly).toBe(
      true,
    );
  });
  it('uses role defaults without converting them into explicit human settings', () => {
    const choice = { roleId: 'builtin:reviewer' };
    const resolved = resolveRoleChoice(buildRoleCatalog(), choice);
    expect(resolved).toMatchObject({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      readOnly: true,
      sandboxMode: 'read-only',
    });
    expect(resolved.roleText).toMatch(
      /^Your role in this workspace: Reviewer \(builtin:reviewer\)\./,
    );
    expect(choice).toEqual({ roleId: 'builtin:reviewer' });
  });
  it('lets the human choose a provider and model/effort above builtin defaults', () => {
    const result = resolveRoleChoice(buildRoleCatalog(), {
      roleId: 'builtin:reviewer',
      provider: 'claude',
      model: 'sonnet',
      effort: 'low',
    });
    expect(result).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      effort: 'low',
      readOnly: true,
    });
    expect(
      resolveRoleChoice(buildRoleCatalog(), { roleId: 'builtin:reviewer', provider: 'claude' })
        .model,
    ).toBe('opus');
    expect(
      resolveRoleChoice(buildRoleCatalog(), {
        roleId: 'builtin:reviewer',
        model: null,
        effort: null,
      }),
    ).toMatchObject({ model: null, effort: null });
  });
  it('preserves native Codex fields and rejects a different CLI', () => {
    const catalog = buildRoleCatalog(native([codex]));
    expect(resolveRoleChoice(catalog, { roleId: codex.id })).toMatchObject({
      provider: 'codex',
      model: 'native-model',
      effort: 'xhigh',
      sandboxMode: 'read-only',
      readOnly: true,
    });
    expect(
      resolveRoleChoice(catalog, { roleId: codex.id, model: 'human-model', effort: 'low' }),
    ).toMatchObject({ model: 'human-model', effort: 'low', sandboxMode: 'read-only' });
    expect(() => resolveRoleChoice(catalog, { roleId: codex.id, provider: 'claude' })).toThrow(
      /role-provider-mismatch/,
    );
  });
  it('a native Claude role fits any provider of the Claude Code family, named by the caller; Codex roles never', () => {
    const catalog = buildRoleCatalog(native([claude, codex]));
    // Без пометки семейства — прежнее правило: роль Claude только у `claude`.
    expect(() => resolveRoleChoice(catalog, { roleId: claude.id, provider: 'glm' })).toThrow(/role-provider-mismatch/);
    expect(resolveRoleChoice(catalog, { roleId: claude.id, provider: 'glm', claudeCode: true })).toMatchObject({
      provider: 'glm',
      nativeAgent: 'reviewer',
      model: null,
      effort: null,
    });
    // Пометка семейства не открывает роли Codex и не спасает от чужого CLI.
    expect(() => resolveRoleChoice(catalog, { roleId: codex.id, provider: 'glm', claudeCode: true })).toThrow(/role-provider-mismatch/);
    expect(() => resolveRoleChoice(catalog, { roleId: claude.id, provider: 'codex' })).toThrow(/role-provider-mismatch/);
  });
  it('uses Claude --agent identity without copying native body/defaults into the layer', () => {
    const resolved = resolveRoleChoice(buildRoleCatalog(native([claude])), { roleId: claude.id });
    expect(resolved).toMatchObject({
      nativeAgent: 'reviewer',
      roleText: '',
      model: null,
      effort: null,
    });
  });
  it('rejects missing explicit creation roles; existing missing roles preserve human settings and required permissions', () => {
    const catalog = buildRoleCatalog();
    expect(() => resolveRoleChoice(catalog, { roleId: 'codex:gone' })).toThrow(/role-missing/);
    const result = resolveRoleChoice(catalog, {
      roleId: 'codex:gone',
      mode: 'existing',
      provider: 'codex',
      model: 'human',
      effort: 'high',
      requiredPermissions: { readOnly: true, sandboxMode: 'read-only' },
    });
    expect(result).toMatchObject({
      role: null,
      roleText: '',
      provider: 'codex',
      model: 'human',
      effort: 'high',
      readOnly: true,
      sandboxMode: 'read-only',
    });
    expect(result.warnings).toEqual([{ code: 'role-missing', roleId: 'codex:gone' }]);
    expect(() =>
      resolveRoleChoice(catalog, {
        roleId: 'claude:gone',
        mode: 'existing',
        requiredPermissions: { nativeAgentRequired: true },
      }),
    ).toThrow(/role-permissions-unavailable/);
  });
  it('drops a removed role and uses provider defaults unless the human explicitly chose values', () => {
    const result = resolveRoleChoice(buildRoleCatalog(), {
      roleId: 'builtin:removed',
      mode: 'existing',
      providerDefaults: { provider: 'codex', model: 'provider-default', effort: 'medium' },
    });
    expect(result).toMatchObject({
      role: null,
      roleText: '',
      provider: 'codex',
      model: 'provider-default',
      effort: 'medium',
      readOnly: false,
      sandboxMode: null,
    });
    expect(
      resolveRoleChoice(buildRoleCatalog(), {
        roleId: 'builtin:removed',
        mode: 'existing',
        model: null,
        effort: null,
        providerDefaults: { provider: 'codex', model: 'provider-default', effort: 'medium' },
      }),
    ).toMatchObject({ model: null, effort: null });
  });

  it('keeps required permissions when a role changed to a less restrictive file', () => {
    const relaxed = { ...codex, readOnly: false, sandboxMode: 'workspace-write' as const };
    expect(
      resolveRoleChoice(buildRoleCatalog(native([relaxed])), {
        roleId: codex.id,
        requiredPermissions: { readOnly: true, sandboxMode: 'read-only' },
      }),
    ).toMatchObject({ readOnly: true, sandboxMode: 'read-only' });
  });
  it('uses provider defaults without a role and does not invent a model tier for custom providers', () => {
    expect(
      resolveRoleChoice(buildRoleCatalog(), {
        providerDefaults: { provider: 'codex', model: 'provider-model', effort: 'medium' },
      }),
    ).toMatchObject({
      role: null,
      provider: 'codex',
      model: 'provider-model',
      effort: 'medium',
      readOnly: false,
    });
    expect(
      resolveRoleChoice(buildRoleCatalog(), { roleId: 'builtin:executor', provider: 'glm' }).model,
    ).toBeNull();
  });
  it('refuses to apply native Codex defaults from an incomplete native layer context', () => {
    const catalog = buildRoleCatalog({
      roles: [codex],
      diagnostics: [{ source: 'codex', code: 'context-unverified' }],
      partial: true,
    });
    expect(() => resolveRoleChoice(catalog, { roleId: codex.id })).toThrow(
      /role-context-unverified/,
    );
    expect(resolveRoleChoice(catalog, { roleId: 'builtin:reviewer' }).readOnly).toBe(true);
  });
});
