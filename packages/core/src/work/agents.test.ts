import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentDirs, assertAgent, listAgents, prepareSessionRole, roleForProvider, roleChangeOnSwitch, sessionRoleCatalog, assertRoleDelivery, projectSkillRunnerContext, roleProvider, roleModel } from './agents.js';
import { PROVIDERS } from '../providers.js';
import { modelForTier } from '../roles/builtin.js';
import { OPENCODE_FAMILY_ENTRY } from '../../test/family-fixtures.js';
import { buildRoleCatalog, resolveRoleChoice } from '../roles/catalog.js';
let project = '', claudeHome = '';
async function defineAgent(dir: string, filename: string, name = filename): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${filename}.md`), `---\nname: ${JSON.stringify(name)}\ndescription: Session role\n---\nRole body.\n`);
}
beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeHome = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
});
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all([project, claudeHome].map(dir => rm(dir, { recursive: true, force: true }))); });
describe('native agent compatibility', () => {
  it('uses exact metadata identity, never filename or an invented path selector', async () => {
    const [local, user] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(local, 'arbitrary', 'review docs');
    await defineAgent(user, 'other', 'Проверка');
    await defineAgent(local, 'path-data', '../exact data');
    expect(await listAgents(agentDirs(project, claudeHome))).toEqual(['../exact data', 'review docs', 'Проверка']);
    await expect(assertAgent('review docs', agentDirs(project, claudeHome))).resolves.toBeUndefined();
    await expect(assertAgent('../exact data', agentDirs(project, claudeHome))).resolves.toBeUndefined();
    await expect(assertAgent('arbitrary', agentDirs(project, claudeHome))).rejects.toThrow('does not exist');
  });
  it('claims ambiguous project identity without falling back to the user role', async () => {
    const [local, user] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(local, 'one', 'reviewer'); await defineAgent(local, 'two', 'reviewer');
    await defineAgent(user, 'fallback', 'reviewer');
    expect(await listAgents(agentDirs(project, claudeHome))).toEqual([]);
    await expect(assertAgent('reviewer', agentDirs(project, claudeHome))).rejects.toThrow('does not exist');
  });
  it('does not invent identity for missing metadata or missing participant cwd', async () => {
    const [local] = agentDirs(project, claudeHome) as [string];
    await mkdir(local, { recursive: true }); await writeFile(path.join(local, 'filename.md'), '# body');
    expect(await listAgents(agentDirs(project, claudeHome))).toEqual([]);
    expect(await listAgents(agentDirs(path.join(project, 'absent'), claudeHome))).toEqual([]);
  });
});
describe('mandatory role delivery', () => {
  it.each(['claude', 'codex'] as const)('delivers Feature Lead with read-only permissions on %s', async provider => {
    await expect(prepareSessionRole(project, PROVIDERS[provider], { roleId: 'builtin:feature-lead', provider })).resolves.toMatchObject({
      readOnly: true, roleText: expect.stringContaining('Do not modify application code, tests, scripts or configuration'),
    });
  });
  it('requires both start and resume text and read-only channels before creation', async () => {
    const choice = { roleId: 'builtin:planner', provider: 'claude', mode: 'create' as const };
    await expect(prepareSessionRole(project, PROVIDERS.claude, choice)).resolves.toMatchObject({ readOnly: true, model: 'opus' });
    const custom = { ...PROVIDERS.claude, runner: { ...PROVIDERS.claude.runner, resumeArgs: ['--resume', '{providerSessionId}', '{systemPrompt}'] } };
    await expect(prepareSessionRole(project, custom, choice)).rejects.toThrow('role-permissions-unavailable');
    // GLM — Claude Code: у встроенной записи «только чтение» доходит флагом `--disallowedTools` (роли GLM, 2026-10-07).
    await expect(prepareSessionRole(project, PROVIDERS.glm, { ...choice, provider: 'glm' })).resolves.toMatchObject({ readOnly: true, provider: 'glm', model: null });
  });
  it('refuses a foreign sandbox constraint rather than silently dropping it', async () => {
    await expect(prepareSessionRole(project, PROVIDERS.claude, { requiredPermissions: { sandboxMode: 'workspace-write' } })).rejects.toThrow('role-permissions-unavailable');
  });
  it('removed roles do not retain cached defaults, but explicit mandatory permissions remain', async () => {
    const catalog = buildRoleCatalog();
    await expect(prepareSessionRole(project, PROVIDERS.claude, { roleId: 'claude:removed', mode: 'existing', model: 'sonnet' }, catalog)).resolves.toMatchObject({ role: null, model: 'sonnet', readOnly: false });
    await expect(prepareSessionRole(project, PROVIDERS.claude, { roleId: 'claude:removed', mode: 'existing', requiredPermissions: { nativeAgentRequired: true } }, catalog)).rejects.toThrow('role-permissions-unavailable');
  });
});

describe('роли Claude у GLM: конфигурация GLM — ~/.claude, а не CLAUDE_CONFIG_DIR хоста', () => {
  /** Домашняя папка с агентом `from-home` и `CLAUDE_CONFIG_DIR` хоста с агентом `from-config`. */
  async function homes(): Promise<{ homeDir: string; env: NodeJS.ProcessEnv }> {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    await defineAgent(path.join(homeDir, '.claude', 'agents'), 'from-home');
    await defineAgent(path.join(claudeHome, 'agents'), 'from-config');
    return { homeDir, env: { CLAUDE_CONFIG_DIR: claudeHome } };
  }
  it('sessionRoleCatalog: у GLM каталог из ~/.claude, у Claude — из CLAUDE_CONFIG_DIR', async () => {
    const { homeDir, env } = await homes();
    try {
      const names = async (provider?: typeof PROVIDERS.claude) =>
        (await sessionRoleCatalog(project, { homeDir, env, ...(provider ? { provider } : {}) })).roles.filter(role => role.source === 'claude').map(role => role.name);
      expect(await names(PROVIDERS.glm)).toEqual(['from-home']);
      expect(await names(PROVIDERS.claude)).toEqual(['from-config']);
      // Без провайдера — как раньше: окружение вызывающего.
      expect(await names()).toEqual(['from-config']);
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
  it('prepareSessionRole: нативная роль Claude доходит до GLM из его конфигурации, а роль конфигурации хоста — role-missing', async () => {
    const { homeDir } = await homes();
    vi.stubEnv('HOME', homeDir); vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    try {
      await expect(prepareSessionRole(project, PROVIDERS.glm, { roleId: 'claude:from-home', provider: 'glm', mode: 'create' }))
        .resolves.toMatchObject({ provider: 'glm', nativeAgent: 'from-home', model: null, effort: null });
      await expect(prepareSessionRole(project, PROVIDERS.glm, { roleId: 'claude:from-config', provider: 'glm', mode: 'create' })).rejects.toThrow('role-missing');
      // Claude остаётся на CLAUDE_CONFIG_DIR.
      await expect(prepareSessionRole(project, PROVIDERS.claude, { roleId: 'claude:from-config', provider: 'claude', mode: 'create' })).resolves.toMatchObject({ nativeAgent: 'from-config' });
      await expect(prepareSessionRole(project, PROVIDERS.claude, { roleId: 'claude:from-home', provider: 'claude', mode: 'create' })).rejects.toThrow('role-missing');
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
  it('нативный агент у GLM нужен шаблон с парой --agent {agent}; Codex роли Claude по-прежнему отказывает', async () => {
    const catalog = buildRoleCatalog({ roles: [{ id: 'claude:exact', source: 'claude', provider: 'claude', name: 'exact', nativeAgent: 'exact', description: '', path: '/fixture.md', readOnly: false }], diagnostics: [], partial: false });
    await expect(prepareSessionRole(project, PROVIDERS.glm, { roleId: 'claude:exact', provider: 'glm' }, catalog)).resolves.toMatchObject({ nativeAgent: 'exact' });
    const template = ['--append-system-prompt', '{systemPrompt}', '{prompt}'];
    const bare = { ...PROVIDERS.glm, runner: { ...PROVIDERS.glm.runner, args: template, resumeArgs: template } };
    await expect(prepareSessionRole(project, bare, { roleId: 'claude:exact', provider: 'glm' }, catalog)).rejects.toThrow('role-permissions-unavailable');
    await expect(prepareSessionRole(project, PROVIDERS.codex, { roleId: 'claude:exact', provider: 'codex' }, catalog)).rejects.toThrow('role-provider-mismatch');
  });
});

describe('roleForProvider', () => {
  const claudeArchitect = { id: 'claude:architect', source: 'claude', provider: 'claude', name: 'architect', nativeAgent: 'architect', description: '', path: '/fixture.md', readOnly: false } as const;
  const codexArchitect = { id: 'codex:architect', source: 'codex', provider: 'codex', name: 'architect', description: '', path: '/fixture.toml', prompt: 'Architect.', model: null, effort: null, sandboxMode: null, readOnly: false } as const;
  const both = buildRoleCatalog({ roles: [codexArchitect, claudeArchitect], diagnostics: [], partial: false });
  const onlyCodex = buildRoleCatalog({ roles: [codexArchitect], diagnostics: [], partial: false });

  it('одноимённая роль цели, иначе без роли', async () => {
    expect(await roleForProvider(project, PROVIDERS.claude, { source: 'codex', name: 'architect' }, both)).toEqual({ source: 'claude', name: 'architect' });
    expect(await roleForProvider(project, PROVIDERS.claude, { source: 'codex', name: 'architect' }, onlyCodex)).toBeNull();
    expect(await roleForProvider(project, PROVIDERS.codex, { source: 'builtin', name: 'architect' }, both)).toEqual({ source: 'builtin', name: 'architect' });
    expect(await roleForProvider(project, PROVIDERS.codex, null, both)).toBeNull();
    // Роль Claude на Codex: одноимённой роли Codex нет в каталоге, значит без роли.
    expect(await roleForProvider(project, PROVIDERS.codex, { source: 'claude', name: 'architect' }, onlyCodex)).toEqual({ source: 'codex', name: 'architect' });
    expect(await roleForProvider(project, PROVIDERS.codex, { source: 'claude', name: 'architect' }, buildRoleCatalog({ roles: [claudeArchitect], diagnostics: [], partial: false }))).toBeNull();
  });

  it('роль Claude остаётся на записи семейства Claude Code (GLM)', async () => {
    expect(await roleForProvider(project, PROVIDERS.glm, { source: 'claude', name: 'architect' }, both)).toEqual({ source: 'claude', name: 'architect' });
  });

  it('результат всегда запускаем: null или роль, которую prepareSessionRole принимает', async () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
      for (const definition of both.roles) {
        const role = { source: definition.source, name: definition.name };
        const result = await roleForProvider(project, entry, role, both);
        if (result === null) continue;
        await expect(prepareSessionRole(project, entry, { roleId: `${result.source}:${result.name}`, provider: entry.id, mode: 'existing' }, both), `${entry.id} ${definition.id}`).resolves.toBeDefined();
      }
    }
  });
});

describe('native runner context consistency', () => {
  it('uses the actual binary/env override and refuses divergent resume config without invoking transport', async () => {
    vi.stubEnv('PARLEY_HOME', project);
    const input = { cwd: '', command: '' };
    let calls = 0;
    const context = async (options: { cwd: string; command?: string }) => { calls++; input.cwd = options.cwd; input.command = options.command ?? ''; return { verified: true, layers: [], diagnostics: [] }; };
    const env = { PARLEY_CODEX_BIN: process.execPath, PATH: '', CLAUDE_CONFIG_DIR: claudeHome };
    const supported = await sessionRoleCatalog(project, { codex: true, homeDir: project, env, context });
    expect(calls).toBe(1); expect(input).toEqual({ cwd: project, command: process.execPath });
    expect(supported.diagnostics.some(item => item.code === 'context-unverified')).toBe(false);
    await writeFile(path.join(project, 'providers.json'), JSON.stringify({ codex: { resumeArgs: ['resume', '{providerSessionId}', '-c', 'agents.enabled=false', '{prompt}'] } }));
    const unverified = await sessionRoleCatalog(project, { codex: true, homeDir: project, env, context });
    expect(calls).toBe(1); expect(unverified.diagnostics).toContainEqual({ source: 'codex', code: 'context-unverified' });
  });
  it.each(['--cd', '-C', '--profile', '-p', '--permissions', '--sandbox=workspace-write', '--dangerously-bypass-approvals-and-sandbox'])('does not guess the native context for unsupported runner options (%s)', async flag => {
    vi.stubEnv('PARLEY_HOME', project);
    await writeFile(path.join(project, 'providers.json'), JSON.stringify({ codex: { args: [flag, 'value'] } }));
    let called = false;
    const result = await sessionRoleCatalog(project, { codex: true, homeDir: project, env: { PARLEY_CODEX_BIN: process.execPath, CLAUDE_CONFIG_DIR: claudeHome }, context: async () => { called = true; return { verified: true, layers: [], diagnostics: [] }; } });
    expect(called).toBe(false); expect(result.diagnostics.some(item => item.code === 'context-unverified')).toBe(true);
  });
  it.each(['--sandbox', '-s', '--sandbox=workspace-write', '-sdanger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me', '--not-so-yolo', 'sandbox_mode="danger-full-access"', 'permissions.default="custom"', '--config=sandbox_mode="danger-full-access"', '-csandbox_mode="danger-full-access"', '--config=permissions.default="custom"', '-cpermissions.default="custom"'])('refuses mandatory sandbox conflicts for builtin roles but preserves plain runners (%s)', async literal => {
    const entry = { ...PROVIDERS.codex, runner: { ...PROVIDERS.codex.runner, args: [...PROVIDERS.codex.runner.args!, literal] } };
    await expect(prepareSessionRole(project, entry, { provider: 'codex', roleId: 'builtin:planner' })).rejects.toThrow('role-permissions-unavailable');
    // Сессия без роли: `workspace-write` — умолчание Parley, а не требование роли, поэтому конфликт с флагами раннера не отказывает.
    await expect(prepareSessionRole(project, entry, { provider: 'codex' })).resolves.toMatchObject({ role: null, readOnly: false, sandboxMode: 'workspace-write' });
  });
  it('умолчание workspace-write не требует {sandbox} у своего раннера; своя песочница роли из .codex/agents — требует', async () => {
    const template = ['-c', '{mcpConfig}', '-c', '{developerInstructions}', '{prompt}'];
    const entry = { ...PROVIDERS.codex, runner: { ...PROVIDERS.codex.runner, args: template, resumeArgs: template } };
    await expect(prepareSessionRole(project, entry, { provider: 'codex' })).resolves.toMatchObject({ sandboxMode: 'workspace-write' });
    const own = buildRoleCatalog({ roles: [{ id: 'codex:own', source: 'codex', provider: 'codex', name: 'own', description: '', path: '/fixture.toml', prompt: 'Own.', model: null, effort: null, sandboxMode: 'workspace-write', readOnly: false }], diagnostics: [], partial: false });
    await expect(prepareSessionRole(project, entry, { provider: 'codex', roleId: 'codex:own' }, own)).rejects.toThrow('role-permissions-unavailable');
    await expect(prepareSessionRole(project, PROVIDERS.codex, { provider: 'codex', roleId: 'codex:own' }, own)).resolves.toMatchObject({ sandboxMode: 'workspace-write' });
  });
});


describe('native existing-role context gate', () => {
  it.each(['context-unverified', 'unsupported-config'] as const)('refuses %s before removed-role fallback', async code => {
    const catalog = buildRoleCatalog({ roles: [], diagnostics: [{ source: 'codex', code }], partial: true });
    await expect(prepareSessionRole(project, PROVIDERS.codex, { roleId: 'codex:removed', mode: 'existing' }, catalog)).rejects.toThrow('role-context-unverified');
  });
  it('preserves the confirmed removed-definition fallback in a verified context', async () => {
    const catalog = buildRoleCatalog();
    await expect(prepareSessionRole(project, PROVIDERS.codex, { roleId: 'codex:removed', mode: 'existing' }, catalog)).resolves.toMatchObject({ role: null, readOnly: false, warnings: [{ code: 'role-missing', roleId: 'codex:removed' }] });
  });
});


describe('mandatory native option/value pairing', () => {
  const cases = [
    { provider: 'codex', roleId: 'builtin:planner', template: ['-c', '{developerInstructions}', '{sandbox}', '{prompt}'], channel: 'positional sandbox' },
    { provider: 'codex', roleId: 'builtin:planner', template: ['--model', '{developerInstructions}', '-c', '{sandbox}', '{prompt}'], channel: 'developer text as model' },
    { provider: 'codex', roleId: 'builtin:planner', template: ['--', '-c', '{developerInstructions}', '-c', '{sandbox}', '{prompt}'], channel: 'option terminator' },
    { provider: 'codex', roleId: 'builtin:planner', template: ['--model', '-c', '{sandbox}', '-c', '{developerInstructions}', '{prompt}'], channel: 'config flag consumed as model' },
    { provider: 'codex', roleId: 'builtin:planner', template: ['-c', '{developerInstructions}', '-c', '{sandbox}', '-c', '{sandbox}', '{prompt}'], channel: 'duplicate sandbox channel' },
    { provider: 'codex', roleId: 'builtin:planner', template: ['-c', '{developerInstructions}', '-c', 'developer_instructions="other"', '-c', '{sandbox}', '{prompt}'], channel: 'literal developer overwrite' },
    { provider: 'claude', roleId: 'builtin:planner', template: ['--settings', '{systemPrompt}', '--disallowedTools', '{disallowedTools}', '{prompt}'], channel: 'system text as settings' },
    { provider: 'claude', roleId: 'builtin:planner', template: ['--append-system-prompt', '{systemPrompt}', '--model', '{disallowedTools}', '{prompt}'], channel: 'disallowed tools as model' },
    { provider: 'claude', roleId: 'builtin:planner', template: ['--append-system-prompt', '{systemPrompt}', '--disallowedTools', '{disallowedTools}', '--disallowedTools', 'Other', '{prompt}'], channel: 'duplicate disallowed tools' },
    { provider: 'claude', roleId: 'claude:exact', template: ['--settings', '{agent}', '{prompt}'], channel: 'native identity as settings' },
    { provider: 'claude', roleId: 'claude:exact', template: ['--', '--agent', '{agent}', '{prompt}'], channel: 'native identity after terminator' },
    { provider: 'claude', roleId: 'claude:exact', template: ['--agent', '{agent}', '--agent', 'other', '{prompt}'], channel: 'native identity overwritten' },
    { provider: 'claude', roleId: 'builtin:planner', template: ['--unknown', '--append-system-prompt', '{systemPrompt}', '--disallowedTools', '{disallowedTools}', '{prompt}'], channel: 'unknown flag arity' },
  ] as const;
  const native = buildRoleCatalog({ roles: [{ id: 'claude:exact', source: 'claude', provider: 'claude', name: 'exact', nativeAgent: 'exact', description: 'Native role', path: '/fixture.md', readOnly: false }], diagnostics: [], partial: false });
  it.each(cases.flatMap(item => ['args', 'resumeArgs'].map(mode => ({ ...item, mode }))))('refuses $channel in $mode before creation and preserves no-role compatibility', async ({ provider, roleId, template, mode }) => {
    const original = PROVIDERS[provider];
    const entry = { ...original, runner: { ...original.runner, [mode]: [...template] } };
    await expect(prepareSessionRole(project, entry, { roleId, provider, mode: 'create' }, native)).rejects.toThrow('role-permissions-unavailable');
    // planLaunch/planResume revalidate precisely their active template with this same guard.
    expect(() => assertRoleDelivery(entry, resolveRoleChoice(native, { roleId, provider }), [[...template]])).toThrow('role-permissions-unavailable');
    await expect(prepareSessionRole(project, entry, { provider }, native)).resolves.toMatchObject({ role: null, readOnly: false });
  });
  it.each(['claude', 'codex'] as const)('proves every actual default start/resume template (%s)', async provider => {
    await expect(prepareSessionRole(project, PROVIDERS[provider], { roleId: 'builtin:planner', provider }, native)).resolves.toMatchObject({ readOnly: true });
  });
});


describe('explicit Claude-like custom role text compatibility', () => {
  it.each(['glm', 'custom-claude'])('supports non-readonly builtin text via declared native layer syntax (%s)', async provider => {
    const entry = { ...PROVIDERS.glm, id: provider, runner: { ...PROVIDERS.glm.runner, args: ['--append-system-prompt', '{systemPrompt}', '{prompt}'], resumeArgs: ['--resume', '{providerSessionId}', '--append-system-prompt', '{systemPrompt}', '{prompt}'] } };
    await expect(prepareSessionRole(project, entry, { provider, roleId: 'builtin:executor' })).resolves.toMatchObject({ readOnly: false, roleText: expect.stringContaining('builtin:executor') });
  });
  it('does not infer readonly permissions for a custom provider without the Claude Code family', async () => {
    // Своя запись `providers.json` не может задать `family`: даже шаблон Claude не доказывает, что `--disallowedTools` понятен.
    const custom = { ...PROVIDERS.glm };
    delete custom.family;
    const template = ['--append-system-prompt', '{systemPrompt}', '--disallowedTools', '{disallowedTools}', '{prompt}'];
    const entry = { ...custom, id: 'custom-claude', runner: { ...custom.runner, args: template, resumeArgs: template } };
    await expect(prepareSessionRole(project, entry, { provider: 'custom-claude', roleId: 'builtin:planner' })).rejects.toThrow('role-permissions-unavailable');
  });
  it('glm: readonly goes through --disallowedTools in start and resume; a replacement without {disallowedTools} still refuses', async () => {
    const choice = { provider: 'glm', roleId: 'builtin:planner' };
    for (const template of [PROVIDERS.glm.runner.args!, PROVIDERS.glm.runner.resumeArgs!])
      expect(template.slice(template.indexOf('--disallowedTools'), template.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', '{disallowedTools}']);
    await expect(prepareSessionRole(project, PROVIDERS.glm, choice)).resolves.toMatchObject({ readOnly: true });
    const without = (template: readonly string[]) => template.filter((item, i) => item !== '--disallowedTools' && template[i - 1] !== '--disallowedTools');
    for (const mode of ['args', 'resumeArgs'] as const) {
      const entry = { ...PROVIDERS.glm, runner: { ...PROVIDERS.glm.runner, [mode]: without(PROVIDERS.glm.runner[mode]!) } };
      await expect(prepareSessionRole(project, entry, choice)).rejects.toThrow('role-permissions-unavailable');
      // Без «только чтения» та же подмена принимает встроенную роль: текстовый канал остался.
      await expect(prepareSessionRole(project, entry, { provider: 'glm', roleId: 'builtin:executor' })).resolves.toMatchObject({ readOnly: false });
    }
  });
});


describe('native Claude common layer position', () => {
  const catalog = buildRoleCatalog({ roles: [{ id: 'claude:exact', source: 'claude', provider: 'claude', name: 'exact', nativeAgent: 'exact', description: '', path: '/fixture.md', readOnly: false }], diagnostics: [], partial: false });
  it.each(['args', 'resumeArgs'])('refuses present common text in the wrong native option (%s)', async mode => {
    const entry = { ...PROVIDERS.claude, runner: { ...PROVIDERS.claude.runner, [mode]: ['--agent', '{agent}', '--settings', '{systemPrompt}', '{prompt}'] } };
    await expect(prepareSessionRole(project, entry, { roleId: 'claude:exact', provider: 'claude' }, catalog)).rejects.toThrow('role-permissions-unavailable');
  });
  it('keeps the native body exclusively on --agent when the common append layer is absent', async () => {
    const entry = { ...PROVIDERS.claude, runner: { ...PROVIDERS.claude.runner, args: ['--agent', '{agent}', '{prompt}'], resumeArgs: ['--resume', '{providerSessionId}', '--agent', '{agent}', '{prompt}'] } };
    await expect(prepareSessionRole(project, entry, { roleId: 'claude:exact', provider: 'claude' }, catalog)).resolves.toMatchObject({ nativeAgent: 'exact', roleText: '' });
  });
});


describe('chosen native runner context projection', () => {
  it('supports actual default start/resume templates without reading a fresh registry', () => {
    for (const template of [PROVIDERS.codex.runner.args!, PROVIDERS.codex.runner.resumeArgs!])
      expect(projectSkillRunnerContext(PROVIDERS.codex, template)).toEqual({ verified: true, configArgs: [] });
  });
  it('{approvals} и {trust} — служебные подстановки Parley: проверка контекста остаётся, в снимок они не попадают', () => {
    const template = ['--no-daemon', '-c', '{mcpConfig}', '-c', '{sandbox}', '{approvals}', '{trust}', '{codexHooks}', '{prompt}'];
    expect(projectSkillRunnerContext(PROVIDERS.codex, template)).toEqual({ verified: true, configArgs: [] });
    expect(projectSkillRunnerContext(PROVIDERS.codex, ['resume', '{providerSessionId}', '-c', '{sandbox}', '{approvals}', '{trust}', '{prompt}']))
      .toEqual({ verified: true, configArgs: [] });
  });
  it('extraConfigArgs (доверие к папке) дописываются после проекции; у непроверенного шаблона их нет', () => {
    const trust = ['-c', 'projects={"/p"={trust_level="trusted"}}'];
    expect(projectSkillRunnerContext(PROVIDERS.codex, PROVIDERS.codex.runner.args!, trust)).toEqual({ verified: true, configArgs: trust });
    const template = ['-c', 'skills.config=[{name="review",enabled=false}]', '{prompt}'];
    expect(projectSkillRunnerContext(PROVIDERS.codex, template, trust)).toEqual({ verified: true,
      configArgs: ['-c', 'skills.config=[{name="review",enabled=false}]', ...trust] });
    expect(projectSkillRunnerContext(PROVIDERS.codex, ['--profile', 'x'], trust)).toEqual({ verified: false, configArgs: [] });
    expect(projectSkillRunnerContext(PROVIDERS.claude, PROVIDERS.claude.runner.args!, trust)).toEqual({ verified: false, configArgs: [] });
  });
  it('{skillCatalog} — служебная подстановка Parley: проверка контекста остаётся, в снимок она не попадает', () => {
    const template = ['-c', '{mcpConfig}', '-c', '{skillCatalog}', '-c', 'skills.config=[{name="review",enabled=false}]', '{prompt}'];
    expect(projectSkillRunnerContext(PROVIDERS.codex, template)).toEqual({ verified: true,
      configArgs: ['-c', 'skills.config=[{name="review",enabled=false}]'] });
  });
  it('canonicalizes literal human skills.config and inline config options, excluding comments', () => {
    const template = ['--config=skills.config=[{name="review",enabled=false}] # SECRET', '-cproject_root_markers=[".git"]', '{prompt}'];
    expect(projectSkillRunnerContext(PROVIDERS.codex, template)).toEqual({ verified: true,
      configArgs: ['-c', 'skills.config=[{name="review",enabled=false}]', '-c', 'project_root_markers=[".git"]'] });
  });
  it('rejects profiles, cwd, unknown policy and malformed selectors without returning raw config', () => {
    for (const template of [['--profile', 'SECRET'], ['-C', '/tmp'], ['-c', 'secret="SECRET"'],
      ['-c', 'skills.config=[{name="review",enabled=false,secret="SECRET"}]'], ['--', '{prompt}']])
      expect(projectSkillRunnerContext(PROVIDERS.codex, template)).toEqual({ verified: false, configArgs: [] });
    expect(projectSkillRunnerContext(PROVIDERS.claude, PROVIDERS.claude.runner.args!)).toEqual({ verified: false, configArgs: [] });
  });
});

describe('roleProvider и roleModel', () => {
  const builtin = { source: 'builtin', provider: 'claude', model: null, models: { claude: 'opus', codex: 'gpt-5.5' } } as const;
  const codexRole = { source: 'codex', provider: 'codex', model: 'gpt-5.5' } as const;
  it('не встроенная роль навязывает провайдера', () => {
    expect(roleProvider(codexRole, 'claude', 'glm')).toBe('codex');
  });
  it('встроенная: выбранный, потом свой, потом умолчание', () => {
    expect(roleProvider(builtin, 'codex', 'glm')).toBe('codex');
    expect(roleProvider(builtin, null, 'glm')).toBe('claude');
    expect(roleProvider(undefined, null, 'glm')).toBe('glm');
  });
  it('модель роли по провайдеру', () => {
    expect(roleModel(builtin, 'codex')).toBe('gpt-5.5');
    expect(roleModel(builtin, 'glm')).toBe('opus');
    expect(roleModel(codexRole, 'codex')).toBe('gpt-5.5');
    expect(roleModel(undefined, 'claude')).toBeNull();
  });
});

describe('roles on opencode (spec 2026-11-12, 4.8, DO4)', () => {
  const entry = OPENCODE_FAMILY_ENTRY;

  it('read-only and writable builtin roles are accepted without a template role channel; the model is the session\'s', async () => {
    for (const roleId of ['builtin:planner', 'builtin:executor', 'builtin:feature-lead']) {
      const resolved = await prepareSessionRole(project, entry, { roleId, provider: 'opencode', mode: 'create' });
      expect(resolved.model).toBeNull();
      expect(resolved.nativeAgent).toBeNull();
    }
    expect((await prepareSessionRole(project, entry, { roleId: 'builtin:planner', provider: 'opencode', mode: 'create' })).readOnly).toBe(true);
    expect((await prepareSessionRole(project, entry, { roleId: 'builtin:executor', provider: 'opencode', mode: 'create' })).readOnly).toBe(false);
  });

  it('the same read-only role is still refused where no channel exists: a Qwen entry and a template-less custom runner', async () => {
    const qwenLike = { ...entry, family: 'qwen' as const, runner: { command: 'qwen', args: ['--session-id', '{sessionUuid}'] } };
    await expect(prepareSessionRole(project, qwenLike, { roleId: 'builtin:planner', provider: 'qwen', mode: 'create' })).rejects.toThrow('role-permissions-unavailable');
  });

  it('a Claude native role does not carry over to opencode and is refused if forced', async () => {
    const native = buildRoleCatalog({ roles: [{ id: 'claude:exact', source: 'claude', name: 'exact', description: 'x', provider: 'claude', model: null, effort: null, readOnly: false, prompt: 'p', nativeAgent: 'exact' }] as never, diagnostics: [], partial: false } as never);
    expect(await roleForProvider(project, entry, { source: 'claude', name: 'exact' }, native)).toBeNull();
    expect(await roleForProvider(project, entry, { source: 'builtin', name: 'planner' })).toEqual({ source: 'builtin', name: 'planner' });
    const resolved = { ...(await prepareSessionRole(project, entry, { roleId: 'builtin:executor', provider: 'opencode', mode: 'create' })), nativeAgent: 'exact' };
    expect(() => assertRoleDelivery(entry, resolved as never)).toThrow('role-permissions-unavailable');
  });

  it('modelForTier gives no model for opencode in any tier, and a builtin role keeps the session\'s model', () => {
    for (const tier of ['strong', 'standard', 'light'] as const) expect(modelForTier('opencode', tier)).toBeNull();
    expect(roleModel({ source: 'builtin', model: 'opus', models: { claude: 'opus', codex: 'gpt-6-astra' } }, 'opencode')).toBeNull();
    const catalog = buildRoleCatalog();
    expect(resolveRoleChoice(catalog, { roleId: 'builtin:planner', provider: 'opencode' }).model).toBeNull();
  });
});

describe('built-in roles on a target that refuses them (spec 2026-11-12, 2.1)', () => {
  const neutral = { ...PROVIDERS.glm, id: 'custom-neutral', family: undefined, runner: { ...PROVIDERS.glm.runner, args: ['{prompt}'], resumeArgs: ['{prompt}'] } } as unknown as typeof PROVIDERS.glm;
  it('read-only architect: kept on codex and claude, null on qwen and on a neutral runner', async () => {
    const architect = { source: 'builtin', name: 'architect' } as const;
    expect(await roleForProvider(project, PROVIDERS.codex, architect)).toEqual(architect);
    expect(await roleForProvider(project, PROVIDERS.claude, architect)).toEqual(architect);
    expect(await roleForProvider(project, PROVIDERS.qwen, architect)).toBeNull();
    expect(await roleForProvider(project, neutral, architect)).toBeNull();
  });
  it('non-read-only executor stays on qwen', async () => {
    expect(await roleForProvider(project, PROVIDERS.qwen, { source: 'builtin', name: 'executor' })).toEqual({ source: 'builtin', name: 'executor' });
  });
});

describe('roleChangeOnSwitch', () => {
  const mk = (id: 'claude' | 'codex', name: string, readOnly: boolean) => id === 'claude'
    ? { id: `claude:${name}`, source: 'claude', provider: 'claude', name, nativeAgent: name, description: '', path: '/f.md', readOnly } as const
    : { id: `codex:${name}`, source: 'codex', provider: 'codex', name, description: '', path: '/f.toml', prompt: 'P.', model: null, effort: null, sandboxMode: null, readOnly } as const;
  const cat = (...roles: Array<ReturnType<typeof mk>>) => buildRoleCatalog({ roles, diagnostics: [], partial: false });
  const unverifiedCodex = (...roles: Array<ReturnType<typeof mk>>) =>
    buildRoleCatalog({ roles, diagnostics: [{ source: 'codex', code: 'context-unverified' }], partial: false });
  const codexReviewer = { source: 'codex', name: 'reviewer' } as const;

  it('fail closed: a Codex role with unreadable settings counts as read-only', async () => {
    expect(await roleChangeOnSwitch(project, PROVIDERS.claude, 'Claude Code', codexReviewer, unverifiedCodex(mk('codex', 'reviewer', false), mk('claude', 'reviewer', false)))).toEqual({
      from: 'codex:reviewer', to: 'claude:reviewer', readOnlyLost: true,
      text: 'reviewer may be a read-only role (its Codex settings could not be verified) and does not run on Claude Code. The session will continue as reviewer (claude), and can edit files and run commands.',
    });
    expect(await roleChangeOnSwitch(project, PROVIDERS.claude, 'Claude Code', codexReviewer, cat(mk('claude', 'reviewer', false)))).toEqual({
      from: 'codex:reviewer', to: 'claude:reviewer', readOnlyLost: true,
      text: 'codex:reviewer may be a read-only role (its Codex settings could not be verified) and does not run on Claude Code. The session will continue as reviewer (claude), and can edit files and run commands.',
    });
  });
  it('a readable non-read-only Codex role, and built-in and Claude roles next to a Codex diagnostic: unchanged', async () => {
    expect(await roleChangeOnSwitch(project, PROVIDERS.claude, 'Claude Code', codexReviewer, cat(mk('codex', 'reviewer', false), mk('claude', 'reviewer', false)))).toMatchObject({
      readOnlyLost: false, text: 'Role reviewer does not run on Claude Code. The session will continue as reviewer (claude).',
    });
    expect(await roleChangeOnSwitch(project, PROVIDERS.codex, 'Codex', { source: 'claude', name: 'reviewer' }, unverifiedCodex(mk('claude', 'reviewer', false)))).toMatchObject({
      to: null, readOnlyLost: false, text: 'Role reviewer does not run on Codex. The session will continue without a role.',
    });
    expect(await roleChangeOnSwitch(project, PROVIDERS.qwen, 'Qwen Code', { source: 'builtin', name: 'executor' }, unverifiedCodex())).toBeNull();
  });

  it('read-only lost, no role after', async () => {
    const change = await roleChangeOnSwitch(project, PROVIDERS.qwen, 'Qwen Code', { source: 'builtin', name: 'architect' }, buildRoleCatalog());
    expect(change).toEqual({ from: 'builtin:architect', to: null, readOnlyLost: true,
      text: 'Architect is a read-only role and does not run on Qwen Code. The session will continue without a role, and can edit files and run commands.' });
  });
  it('read-only lost, another role after', async () => {
    const catalog = cat(mk('claude', 'reviewer', true), mk('codex', 'reviewer', false));
    const change = await roleChangeOnSwitch(project, PROVIDERS.codex, 'Codex', { source: 'claude', name: 'reviewer' }, catalog);
    expect(change).toEqual({ from: 'claude:reviewer', to: 'codex:reviewer', readOnlyLost: true,
      text: 'reviewer is a read-only role and does not run on Codex. The session will continue as reviewer (codex), and can edit files and run commands.' });
  });
  it('plain change, with and without a role after', async () => {
    const catalog = cat(mk('claude', 'reviewer', false), mk('codex', 'reviewer', false));
    expect(await roleChangeOnSwitch(project, PROVIDERS.codex, 'Codex', { source: 'claude', name: 'reviewer' }, catalog)).toEqual({ from: 'claude:reviewer', to: 'codex:reviewer', readOnlyLost: false,
      text: 'Role reviewer does not run on Codex. The session will continue as reviewer (codex).' });
    expect(await roleChangeOnSwitch(project, PROVIDERS.codex, 'Codex', { source: 'claude', name: 'reviewer' }, cat(mk('claude', 'reviewer', false)))).toMatchObject({ to: null, readOnlyLost: false,
      text: 'Role reviewer does not run on Codex. The session will continue without a role.' });
  });
  it('no change: no role, or a role the target keeps', async () => {
    expect(await roleChangeOnSwitch(project, PROVIDERS.qwen, 'Qwen Code', null, buildRoleCatalog())).toBeNull();
    expect(await roleChangeOnSwitch(project, PROVIDERS.codex, 'Codex', { source: 'builtin', name: 'architect' }, buildRoleCatalog())).toBeNull();
    expect(await roleChangeOnSwitch(project, PROVIDERS.claude, 'Claude', { source: 'builtin', name: 'architect' }, buildRoleCatalog())).toBeNull();
  });
});
