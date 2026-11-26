import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRef } from '@parley/protocol';
import { expect, it, vi } from 'vitest';
import { fakePty } from '../../test/fake-pty.js';
import { createKimiNativeSession } from './native-session.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };
const id = 'session_00000000-0000-4000-8000-000000000001';
const queue = [
  ' ⠋ Working for 1s',
  ' ──────────────────────',
  ' ❯ older',
  ' ↑ to edit · ctrl-s to steer immediately',
  ' ╭────────────────────╮',
  ' │ >                  │',
  ' ╰────────────────────╯',
  ' model  ·  workspace',
];

it.each([
  ['queue', '\x1b[13;5u'],
  ['steer', '\r'],
] as const)('proves the native %s mode before a selective key and rechecks before writing it', async (mode, key) => {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-send-target-'));
  const pty = fakePty();
  pty.paste = true;
  let start: ((ref: SessionRef) => void) | undefined;
  const get = pty.manager.get;
  pty.manager.get = (target) => {
    const handle = get(target);
    return handle === undefined ? undefined : { ...handle, kimiNative: true, generation: 'active-generation' };
  };
  const on = pty.manager.on;
  pty.manager.on = ((event: string, listener: never) => {
    if (event === 'start') start = listener;
    return on(event as 'draft', listener);
  }) as typeof on;
  const native = createKimiNativeSession({
    pty: pty.manager, log: { warn: vi.fn() }, bind: vi.fn(), bootstrap: vi.fn(), event: vi.fn(),
    reset: vi.fn(), requests: vi.fn(), activity: vi.fn(), startupFailed: vi.fn(),
    readyChanged: vi.fn(), fence: vi.fn(),
  });
  try {
    const tui = join(home, 'tui.toml');
    await writeFile(tui, `follow_up_behavior = "${mode}"\n`);
    await native.prepare(ref, { cwd: home, home }, id, '');
    start?.(ref);
    native.listed(ref, []);
    native.onHook(ref, { client_type: 'kimi_code_cli', cwd: home, session_id: id, hook_event_name: 'UserPromptSubmit' });

    pty.screen = queue;
    expect(native.sendTarget(ref, false, false)).toBeUndefined();
    expect(native.sendTarget(ref, false, true)).toEqual({ id, mode: 'steer', key });
    pty.screen = queue.toSpliced(5, 1, ' │ > selected         │');
    expect(native.sendTarget(ref, true, true)).toEqual({ id, mode: 'steer', key });

    pty.screen = [...pty.screen, 'Follow-up behavior'];
    expect(native.sendTarget(ref, true, true)).toBeUndefined();
    pty.screen.pop();
    await writeFile(tui, `follow_up_behavior = "${mode === 'queue' ? 'steer' : 'queue'}"\n`);
    expect(native.sendTarget(ref, true, true)).toBeUndefined();
    await writeFile(tui, `follow_up_behavior = "${mode}"\n`);
    expect(native.sendTarget(ref, true, true)).toBeUndefined();

    pty.screen = pty.screen.toSpliced(1, 3);
    expect(native.sendTarget(ref, true, true)).toEqual({ id, mode: 'steer', key: '\x13' });
  } finally {
    native.abort(ref);
    await rm(home, { recursive: true, force: true });
  }
});
