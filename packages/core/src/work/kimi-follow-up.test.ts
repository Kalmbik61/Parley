import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureKimiFollowUp } from './kimi-follow-up.js';

it.each(['queue', 'steer'] as const)('captures the %s mode and invalidates it on file changes', async (mode) => {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-tui-'));
  try {
    const file = join(home, 'tui.toml');
    await writeFile(file, `follow_up_behavior = "${mode}"\n`);
    const modeAtLaunch = await captureKimiFollowUp(home);
    expect(modeAtLaunch?.()).toBe(mode);
    await writeFile(file, `follow_up_behavior = "${mode === 'steer' ? 'queue' : 'steer'}"\n`);
    expect(modeAtLaunch?.()).toBeUndefined();
    await writeFile(file, `follow_up_behavior = "${mode}"\n`);
    expect(modeAtLaunch?.()).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('does not rely on missing, unreadable in shape, malformed or symlinked settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'parley-kimi-tui-'));
  try {
    const file = join(home, 'tui.toml');
    expect(await captureKimiFollowUp(home)).toBeUndefined();
    for (const content of ['follow_up_behavior = "other"', '[unterminated', '#'.repeat(64 * 1024 + 1)]) {
      await writeFile(file, content);
      expect(await captureKimiFollowUp(home)).toBeUndefined();
    }
    await unlink(file);
    await writeFile(join(home, 'other.toml'), 'follow_up_behavior = "steer"');
    await symlink('other.toml', file);
    expect(await captureKimiFollowUp(home)).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
