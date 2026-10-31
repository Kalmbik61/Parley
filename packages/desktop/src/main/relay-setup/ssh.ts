import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'ssh2';
import { describeHostKey, type HostKeyInfo, type HostKeyVerdict, type KnownHosts } from './known-hosts.js';
import { shQuote, type SetupAuth, type SetupSecrets } from './input.js';
import type { RemoteShell, RunOptions, RunResult } from './shell.js';

/**
 * SSH with `ssh2` (pure JS), main process only. Credentials arrive here in memory, are used for one connection and
 * are never written anywhere. The host key is checked BEFORE authentication, so a server that has not been confirmed
 * never receives a password.
 */

export interface ConnectRequest {
  host: string;
  port: number;
  user: string;
  auth: SetupAuth;
  secrets: SetupSecrets;
  /** Fingerprint the person confirmed on screen for an unknown host; accepted only if the server presents exactly it. */
  trusted: string | null;
}

export interface SshConnection {
  /** `sudo` mode of the shell is decided later, after the probe. */
  exec(command: string, options: { stdin?: string; onLine?: (line: string) => void; timeoutMs?: number }): Promise<RunResult>;
  close(): void;
}

export type ConnectOutcome =
  | { kind: 'ok'; connection: SshConnection }
  | { kind: 'hostkey-unknown'; key: HostKeyInfo }
  | { kind: 'hostkey-changed'; key: HostKeyInfo; known: string }
  /** `wrong`: a passphrase was given and the key still did not open. */
  | { kind: 'passphrase-required'; wrong: boolean }
  | { kind: 'auth-failed' }
  | { kind: 'error'; message: string };

export type ConnectFn = (request: ConnectRequest, knownHosts: KnownHosts) => Promise<ConnectOutcome>;

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 1024 * 1024;

export async function listPrivateKeys(sshDir: string = path.join(os.homedir(), '.ssh')): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(sshDir);
  } catch {
    return [];
  }
  const skip = /^(known_hosts.*|config|authorized_keys.*|environment|rc|.*\.pub|\..*)$/;
  const keys: string[] = [];
  for (const name of names.sort()) {
    if (skip.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) continue;
    try {
      const head = (await readFile(path.join(sshDir, name), 'utf8')).slice(0, 64);
      if (head.includes('PRIVATE KEY')) keys.push(name);
    } catch {
      // unreadable or a directory: not a key
    }
  }
  return keys;
}

function wrap(connection: Client): SshConnection {
  return {
    exec(command, options) {
      return new Promise<RunResult>((resolve, reject) => {
        connection.exec(command, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          let stdout = '';
          let stderr = '';
          const pending = { out: '', err: '' };
          const timer = setTimeout(() => stream.close(), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
          const feed = (kind: 'out' | 'err', chunk: Buffer): void => {
            const text = chunk.toString('utf8');
            if (kind === 'out' && stdout.length < OUTPUT_CAP) stdout += text;
            if (kind === 'err' && stderr.length < OUTPUT_CAP) stderr += text;
            if (options.onLine === undefined) return;
            const lines = (pending[kind] + text).split('\n');
            pending[kind] = lines.pop() ?? '';
            for (const line of lines) options.onLine(line.replace(/\r$/, ''));
          };
          stream.on('data', (chunk: Buffer) => feed('out', chunk));
          stream.stderr.on('data', (chunk: Buffer) => feed('err', chunk));
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            for (const rest of [pending.out, pending.err]) if (rest !== '') options.onLine?.(rest);
            resolve({ code: code ?? 255, stdout, stderr });
          });
          stream.on('error', reject);
          if (options.stdin !== undefined) stream.write(options.stdin);
          stream.end();
        });
      });
    },
    close() {
      connection.end();
    },
  };
}

const PASSPHRASE = /passphrase/i;

export function createConnectSsh(sshDir: string = path.join(os.homedir(), '.ssh')): ConnectFn {
  return (request, knownHosts) => connectWith(sshDir, request, knownHosts);
}

export const connectSsh: ConnectFn = createConnectSsh();

