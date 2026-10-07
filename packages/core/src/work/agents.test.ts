import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentDirs, assertAgent, listAgents, prepareSessionRole, sessionRoleCatalog, assertRoleDelivery, projectSkillRunnerContext } from './agents.js';
import { PROVIDERS } from '../providers.js';
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
    await expect(prepareSessionRole(project, entry, { provider: 'codex' })).resolves.toMatchObject({ role: null, readOnly: false, sandboxMode: null });
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
