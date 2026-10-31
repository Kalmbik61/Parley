import { describe, expect, it } from 'vitest';
import { shQuote } from './input.js';
import { createShell, type SshConnection } from './ssh.js';

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
    expect(c.lines[0]).toBe(`sh -c ${shQuote(`echo ${shQuote(nasty)}`)}`);
  });

  it('sudo -n for passwordless sudo, nothing for root, sudo only when the step asks', async () => {
    const c = capture();
    await createShell(c.connection, { kind: 'nopasswd' }).run('ls', { sudo: true });
    await createShell(c.connection, { kind: 'nopasswd' }).run('ls');
    await createShell(c.connection, { kind: 'root' }).run('ls', { sudo: true });
    expect(c.lines).toEqual(["sudo -n sh -c 'ls'", "sh -c 'ls'", "sh -c 'ls'"]);
  });

  it('the sudo password goes to stdin, never into the command line', async () => {
    const c = capture();
    await createShell(c.connection, { kind: 'password', password: 'p@ss w0rd' }).run('ls', { sudo: true });
    expect(c.lines[0]).toBe("sudo -S -p '' sh -c 'ls'");
    expect(c.lines[0]).not.toContain('p@ss');
    expect(c.stdins[0]).toBe('p@ss w0rd\n');
  });
});
