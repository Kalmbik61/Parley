import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnownHosts } from './known-hosts.js';
import { shQuote } from './input.js';
import { createConnectSsh, createShell, type SshConnection } from './ssh.js';

function capture(): { connection: SshConnection; lines: string[]; stdins: Array<string | undefined> } {
  const lines: string[] = [];
  const stdins: Array<string | undefined> = [];
  return {
    lines,
    stdins,
    connection: {
      async exec(line, options) {
        lines.push(line);
        stdins.push(options.stdin);
        return { code: 0, stdout: '', stderr: '' };
      },
      close: () => undefined,
    },
  };
}

describe('createShell', () => {
  it('wraps every command in sh -c with one level of quoting, hostile text stays inert', async () => {
    const c = capture();
    const nasty = "x'; rm -rf /; echo '$(id)";
    await createShell(c.connection, { kind: 'root' }).run(`echo ${shQuote(nasty)}`);
    expect(c.lines[0]).toBe(`sh -c ${shQuote(`exec </dev/null; echo ${shQuote(nasty)}`)}`);
  });

  it('sudo -n for passwordless sudo, nothing for root, sudo only when the step asks', async () => {
    const c = capture();
    await createShell(c.connection, { kind: 'nopasswd' }).run('ls', { sudo: true });
    await createShell(c.connection, { kind: 'nopasswd' }).run('ls');
    await createShell(c.connection, { kind: 'root' }).run('ls', { sudo: true });
    expect(c.lines).toEqual(["sudo -n sh -c 'exec </dev/null; ls'", "sh -c 'exec </dev/null; ls'", "sh -c 'exec </dev/null; ls'"]);
  });

  it('the sudo password goes to stdin, never into the command line', async () => {
    const c = capture();
    await createShell(c.connection, { kind: 'password', password: 'p@ss w0rd' }).run('ls', { sudo: true });
    expect(c.lines[0]).toBe("sudo -S -p '' sh -c 'exec </dev/null; ls'");
    expect(c.lines[0]).not.toContain('p@ss');
    expect(c.stdins[0]).toBe('p@ss w0rd\n');
  });
});

describe('connectSsh with an encrypted key (R1)', () => {
  it('asks for the passphrase instead of failing, and says when the one given is wrong', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-keys-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'right-phrase', '-f', path.join(dir, 'id_enc')]);
    const connect = createConnectSsh(dir);
    const hosts = createKnownHosts(path.join(dir, 'known_hosts'));
    const base = { host: '127.0.0.1', port: 9, user: 'root', auth: { kind: 'key' as const, file: 'id_enc' }, trusted: null };
    expect(await connect({ ...base, secrets: {} }, hosts)).toEqual({ kind: 'passphrase-required', wrong: false });
    expect(await connect({ ...base, secrets: { passphrase: 'wrong-phrase' } }, hosts)).toEqual({ kind: 'passphrase-required', wrong: true });
    // The right phrase gets past the key and tries the network (nothing listens on port 9).
    expect((await connect({ ...base, secrets: { passphrase: 'right-phrase' } }, hosts)).kind).toBe('error');
  });
});