const connectWith = async (sshDir: string, request: ConnectRequest, knownHosts: KnownHosts): Promise<ConnectOutcome> => {
  let privateKey: Buffer | undefined;
  if (request.auth.kind === 'key') {
    try {
      privateKey = await readFile(path.join(sshDir, request.auth.file));
    } catch {
      return { kind: 'error', message: 'The key file could not be read' };
    }
  }
  if (request.auth.kind === 'agent' && process.env.SSH_AUTH_SOCK === undefined) {
    return { kind: 'error', message: 'No SSH agent is running (SSH_AUTH_SOCK is not set)' };
  }

  return new Promise<ConnectOutcome>((resolve) => {
    const client = new Client();
    let verdict: HostKeyVerdict | null = null;
    let presented: HostKeyInfo | null = null;
    let settled = false;
    const settle = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      if (outcome.kind !== 'ok') client.end();
      resolve(outcome);
    };

    client.on('ready', () => settle({ kind: 'ok', connection: wrap(client) }));
    client.on('error', (error: Error & { level?: string }) => {
      if (presented !== null && verdict?.kind === 'changed') return settle({ kind: 'hostkey-changed', key: presented, known: verdict.known });
      if (presented !== null && verdict?.kind === 'unknown' && request.trusted !== presented.fingerprint) {
        return settle({ kind: 'hostkey-unknown', key: presented });
      }
      if (PASSPHRASE.test(error.message)) return settle({ kind: 'passphrase-required', wrong: request.secrets.passphrase !== undefined });
      if (error.level === 'client-authentication') return settle({ kind: 'auth-failed' });
      // `error.message` of ssh2 never contains credentials, but keep it short and single-line anyway.
      return settle({ kind: 'error', message: error.message.split('\n')[0]?.slice(0, 160) ?? 'Connection failed' });
    });
    client.on('close', () => settle({ kind: 'error', message: 'The server closed the connection' }));

    try {
      client.connect({
        host: request.host,
        port: request.port,
        username: request.user,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        ...(privateKey !== undefined ? { privateKey } : {}),
        ...(request.secrets.passphrase !== undefined ? { passphrase: request.secrets.passphrase } : {}),
        ...(request.auth.kind === 'agent' ? { agent: process.env.SSH_AUTH_SOCK as string } : {}),
        ...(request.auth.kind === 'password' ? { password: request.secrets.password ?? '' } : {}),
        hostVerifier: (key: Buffer, accept: (valid: boolean) => void) => {
          const info = describeHostKey(key);
          presented = info;
          knownHosts.verdict(request.host, request.port, info).then(
            (v) => {
              verdict = v;
              accept(v.kind === 'match' || (v.kind === 'unknown' && request.trusted === info.fingerprint));
            },
            () => accept(false),
          );
        },
      });
    } catch (error) {
      // ssh2 parses `privateKey` inside connect() and throws from there, not through the 'error' event.
      const message = error instanceof Error ? error.message : '';
      if (PASSPHRASE.test(message)) settle({ kind: 'passphrase-required', wrong: request.secrets.passphrase !== undefined });
      else settle({ kind: 'error', message: message.split('\n')[0]?.slice(0, 160) || 'Connection failed' });
    }
  });
};

export type SudoMode = { kind: 'root' } | { kind: 'nopasswd' } | { kind: 'password'; password: string };

/** Fixed wrapper: `sh -c <quoted command>`, under `sudo` when the step needs root and the user is not root. */
export function createShell(connection: SshConnection, sudo: SudoMode): RemoteShell {
  return {
    run(command: string, options: RunOptions = {}): Promise<RunResult> {
      // stdin of the command is closed: after `sudo -S` took the password line nothing else can read the rest.
      const inner = `sh -c ${shQuote(`exec </dev/null; ${command}`)}`;
      const elevate = options.sudo === true && sudo.kind !== 'root';
      const line = !elevate ? inner : sudo.kind === 'password' ? `sudo -S -p '' ${inner}` : `sudo -n ${inner}`;
      return connection.exec(line, {
        ...(elevate && sudo.kind === 'password' ? { stdin: `${sudo.password}\n` } : {}),
        ...(options.onLine !== undefined ? { onLine: options.onLine } : {}),
      });
    },
  };
}
