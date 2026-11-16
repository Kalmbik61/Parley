import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePacketHookLauncher, PACKET_HOOK_LAUNCHER } from './packet-hook-launcher.js';

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'parley-launcher-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('запускатель моста пакета', () => {
  it('пишет исполняемый скрипт с постоянным путём в PARLEY_HOME/bin, переписывает при смене путей и не трогает совпадающий', async () => {
    const file = await ensurePacketHookLauncher(home, '/usr/local/bin/node', '/Apps/Parley.app/host/hooks/packet-hook-bin.js');
    expect(file).toBe(path.join(home, 'bin', PACKET_HOOK_LAUNCHER));
    expect(await readFile(file, 'utf8')).toContain('exec "/usr/local/bin/node" "/Apps/Parley.app/host/hooks/packet-hook-bin.js" "$@"');
    expect((await stat(file)).mode & 0o111).not.toBe(0);

    await writeFile(file, 'stale');
    const again = await ensurePacketHookLauncher(home, '/opt/node', '/new/packet-hook-bin.js');
    expect(again).toBe(file);
    expect(await readFile(file, 'utf8')).toContain('exec "/opt/node" "/new/packet-hook-bin.js" "$@"');

    const before = (await stat(file)).mtimeMs;
    await ensurePacketHookLauncher(home, '/opt/node', '/new/packet-hook-bin.js');
    expect((await stat(file)).mtimeMs).toBe(before);
  });
});
