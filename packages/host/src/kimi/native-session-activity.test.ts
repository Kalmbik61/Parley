import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionRef } from '@parley/protocol';
import { expect, it, vi } from 'vitest';
import { fakePty } from '../../test/fake-pty.js';
import { workspaceKey } from './date-provenance.js';
import { createKimiNativeSession } from './native-session.js';

it('drives activity from only the current Kimi model step and honors block, end and interrupt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-activity-'));
  const ref: SessionRef = { projectPath: home, workId: 'w-01', sessionId: 's-01' };
  const id = 'session_00000000-0000-4000-8000-000000000001';
  const file = join(home, 'sessions', workspaceKey(home), id, 'agents', 'main', 'wire.jsonl');
  const pty = fakePty();
  pty.startedAt = Date.now();
  let start: ((ref: SessionRef) => void) | undefined;
  const get = pty.manager.get;
  pty.manager.get = (target) => {
    const handle = get(target);
    return handle === undefined ? undefined : { ...handle, kimiNative: true, generation: 'activity-generation' };
  };
  const on = pty.manager.on;
  pty.manager.on = ((event: string, listener: never) => {
    if (event === 'start') start = listener;
    return on(event as 'draft', listener);
  }) as typeof on;
  const activity = vi.fn();
  const event = vi.fn();
  const native = createKimiNativeSession({
    pty: pty.manager, log: { warn: vi.fn() }, bind: vi.fn(), bootstrap: vi.fn(), event,
    reset: vi.fn(), requests: vi.fn(), activity, startupFailed: vi.fn(), readyChanged: vi.fn(), fence: vi.fn(),
  });
  const row = (type: string, time: number, data = {}, agentId = 'main') =>
    JSON.stringify({ type, agentId, time, ...data }) + '\n';
  const step = (time: number, agentId?: string) =>
    row('context.append_loop_event', time, { event: { type: 'step.begin', uuid: 'fixture-step' } }, agentId);
  const poll = { interval: 20, timeout: 2_000 };
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' }) + '\n' +
      step(pty.startedAt - 1) + step(pty.startedAt, 'child') +
      row('turn.ended', pty.startedAt - 1, { reason: 'completed' }));
    await native.prepare(ref, { cwd: home, home }, id, '');
    start?.(ref);
    await expect.poll(() => event.mock.calls, poll).toContainEqual([ref, id, expect.objectContaining({ kind: 'end' }), true]);
    expect(activity).not.toHaveBeenCalled();

    await appendFile(file, step(Date.now()));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'working']);

    await appendFile(file, row('interaction.request', Date.now(), { id: 'permission', kind: 'approval', request: {} }));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'blocked']);
    const beforeBlockedStep = activity.mock.calls.length;
    const duringBlock = Date.now();
    await appendFile(file, step(duringBlock));
    await expect.poll(() => event.mock.calls, poll).toContainEqual([ref, id, { kind: 'working', at: duringBlock }, false]);
    expect(activity.mock.calls).toHaveLength(beforeBlockedStep);

    await appendFile(file, row('interaction.resolved', Date.now(), { id: 'permission' }));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'working']);
    await appendFile(file, row('turn.ended', Date.now(), { reason: 'completed' }));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'ended']);

    const nextStart = Date.now();
    await appendFile(file, step(nextStart));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'working']);
    native.onHook(ref, { hook_event_name: 'Interrupt', client_type: 'kimi_code_cli', cwd: home, session_id: id });
    expect(activity.mock.lastCall).toEqual([ref, 'ended']);
    const interrupted = activity.mock.calls.length;
    const inFlight = nextStart + 1;
    await appendFile(file, step(inFlight));
    await expect.poll(() => event.mock.calls, poll).toContainEqual([ref, id, { kind: 'working', at: inFlight }, false]);
    expect(activity.mock.calls).toHaveLength(interrupted);

    await appendFile(file, step(Date.now()));
    await expect.poll(() => activity.mock.lastCall, poll).toEqual([ref, 'working']);
  } finally {
    native.abort(ref);
    await rm(home, { recursive: true, force: true });
  }
});
