import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export type KimiFollowUpMode = 'queue' | 'steer';

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Observe the stock TUI's launch preference, never an account or model file. */
export async function captureKimiFollowUp(home: string): Promise<(() => KimiFollowUpMode | undefined) | undefined> {
  const file = join(home, 'tui.toml');
  let mode: KimiFollowUpMode;
  let launchStamp: string;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size > 64n * 1024n) return;
      launchStamp = stamp(info);
      const bytes = Buffer.alloc(Number(info.size) + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== Number(info.size) || stamp(await handle.stat({ bigint: true })) !== launchStamp) return;
      const value = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))).follow_up_behavior;
      if (value !== undefined && value !== 'queue' && value !== 'steer') return;
      mode = value ?? 'queue';
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
  let stable = true;
  return () => {
    // Recheck synchronously at the key boundary. A settings update or replaced
    // path invalidates this launch's proof, even if the contents later revert.
    if (!stable) return;
    try {
      const current = lstatSync(file, { bigint: true });
      stable = current.isFile() && stamp(current) === launchStamp;
    } catch {
      stable = false;
    }
    if (stable) return mode;
  };
}
