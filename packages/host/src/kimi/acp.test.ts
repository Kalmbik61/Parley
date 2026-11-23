import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiAcp } from './acp.js';

const command = process.execPath;
const cwd = fileURLToPath(new URL('./fixtures', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/acp.cjs', import.meta.url));
const mcpServers = [{ type: 'stdio' as const, name: 'parley', command, args: [], env: [{ name: 'PARLEY_SESSION_ID', value: 's-01' }] }];
let sessions: ReturnType<typeof createKimiAcp>[] = [];

function start(sessionId?: string, env = {}, binary = command, loadHistory = false) {
  const text: string[] = [];
  const acp = createKimiAcp({
    command: binary, args: [fixture], cwd, env: { ...env, KIMI_FIXTURE_EXPECT_FORMS: '1' }, mcpServers, sessionId,
    loadHistory, elicitationForm: true,
    onText: (chunk) => text.push(chunk),
  });
  sessions.push(acp);
  return { acp, text };
}

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  sessions = [];
});

describe('Kimi Code ACP subprocess', () => {
  it('creates a session with Parley MCP, streams only its text and confirms configuration', async () => {
    const { acp, text } = start();
    expect(await acp.connect()).toBe('acp-session');
    expect(await acp.prompt('hello')).toBe('end_turn');
    expect(text.join('')).toBe('Hello Parley');
    expect(await acp.setConfig('mode', 'plan')).toMatchObject([{ id: 'mode', currentValue: 'plan' }]);
    expect(acp.state().config).toMatchObject([{ id: 'mode', currentValue: 'plan' }]);
  });

  it('cancels the bound session, clears pending work on disconnect and reconnects using its provider id', async () => {
    const { acp } = start();
    const sessionId = await acp.connect();
    const waiting = acp.prompt('wait');
    acp.cancel();
    expect(await waiting).toBe('cancelled');
    await expect(acp.prompt('disconnect')).rejects.toMatchObject({ code: 'disconnected' });
    const restored = start(sessionId);
    expect(await restored.acp.connect()).toBe(sessionId);
    expect(await restored.acp.prompt('hello')).toBe('end_turn');
    expect(restored.text.join('')).toBe('Hello Parley');
  });

  it('validates permission options and forwards a text form response to its original request', async () => {
    const { acp, text } = start();
    await acp.connect();
    const approval = acp.prompt('approve');
    await expect.poll(() => acp.state().requests.length).toBe(1);
    const [permission] = acp.state().requests;
    expect(permission?.kind).toBe('permission');
    expect(() => acp.respond(permission!.id, { kind: 'permission', optionId: 'invented' })).toThrow();
    acp.respond(permission!.id, { kind: 'permission', optionId: 'deny' });
    await approval;
    expect(() => acp.respond(permission!.id, { kind: 'permission', optionId: 'deny' })).toThrow();
    const question = acp.prompt('question');
    await expect.poll(() => acp.state().requests.length).toBe(1);
    const [elicitation] = acp.state().requests;
    expect(elicitation?.kind).toBe('elicitation');
    acp.respond(elicitation!.id, { kind: 'elicitation', action: 'accept', content: { name: 'Parley' } });
    await question;
    expect(text).toEqual(['deny', 'Parley']);
    expect(acp.state().requests).toEqual([]);
  });

  it('loads a previously bound session with its conversation when the host needs history', async () => {
    const { acp, text } = start('acp-session', {}, command, true);
    expect(await acp.connect()).toBe('acp-session');
    expect(text).toEqual(['Old question', 'Old answer']);
  });

  it('distinguishes a missing executable from ACP authentication required', async () => {
    await expect(start(undefined, {}, '/no/such/kimi').acp.connect()).rejects.toMatchObject({ code: 'missing-cli' });
    const loggedOut = { KIMI_FIXTURE_LOGGED_OUT: '1' };
    await expect(start(undefined, loggedOut).acp.checkAuth()).resolves.toBe(false);
    await expect(start(undefined, loggedOut).acp.connect()).rejects.toMatchObject({ code: 'sign-in' });
  });
});
