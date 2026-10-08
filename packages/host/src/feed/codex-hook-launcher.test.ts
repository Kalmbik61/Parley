import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCodexHookLauncher } from './codex-hook-launcher.js';

let home = '';
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe('ensureCodexHookLauncher', () => {
  it('путь постоянный, содержимое — node и мост, права на запуск; повтор с другим node — тот же путь', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    const first = await ensureCodexHookLauncher(home, '/usr/local/bin/node', '/Apps/Parley.app/host/codex-hook-bin.js');
    expect(first).toBe(path.join(home, 'bin', 'parley-codex-hook'));
    expect(await readFile(first, 'utf8')).toContain('exec "/usr/local/bin/node" "/Apps/Parley.app/host/codex-hook-bin.js"');
    expect((await stat(first)).mode & 0o111).not.toBe(0);
    const second = await ensureCodexHookLauncher(home, '/opt/node', '/Apps/Parley 2.app/host/codex-hook-bin.js');
    expect(second).toBe(first);
    expect(await readFile(second, 'utf8')).toContain('"/Apps/Parley 2.app/host/codex-hook-bin.js"');
  });
});
