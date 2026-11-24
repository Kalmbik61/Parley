import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPendingSession, planLaunch, planNew, planResume } from './launch.js';
import { PROVIDERS, substituteArgs } from '../providers.js';
import { OPENCODE_SERVER_URL_SLOT } from './opencode-config.js';
import { createWork, readMap } from './store.js';

const SES = /^ses_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let home = '';
let project = '';
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  setEnv('PARLEY_HOME', home);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('HARNAS_SKILL_NAVIGATOR', undefined);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function opencodeSession(task = 'run the e2e suite', role?: { source: 'builtin'; name: string }) {
  const created = await createWork(project, { title: 'Auth', goal: 'email login' });
  const workId = created.work.id;
  const sessionId = await createPendingSession(project, workId, { provider: 'opencode', label: 'tests', task, ...(role === undefined ? {} : { role }) });
  const session = (await readMap(project, workId)).sessions.find((item) => item.id === sessionId)!;
  return { workId, session };
}

describe('opencode registry entry (O5, spec 4.1)', () => {
  it('attaches the TUI to a server, names the session and takes no prompt or model flag', () => {
    const entry = PROVIDERS['opencode']!;
    expect(entry).toMatchObject({ id: 'opencode', family: 'opencode', label: 'OpenCode', mark: 'Oc', hasHistory: true, linkBy: 'session-id' });
    expect(entry.runner).toMatchObject({ command: 'opencode', minVersion: '2.0.0', mcpConfig: 'opencode-server' });
    expect(entry.runner.args).toEqual(['--server', '{serverUrl}', '-s', '{sessionId}', '{autoFlag}']);
    expect(entry.runner.resumeArgs).toEqual(['--server', '{serverUrl}', '-s', '{providerSessionId}', '{autoFlag}']);
  });

  it('{autoFlag} without a value drops alone and does not take the session id with it', () => {
    expect(substituteArgs(PROVIDERS['opencode']!.runner.args!, { serverUrl: 'u', sessionId: 'ses_x' })).toEqual(['--server', 'u', '-s', 'ses_x']);
    expect(substituteArgs(PROVIDERS['opencode']!.runner.args!, { serverUrl: 'u', sessionId: 'ses_x', autoFlag: '--auto' }))
      .toEqual(['--server', 'u', '-s', 'ses_x', '--auto']);
  });
});

describe('opencode launch plan (O5)', () => {
  it('new session: ses_<uuid>, the server slot, --auto, the brief deferred; the config goes to the server, not the TUI', async () => {
    const { workId, session } = await opencodeSession();
    const plan = await planLaunch(project, workId, session);
    expect(plan.command).toBe('opencode');
    expect(plan.args).toEqual(['--server', OPENCODE_SERVER_URL_SLOT, '-s', expect.stringMatching(SES), '--auto']);
    expect(plan.providerSessionId).toBe(plan.args[3]);
    expect(plan.deferredPrompt).toContain('run the e2e suite');
    expect(plan.args.join(' ')).not.toContain('run the e2e suite');
    const env = plan.opencodeServer!.env;
    expect(Object.keys(env).sort()).toEqual(['OPENCODE_CLI_CONFIG_CONTENT', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE']);
    const config = JSON.parse(env['OPENCODE_CONFIG_CONTENT']!) as { mcp: { parley: { command: string[]; environment: Record<string, string> } }; autoupdate: boolean };
    expect(config.autoupdate).toBe(false);
    expect(path.isAbsolute(config.mcp.parley.command[0]!)).toBe(true);
    expect(config.mcp.parley.environment['PARLEY_SESSION_ID']).toBe(session.id);
    expect(plan.env['OPENCODE_CONFIG_CONTENT']).toBeUndefined();
    // The password is the host's: never in a plan.
    expect(JSON.stringify(plan)).not.toMatch(/OPENCODE_SERVER_PASSWORD|OPENCODE_PASSWORD/);
  });

  it('resume keeps the ses_ id and sends no brief; a chosen model goes into the server config', async () => {
    const { workId, session } = await opencodeSession();
    const first = await planLaunch(project, workId, session);
    const resumed = await planResume(project, workId, { ...session, providerSessionId: first.providerSessionId });
    expect(resumed.args).toEqual(['--server', OPENCODE_SERVER_URL_SLOT, '-s', first.providerSessionId, '--auto']);
    expect(resumed.deferredPrompt).toBeUndefined();
    const chosen = await planNew(project, workId, session, { model: 'mock/mock-1#high' });
    expect(JSON.parse(chosen.opencodeServer!.env['OPENCODE_CONFIG_CONTENT']!).model).toBe('mock/mock-1#high');
    expect(chosen.args).not.toContain('mock/mock-1#high');
  });

  it('the session layer goes to a per-session instructions file that the server config lists, rewritten on resume', async () => {
    const { workId, session } = await opencodeSession();
    const plan = await planLaunch(project, workId, session);
    const config = JSON.parse(plan.opencodeServer!.env['OPENCODE_CONFIG_CONTENT']!) as { instructions: string[] };
    expect(config.instructions).toHaveLength(1);
    const file = config.instructions[0]!;
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.endsWith(`${session.id}-opencode-instructions.md`)).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('Call them inside the execute tool as tools.parley.<name>(args)');
    expect(text).not.toContain('tools.mcp__parley__');
    await rm(file);
    await planResume(project, workId, { ...session, providerSessionId: plan.providerSessionId });
    // Written again (a resume layer omits what the conversation already has, so the text may differ).
    expect(await readFile(file, 'utf8')).toContain('tools.parley.<name>(args)');
  });

  it('a role with text launches: the role text travels in the instructions file; read-only drops --auto and adds deny rules', async () => {
    const writable = await opencodeSession('implement', { source: 'builtin', name: 'executor' });
    const plan = await planLaunch(project, writable.workId, writable.session);
    expect(plan.args.at(-1)).toBe('--auto');
    const file = (JSON.parse(plan.opencodeServer!.env['OPENCODE_CONFIG_CONTENT']!) as { instructions: string[] }).instructions[0]!;
    expect(await readFile(file, 'utf8')).toMatch(/executor/i);
    const critic = await opencodeSession('review', { source: 'builtin', name: 'critic' });
    const readOnly = await planLaunch(project, critic.workId, critic.session);
    expect(readOnly.args).not.toContain('--auto');
    const rules = (JSON.parse(readOnly.opencodeServer!.env['OPENCODE_CONFIG_CONTENT']!) as { permissions: Array<{ action: string; effect: string }> }).permissions;
    expect(rules.filter((rule) => rule.effect === 'deny').map((rule) => rule.action)).toEqual(['edit', 'write', 'shell', 'webfetch', 'websearch', 'subagent']);
    expect(rules.at(-1)).toEqual({ action: 'parley_*', resource: '*', effect: 'allow' });
  });
});
