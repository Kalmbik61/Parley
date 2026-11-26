import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionRef } from '@parley/protocol';
import { expect, it, vi } from 'vitest';
import { fakePty } from '../../test/fake-pty.js';
import { PASTE_END, PASTE_START } from '../pty/codex-input.js';
import { workspaceKey } from './date-provenance.js';
import { createKimiNativeSession } from './native-session.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };
const first = 'session_00000000-0000-4000-8000-000000000001';
const final = 'session_00000000-0000-4000-8000-000000000002';

async function lazy(
  version: string,
  check: (fixture: {
    writes: string[];
    failed: ReturnType<typeof vi.fn>;
    actions: [string, string | null][];
    ready: () => boolean;
    inboxReady: () => boolean;
  }) => Promise<void>,
  behavior: 'observe' | 'incompatible-permission' | 'compatible' | 'offline' | 'silent' = 'observe',
) {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-lazy-startup-'));
  const pty = fakePty();
  pty.paste = true;
  let providerId: string | undefined;
  let catalog = false;
  const composer = (draft = '') => {
    pty.screen = [
      ` │ Version: ${version} │`,
      providerId === undefined ? ' No session yet — one will be created on your first message.' : ` Started a new session (${providerId}).`,
      ...(catalog ? [' │ parley connected stdio 1 tool │'] : []),
      ' ╭────────────────────╮',
      ` │ > ${draft.padEnd(17)}│`,
      ' ╰────────────────────╯',
      ' model  ·  workspace',
    ];
  };
  composer();
  let start: (ref: SessionRef) => void = () => {};
  const get = pty.manager.get;
  pty.manager.get = (target) => {
    const handle = get(target);
    return handle === undefined ? undefined : {
      ...handle, kimiNative: true, generation: 'startup-generation', rawInputRevision: () => 0,
    };
  };
  const on = pty.manager.on;
  pty.manager.on = ((event: string, listener: never) => {
    if (event === 'start') start = listener;
    return on(event as 'draft', listener);
  }) as typeof on;
  const failed = vi.fn();
  const actions: [string, string | null][] = [];
  const native = createKimiNativeSession({
    pty: pty.manager, log: { warn: vi.fn() }, bind: vi.fn(), event: vi.fn(),
    bootstrap: async (_ref, _binding, _owner, id, action) => { actions.push([action, id]); },
    reset: vi.fn(), requests: vi.fn(), activity: vi.fn(), startupFailed: failed,
    readyChanged: vi.fn(), fence: vi.fn(),
  });
  if (behavior !== 'observe') {
    const write = pty.manager.write;
    let command: string | undefined;
    pty.manager.write = (target, data) => {
      write(target, data);
      const pasted = data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
        ? data.slice(PASTE_START.length, -PASTE_END.length)
        : undefined;
      if (pasted === '/permission' || pasted === '/new' || pasted === '/mcp') {
        command = pasted;
        composer(pasted);
      } else if (data === '\x1b') {
        composer();
      } else if (data === '\r') {
        if (command === '/permission') {
          pty.screen = behavior !== 'incompatible-permission'
            ? ['Select permission mode', '❯ Always Ask ← current', 'Ask When Needed', 'Never Ask']
            : ['Permission settings (different native format)', 'Choose a different mode'];
        } else if (command === '/new') {
          providerId = providerId === undefined ? first : final;
          catalog = false;
          const file = join(home, 'sessions', workspaceKey(home), providerId, 'agents', 'main', 'wire.jsonl');
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, [
            { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' },
            ...(behavior === 'offline' ? [{ type: 'mcp.server_failed', agentId: 'main', serverName: 'parley', transport: 'stdio' }]
              : behavior === 'silent' ? [] : [{ type: 'mcp.tools_discovered', agentId: 'main', serverName: 'parley',
                tools: [{ name: 'get_map' }], enabledNames: ['get_map'] }]),
          ].map(row => JSON.stringify(row)).join('\n') + '\n');
          native.onHook(ref, { hook_event_name: 'SessionStart', client_type: 'kimi_code_cli', cwd: home, session_id: providerId });
          composer();
        } else if (command === '/mcp') {
          catalog = behavior !== 'silent' && behavior !== 'offline';
          composer();
        }
      }
    };
  }
  try {
    await native.prepare(ref, { cwd: home, home }, null, '', 'manual', 'fixture-bootstrap');
    if (behavior !== 'offline' && behavior !== 'silent') native.listed(ref, ['get_map']);
    start(ref);
    await check({ writes: pty.writes, failed, actions, ready: () => native.ready(ref),
      inboxReady: () => native.ready(ref, false, 'inbox') });
  } finally {
    native.abort(ref);
    await rm(home, { recursive: true, force: true });
  }
}

it.each(['2.7.3', '2.8.0'])('accepts the recognized %s lazy editor into guarded bootstrap', async (version) => {
  await lazy(version, async ({ writes, failed }) => {
    await expect.poll(() => [...writes], { timeout: 600 }).toEqual(['\x1b[200~/permission\x1b[201~']);
    expect(failed).not.toHaveBeenCalled();
  });
});

it('completes the same guarded bootstrap with a compatible future version label', async () => {
  await lazy('9.1.0+future.build', async ({ actions, failed, ready }) => {
    await expect.poll(ready, { timeout: 3500 }).toBe(true);
    expect(actions).toEqual([['arm', null], ['verify', first], ['complete', final]]);
    expect(failed).not.toHaveBeenCalled();
  }, 'compatible');
});

it.each(['offline', 'silent'] as const)('opens the first bound composer while the Parley MCP is %s', async behavior => {
  await lazy('2.8.0', async ({ writes, actions, failed, ready, inboxReady }) => {
    await expect.poll(ready, { timeout: 5000 }).toBe(true);
    expect(actions).toEqual([['arm', null], ['complete', first]]);
    expect(writes.filter(input => input.includes('/new'))).toHaveLength(1);
    expect(inboxReady()).toBe(false);
    expect(failed).not.toHaveBeenCalled();
  }, behavior);
}, 7000);

it('reports the failed native capability without arming rotation when the permission menu differs', async () => {
  const clock = Date.now;
  let elapsed = 0;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock() + elapsed);
  try {
    await lazy('9.1.0', async ({ writes, failed, actions }) => {
      await expect.poll(() => [...writes], { timeout: 600 }).toEqual(['\x1b[200~/permission\x1b[201~', '\r']);
      elapsed = 16_000;
      await expect.poll(() => failed.mock.calls.length, { timeout: 600 }).toBe(1);
      expect(actions).toEqual([]);
      expect(failed).toHaveBeenCalledWith(ref, 'startup-generation',
        expect.stringMatching(/9\.1\.0.*Permission mode could not be confirmed.*Stop and resume/i));
    }, 'incompatible-permission');
  } finally {
    now.mockRestore();
  }
});
