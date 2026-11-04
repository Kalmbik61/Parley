import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnownHosts } from './known-hosts.js';
import { shQuote } from './input.js';
import { EventEmitter } from 'node:events';
import { ConnectionLostError } from './shell.js';
import { createConnectSsh, createShell, wrapClient, type SshConnection } from './ssh.js';

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
    expect(lines[0]).toContain('/var/lib/parley-relay-setup');
    expect(lines[0]).toContain('docker compose up -d');
    expect(lines[0]).toContain('start-1.code');
    expect(timeouts[0]).toBeGreaterThan(10 * 60_000);
    expect(lines[1]).not.toContain('setsid');
    expect(timeouts[1]).toBeUndefined();
  });

  it('interrupt is a separate elevated command that kills by the active file', async () => {
    const lines: string[] = [];
    const connection: SshConnection = { async exec(line) { lines.push(line); return { code: 0, stdout: '', stderr: '' }; }, close: () => undefined };
    await createShell(connection, { kind: 'nopasswd' }).interrupt?.('image-1');
    expect(lines[0]).toMatch(/^sudo -n sh -c '/);
    expect(lines[0]).toContain('image-1.pid');
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

/** A fake ssh2 `Client` whose channels the test drives by hand. */
function fakeClient() {
  const client = Object.assign(new EventEmitter(), {
    end: () => undefined,
    streams: [] as Array<EventEmitter & { stderr: EventEmitter; write: () => void; end: () => void; close: () => void }>,
    exec(_command: string, callback: (error: Error | undefined, stream: unknown) => void) {
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: () => undefined, end: () => undefined, close: () => stream.emit('close', null) });
      client.streams.push(stream);
      callback(undefined, stream);
    },
  });
  return client;
}

describe('wrapClient', () => {
  it('a multibyte character split between two chunks arrives whole, on stdout and on stderr', async () => {
    const client = fakeClient();
    const lines: string[] = [];
    const done = wrapClient(client as never).exec('x', { onLine: (line) => lines.push(line) });
    const bytes = Buffer.from('привет 🙂 мир\n', 'utf8');
    const cut = 3; // inside the first Cyrillic letter
    const cutEmoji = bytes.indexOf(0xf0) + 2; // inside the emoji
    client.streams[0]!.emit('data', bytes.subarray(0, cut));
    client.streams[0]!.emit('data', bytes.subarray(cut, cutEmoji));
    client.streams[0]!.emit('data', bytes.subarray(cutEmoji));
    client.streams[0]!.stderr.emit('data', bytes.subarray(0, cut));
    client.streams[0]!.stderr.emit('data', Buffer.concat([bytes.subarray(cut, bytes.length - 1)]));
    client.streams[0]!.emit('close', 0);
    const result = await done;
    expect(result.stdout).toBe('привет 🙂 мир\n');
    expect(lines[0]).toBe('привет 🙂 мир');
    expect(result.stderr).toBe('привет 🙂 мир');
    expect(result.stderr).not.toContain('\uFFFD');
  });

  it('a connection that closes under a command rejects it as «lost», even though the channel then closes with no code', async () => {
    const client = fakeClient();
    const pending = wrapClient(client as never).exec('x', {});
    // ssh2 order: the Client emits `close` first, the channel cleanup (stream `close`, code null) comes after.
    client.emit('close');
    client.streams[0]!.emit('close', null);
    await expect(pending).rejects.toBeInstanceOf(ConnectionLostError);
  });

  it('a command that finished before the connection closed keeps its exit code', async () => {
    const client = fakeClient();
    const pending = wrapClient(client as never).exec('x', {});
    client.streams[0]!.emit('close', 7);
    client.emit('close');
    expect((await pending).code).toBe(7);
  });

  it('the view timeout is «lost» (the command may still be running on the server), not exit code 255', async () => {
    const client = fakeClient();
    const pending = wrapClient(client as never).exec('x', { timeoutMs: 10 });
    await expect(pending).rejects.toBeInstanceOf(ConnectionLostError);
  });

  it('a failure to open the channel is an ordinary error, except «not connected»', async () => {
    const client = fakeClient();
    client.exec = (_c: string, cb: (error: Error | undefined, stream: unknown) => void) => cb(new Error('Channel open failure: administratively prohibited'), undefined);
    await expect(wrapClient(client as never).exec('x', {})).rejects.not.toBeInstanceOf(ConnectionLostError);
    client.exec = (_c: string, cb: (error: Error | undefined, stream: unknown) => void) => cb(new Error('Not connected'), undefined);
    await expect(wrapClient(client as never).exec('x', {})).rejects.toBeInstanceOf(ConnectionLostError);
  });
});
