import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from '../atomic-file.js';

/**
 * `~/.parley/remote/known_hosts`: trust on first use for the servers the wizard installed to (spec 6.7).
 * One line per server: `[host]:port <key-type> SHA256:<base64>`. A different key for a known server stops the run.
 */

export interface HostKeyInfo {
  type: string;
  /** `SHA256:` + unpadded base64, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

export type HostKeyVerdict = { kind: 'unknown' } | { kind: 'match' } | { kind: 'changed'; known: string };

/** Reads the algorithm name and the fingerprint out of the raw SSH public key blob the server presented. */
export function describeHostKey(blob: Buffer): HostKeyInfo {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = length > 0 && length <= 64 && 4 + length <= blob.length ? blob.subarray(4, 4 + length).toString('ascii') : 'unknown';
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { type: /^[a-z0-9@.-]+$/.test(type) ? type : 'unknown', fingerprint: `SHA256:${digest}` };
}

const entryName = (host: string, port: number): string => `[${host}]:${port}`;

export function judgeHostKey(text: string, host: string, port: number, key: HostKeyInfo): HostKeyVerdict {
  const name = entryName(host, port);
  for (const line of text.split('\n')) {
    const [entry, , fingerprint] = line.trim().split(/\s+/);
    if (entry !== name || fingerprint === undefined) continue;
    return fingerprint === key.fingerprint ? { kind: 'match' } : { kind: 'changed', known: fingerprint };
  }
  return { kind: 'unknown' };
}

export interface KnownHosts {
  verdict(host: string, port: number, key: HostKeyInfo): Promise<HostKeyVerdict>;
  /** Called only after the person confirmed the fingerprint on screen. */
  trust(host: string, port: number, key: HostKeyInfo): Promise<void>;
}

export function createKnownHosts(file: string): KnownHosts {
  const read = async (): Promise<string> => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    async verdict(host, port, key) {
      return judgeHostKey(await read(), host, port, key);
    },
    async trust(host, port, key) {
      const text = await read();
      if (judgeHostKey(text, host, port, key).kind === 'changed') throw new Error('refusing to replace a known host key');
      if (judgeHostKey(text, host, port, key).kind === 'match') return;
      const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`;
      await writeAtomic(file, `${prefix}${entryName(host, port)} ${key.type} ${key.fingerprint}\n`);
    },
  };
}
