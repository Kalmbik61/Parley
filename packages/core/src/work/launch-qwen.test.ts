import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPendingSession, planLaunch, planNew, planResume } from './launch.js';
import { assertRoleDelivery, prepareSessionRole, roleForProvider } from './agents.js';
import { roleModel } from './role-choice.js';
import { modelForTier } from '../roles/builtin.js';
import { buildRoleCatalog, resolveRoleChoice } from '../roles/catalog.js';
import type { RoleCatalog } from '../roles/types.js';
import { PROVIDERS } from '../providers.js';
import { BROWSER_PRIORITY_RULE } from './guidance.js';
import { BROWSER_PERMISSIONS, CLOSE_SESSION_PERMISSION } from './settings-file.js';
import { createWork, readMap } from './store.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'stub-agent.mjs');
const agent = { url: 'http://127.0.0.1:4100/agent/browser', token: 'a'.repeat(64) };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let home = '';
let project = '';
let adminBase = '';
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  adminBase = path.join(home, 'qwen-system.json');
  setEnv('PARLEY_HOME', home);
  setEnv('PARLEY_QWEN_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('HARNAS_SKILL_NAVIGATOR', undefined);
  // The effective system file of these tests; absent unless a test writes it.
  setEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', adminBase);
  setEnv('QWEN_HOME', path.join(home, 'qwen-home'));
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function qwenSession(task = 'run the e2e suite', role?: { source: 'builtin'; name: string }) {
  const created = await createWork(project, { title: 'Auth', goal: 'email login' });
  const workId = created.work.id;
  const sessionId = await createPendingSession(project, workId, { provider: 'qwen', label: 'tests', task, ...(role === undefined ? {} : { role }) });
  const session = (await readMap(project, workId)).sessions.find((item) => item.id === sessionId)!;
  return { workId, session };
}

const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

describe('qwen launch', () => {
  it('new session: session id, default approval mode, system layer; the brief is deferred, not -i; settings file in the env', async () => {
    const { workId, session } = await qwenSession();
    const plan = await planLaunch(project, workId, session);
    expect(plan.command).toBe('qwen');
    expect(plan.args[0]).toBe('--session-id');
    expect(plan.args[1]).toMatch(UUID);
    expect(plan.providerSessionId).toBe(plan.args[1]);
    expect(valueOf(plan.args, '--approval-mode')).toBe('default');
    expect(valueOf(plan.args, '--append-system-prompt')).toContain('You are inside Parley');
    expect(plan.args).not.toContain('-i');
    expect(plan.deferredPrompt).toContain('run the e2e suite');
    expect(plan.args.join('\n')).not.toContain('run the e2e suite');
    expect(plan.args).not.toContain('-m');
    const file = plan.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!;
    expect(file).toBe(path.join(project, '.parley', 'works', workId, 'settings', `${session.id}-qwen.json`));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.mcpServers.parley.env.PARLEY_SESSION_ID).toBe(session.id);
    expect(plan.env).toMatchObject({ PARLEY_SESSION_ID: session.id });
    for (const key of Object.keys(plan.env)) expect(key).not.toMatch(/^(QWEN_HOME$|OPENAI_)/);
    expect(plan.warnings).toEqual([]);
  });

  it('never passes --yolo, in any mode', async () => {
    const { workId, session } = await qwenSession();
    const plans = [
      await planLaunch(project, workId, session),
      await planNew(project, workId, session),
      await planResume(project, workId, { ...session, providerSessionId: '11111111-1111-4111-8111-111111111111' }),
    ];
    for (const plan of plans) {
      expect(plan.args).not.toContain('--yolo');
      expect(valueOf(plan.args, '--approval-mode')).not.toBe('yolo');
    }
  });

  it('resume: --resume <id> with the same flags and no --session-id; no -i and nothing deferred (the host types the pointer)', async () => {
    const { workId, session } = await qwenSession();
    const id = '11111111-1111-4111-8111-111111111111';
    const plan = await planResume(project, workId, { ...session, providerSessionId: id }, { prompt: 'You have new mail', model: 'qwen3-coder-plus' });
    expect(plan.args.slice(0, 4)).toEqual(['--resume', id, '--approval-mode', 'default']);
    expect(plan.args).not.toContain('--session-id');
    expect(valueOf(plan.args, '--append-system-prompt')).toContain('You are inside Parley');
    expect(valueOf(plan.args, '-m')).toBe('qwen3-coder-plus');
    expect(plan.args).not.toContain('-i');
    expect(plan.args).not.toContain('You have new mail');
    expect(plan).not.toHaveProperty('deferredPrompt');
    expect(plan.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']).toBeDefined();
  });

  it('new (quick) session: no first prompt, nothing deferred', async () => {
    const { workId, session } = await qwenSession();
    const plan = await planNew(project, workId, session);
    expect(plan.args).not.toContain('-i');
    expect(plan).not.toHaveProperty('deferredPrompt');
    expect(valueOf(plan.args, '--approval-mode')).toBe('default');
  });

  it('workspace (autonomous) sessions stay refused for qwen in v1', async () => {
    const { workId, session } = await qwenSession();
    session.workspace = { kind: 'clone', path: project, branch: 'attempt', sha: 'abc' };
    await expect(planLaunch(project, workId, session)).rejects.toThrow('confinement-unavailable');
  });

  it('MCP is present by route kind: the browser rule reaches the layer, browser tools and close_session are pre-allowed', async () => {
    const { workId, session } = await qwenSession();
    const plan = await planLaunch(project, workId, session, { agent, hookUrl: 'http://127.0.0.1:4100/hooks' });
    expect(valueOf(plan.args, '--append-system-prompt')).toContain(BROWSER_PRIORITY_RULE);
    const settings = JSON.parse(await readFile(plan.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!, 'utf8'));
    expect(settings.permissions.allow).toEqual([...BROWSER_PERMISSIONS, CLOSE_SESSION_PERMISSION]);
    expect(settings.mcpServers.parley.env).toMatchObject({ PARLEY_AGENT_URL: agent.url, PARLEY_AGENT_TOKEN: agent.token });
    expect(settings.hooks.Stop[0].hooks[1]).toMatchObject({ type: 'http', url: 'http://127.0.0.1:4100/hooks' });
    // Without the channel: no rule and nothing pre-allowed.
    const plain = await planLaunch(project, workId, session);
    expect(valueOf(plain.args, '--append-system-prompt')).not.toContain(BROWSER_PRIORITY_RULE);
    expect(JSON.parse(await readFile(plain.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!, 'utf8'))).not.toHaveProperty('permissions');
  });

  it('an administrator value of a default is kept and the launch says so', async () => {
    await writeFile(adminBase, JSON.stringify({ general: { enableAutoUpdate: true } }));
    const { workId, session } = await qwenSession();
    const plan = await planLaunch(project, workId, session);
    expect(plan.warnings).toEqual(["The Qwen system settings file sets general.enableAutoUpdate; Parley keeps the administrator's value instead of its default."]);
  });

  it('a base that makes integration impossible refuses the launch', async () => {
    await writeFile(adminBase, JSON.stringify({ mcp: { excluded: ['parley'] } }));
    const { workId, session } = await qwenSession();
    await expect(planLaunch(project, workId, session)).rejects.toThrow('Qwen system settings key mcp.excluded includes parley');
    await writeFile(adminBase, '{not json');
    await expect(planLaunch(project, workId, session)).rejects.toThrow(`Qwen system settings file ${adminBase} is not valid JSON`);
  });
});

describe('qwen wake: resume into the same transcript', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const writeTranscript = async (id: string): Promise<string> => {
    const dir = path.join(home, 'qwen-home', 'projects', '-p', 'chats');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ uuid: 'u', sessionId: id, timestamp: '2026-11-11T10:00:00.000Z', type: 'user' })}\n`);
    return file;
  };

  it('a session with a transcript wakes with --resume <id>, the same settings file and env as its first launch', async () => {
    const { workId, session } = await qwenSession();
    const first = await planNew(project, workId, { ...session, providerSessionId: ID });
    expect(valueOf(first.args, '--session-id')).toBe(ID);
    await writeTranscript(ID);
    const woken = await planResume(project, workId, { ...session, providerSessionId: ID }, { prompt: 'You have new mail' });
    expect(woken.args.slice(0, 2)).toEqual(['--resume', ID]);
    expect(woken.args).not.toContain('--session-id');
    expect(woken.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']).toBe(first.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']);
  });

  it('the bound transcript path counts as the conversation', async () => {
    const { workId, session } = await qwenSession();
    const file = await writeTranscript('22222222-2222-4222-8222-222222222222');
    const woken = await planResume(project, workId, { ...session, providerSessionId: ID, qwenTranscript: { path: file, cwd: project } }, {});
    expect(woken.args.slice(0, 2)).toEqual(['--resume', ID]);
  });

  it('a session that slept before its first prompt has no transcript: it starts again with the same id, not a failing --resume', async () => {
    const { workId, session } = await qwenSession();
    await writeTranscript('33333333-3333-4333-8333-333333333333');
    const woken = await planResume(project, workId, { ...session, providerSessionId: ID }, { prompt: 'You have new mail' });
    expect(woken.args).not.toContain('--resume');
    expect(valueOf(woken.args, '--session-id')).toBe(ID);
  });

  it('an unreadable history root keeps the plain --resume', async () => {
    const { workId, session } = await qwenSession();
    const woken = await planResume(project, workId, { ...session, providerSessionId: ID }, {});
    expect(woken.args.slice(0, 2)).toEqual(['--resume', ID]);
  });
});

describe('roles on qwen (spec 2026-11-11, 3.6, D10)', () => {
  const RESUME_ID = '11111111-1111-4111-8111-111111111111';

  it.each(['executor', 'debugger', 'verifier'])('%s launches and resumes with the role prompt and no role model', async (name) => {
    const { workId, session } = await qwenSession('do it', { source: 'builtin', name });
    for (const plan of [
      await planLaunch(project, workId, session),
      await planResume(project, workId, { ...session, providerSessionId: RESUME_ID }),
    ]) {
      expect(valueOf(plan.args, '--append-system-prompt')).toContain(`(builtin:${name})`);
      expect(plan.args).not.toContain('-m');
    }
  });

  it.each(['planner', 'critic', 'reviewer', 'architect', 'feature-lead', 'researcher'])('read-only %s is refused on launch and resume', async (name) => {
    const { workId, session } = await qwenSession('do it', { source: 'builtin', name });
    await expect(planLaunch(project, workId, session)).rejects.toThrow('role-permissions-unavailable');
    await expect(planResume(project, workId, { ...session, providerSessionId: RESUME_ID })).rejects.toThrow('role-permissions-unavailable');
  });

  it('native Claude and Codex roles are a provider mismatch on qwen, and do not carry over to it', async () => {
    const claude = { id: 'claude:reviewer-x', source: 'claude' as const, name: 'reviewer-x', description: '', provider: 'claude' as const,
      readOnly: false, path: '/x.md', nativeAgent: 'reviewer-x' };
    const codex = { id: 'codex:fixer', source: 'codex' as const, name: 'fixer', description: '', provider: 'codex' as const, readOnly: false,
      path: '/x.toml', prompt: 'fix things', model: null, effort: null, sandboxMode: null };
    const catalog: RoleCatalog = buildRoleCatalog({ roles: [claude, codex], diagnostics: [], partial: false });
    for (const roleId of ['claude:reviewer-x', 'codex:fixer']) {
      for (const mode of ['create', 'existing'] as const) {
        await expect(prepareSessionRole(project, PROVIDERS.qwen, { roleId, provider: 'qwen', mode }, catalog)).rejects.toThrow('role-provider-mismatch');
      }
    }
    expect(await roleForProvider(project, PROVIDERS.qwen, { source: 'claude', name: 'reviewer-x' }, catalog)).toBeNull();
    expect(await roleForProvider(project, PROVIDERS.qwen, { source: 'codex', name: 'fixer' }, catalog)).toBeNull();
    expect(await roleForProvider(project, PROVIDERS.qwen, { source: 'builtin', name: 'executor' }, catalog)).toEqual({ source: 'builtin', name: 'executor' });
  });

  it('a template with an unknown flag (or -i) is refused for a role; the built-in templates pass', () => {
    const executor = resolveRoleChoice(buildRoleCatalog(), { roleId: 'builtin:executor', provider: 'qwen' });
    expect(() => assertRoleDelivery(PROVIDERS.qwen, executor)).not.toThrow();
    const runner = PROVIDERS.qwen.runner;
    for (const extra of [['-i', '{prompt}'], ['--yolo'], ['--allowed-tools', 'x'], ['{leanFlags}'], ['--', '{prompt}']]) {
      const entry = { ...PROVIDERS.qwen, runner: { ...runner, args: [...(runner.args ?? []), ...extra] } };
      expect(() => assertRoleDelivery(entry, executor)).toThrow('role-permissions-unavailable');
    }
    // Without a role the template is the human's own business: no role delivery to prove.
    const plain = resolveRoleChoice(buildRoleCatalog(), { provider: 'qwen' });
    expect(() => assertRoleDelivery({ ...PROVIDERS.qwen, runner: { ...runner, args: ['--yolo'] } }, plain)).not.toThrow();
  });

  it('models: no tier model and no role model for qwen', () => {
    for (const tier of ['strong', 'standard', 'light'] as const) expect(modelForTier('qwen', tier)).toBeNull();
    expect(roleModel({ source: 'builtin', model: null, models: { claude: 'opus', codex: 'gpt-6-astra' } }, 'qwen')).toBeNull();
    expect(roleModel({ source: 'builtin', model: null, models: { claude: 'opus', codex: 'gpt-6-astra' } }, 'claude')).toBe('opus');
  });
});
