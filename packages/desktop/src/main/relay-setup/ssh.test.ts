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

describe('createShell: commands apart from the channel (spec 7.3)', () => {
  it('a detached command is the 7.3 wrapper inside the usual sh -c, with a long timeout', async () => {
    const lines: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const connection: SshConnection = {
      async exec(line, options) {
        lines.push(line);
        timeouts.push(options.timeoutMs);
        return { code: 0, stdout: '', stderr: '' };
      },
      close: () => undefined,
    };
    const shell = createShell(connection, { kind: 'nopasswd' });
    await shell.run('docker compose up -d', { sudo: true, detach: 'start-1' });
    await shell.run('docker --version', { sudo: true });
    expect(lines[0]).toMatch(/^sudo -n sh -c '/);
    expect(lines[0]).toContain('setsid flock -n');
    expect(lines[0]).toContain('/var/tmp/parley-relay-setup');
    expect(lines[0]).toContain('docker compose up -d');
    expect(lines[0]).toContain('start-1.code');
    expect(timeouts[0]).toBeGreaterThan(10 * 60_000);
    expect(lines[1]).not.toContain('setsid');
    expect(timeouts[1]).toBeUndefined();
  });

  it('interrupt is a separate elevated command that kills by the active file', async () => {
    const lines: string[] = [];
    const connection: SshConnection = { async exec(line) { lines.push(line); return { code: 0, stdout: '', stderr: '' }; }, close: () => undefined };
    await createShell(connection, { kind: 'nopasswd' }).interrupt?.();
    expect(lines[0]).toMatch(/^sudo -n sh -c '/);
    expect(lines[0]).toContain('/pid');
    expect(lines[0]).toContain('kill -s TERM');
  });

  it('a command id outside [a-z0-9-]+ is refused before anything is sent', async () => {
    const connection: SshConnection = { async exec() { throw new Error('must not be called'); }, close: () => undefined };
    expect(() => createShell(connection, { kind: 'root' }).run('true', { detach: "x'; rm -rf /" })).toThrow();
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
