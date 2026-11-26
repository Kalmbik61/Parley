import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionRef } from '@parley/protocol';
import { expect, it, vi } from 'vitest';
import { fakePty } from '../../test/fake-pty.js';
import { workspaceKey } from './date-provenance.js';
import { createKimiNativeSession } from './native-session.js';

const tool = 'mcp__figma-dev-mode-mcp-server__add_code_connect_map';
const poisonError = { code: 'provider.api_error', name: 'APIStatusError', retryable: false,
  details: { requestId: null, statusCode: 400, traceId: 'fixture' },
  message: `unload_tools at message position 168: tool "${tool}" is not declared or has already been unloaded` };

it('reports current turn ends with the poison tool to recovery, never historical ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-unload-'));
  const ref: SessionRef = { projectPath: home, workId: 'w-01', sessionId: 's-01' };
  const id = 'session_00000000-0000-4000-8000-000000000001';
  const file = join(home, 'sessions', workspaceKey(home), id, 'agents', 'main', 'wire.jsonl');
  const pty = fakePty();
  pty.startedAt = Date.now();
  let start: ((ref: SessionRef) => void) | undefined;
  const get = pty.manager.get;
  pty.manager.get = (target) => {
    const handle = get(target);
    return handle === undefined ? undefined : { ...handle, kimiNative: true, generation: 'unload-generation' };
  };
  const on = pty.manager.on;
  pty.manager.on = ((event: string, listener: never) => {
    if (event === 'start') start = listener;
    return on(event as 'draft', listener);
  }) as typeof on;
  const turnEnd = vi.fn();
  const native = createKimiNativeSession({
    pty: pty.manager, log: { warn: vi.fn() }, bind: vi.fn(), bootstrap: vi.fn(), event: vi.fn(), turnEnd,
    reset: vi.fn(), requests: vi.fn(), activity: vi.fn(), startupFailed: vi.fn(), readyChanged: vi.fn(), fence: vi.fn(),
  });
  const row = (type: string, time: number, data = {}) => JSON.stringify({ type, agentId: 'main', time, ...data }) + '\n';
  const poll = { interval: 20, timeout: 2_000 };
  try {
    await mkdir(dirname(file), { recursive: true });
    // A historical poison and a historical clean end stay out of recovery; only current ends are reported.
    await writeFile(file, JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' }) + '\n' +
      row('turn.ended', pty.startedAt - 2, { reason: 'failed', error: poisonError }) +
      row('turn.ended', pty.startedAt - 1, { reason: 'completed' }));
    await native.prepare(ref, { cwd: home, home }, id, '');
    start?.(ref);
    await appendFile(file, row('turn.ended', Date.now(), { reason: 'failed', error: poisonError }));
    await expect.poll(() => turnEnd.mock.calls, poll).toContainEqual([ref, { cwd: home, home }, id, { tool }]);
    expect(turnEnd).toHaveBeenCalledTimes(1);

    // A StopFailure hook may end the work before the wire row drains: recovery still hears the end.
    native.onHook(ref, { hook_event_name: 'StopFailure', client_type: 'kimi_code_cli', cwd: home, session_id: id });
    const late = Date.now() - 1;
    await appendFile(file, row('turn.ended', late, { reason: 'completed' }));
    await expect.poll(() => turnEnd.mock.calls, poll).toContainEqual([ref, { cwd: home, home }, id, undefined]);
    expect(turnEnd).toHaveBeenCalledTimes(2);
  } finally {
    native.abort(ref);
    await rm(home, { recursive: true, force: true });
  }
});
