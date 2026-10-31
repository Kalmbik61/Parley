import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnownHosts, describeHostKey, judgeHostKey } from './known-hosts.js';

function blob(type: string, body: string): Buffer {
  const name = Buffer.from(type);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  return Buffer.concat([head, name, Buffer.from(body)]);
}

describe('known hosts', () => {
  const key = describeHostKey(blob('ssh-ed25519', 'AAAA'));
  const other = describeHostKey(blob('ssh-ed25519', 'BBBB'));

  it('names the key type and fingerprints like ssh-keygen', () => {
    expect(key.type).toBe('ssh-ed25519');
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('first use → unknown, then match, then changed; the file is 0600', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'sub', 'known_hosts');
    const hosts = createKnownHosts(file);
    expect(await hosts.verdict('1.2.3.4', 22, key)).toEqual({ kind: 'unknown' });
    await hosts.trust('1.2.3.4', 22, key);
    expect(await hosts.verdict('1.2.3.4', 22, key)).toEqual({ kind: 'match' });
    expect(await hosts.verdict('1.2.3.4', 22, other)).toEqual({ kind: 'changed', known: key.fingerprint });
    expect(await hosts.verdict('1.2.3.4', 2222, other)).toEqual({ kind: 'unknown' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe(`[1.2.3.4]:22 ssh-ed25519 ${key.fingerprint}\n`);
  });

  it('never replaces a known key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kh-'));
    const hosts = createKnownHosts(path.join(dir, 'known_hosts'));
    await hosts.trust('h', 22, key);
    await expect(hosts.trust('h', 22, other)).rejects.toThrow();
    expect(await hosts.verdict('h', 22, key)).toEqual({ kind: 'match' });
  });

  it('judges a hand-edited file', () => {
    expect(judgeHostKey(`\n[h]:22 ssh-rsa ${key.fingerprint}\n`, 'h', 22, key).kind).toBe('match');
    expect(judgeHostKey('garbage', 'h', 22, key).kind).toBe('unknown');
  });
});
