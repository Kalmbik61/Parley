import net from 'node:net';

/**
 * Everything the person types into the relay setup wizard is checked here, before any connection is made
 * (mobile spec 6.7, plan A18a acceptance 7). A value that fails is never sent anywhere; a value that passes still
 * reaches a shell only through `shQuote`.
 */

export type SetupIntent = 'install' | 'rollback' | 'remove';

export type SetupAuth = { kind: 'key'; file: string } | { kind: 'agent' } | { kind: 'password' };

export interface SetupSecrets {
  password?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface SetupInput {
  host: string;
  port: number;
  user: string;
  auth: SetupAuth;
  secrets: SetupSecrets;
  /** Own domain, lower case, `null` → `<ip-with-dashes>.sslip.io`. */
  domain: string | null;
  intent: SetupIntent;
}

export type InputErrors = Partial<Record<'host' | 'port' | 'user' | 'auth' | 'domain' | 'password' | 'passphrase' | 'sudoPassword' | 'intent', string>>;
export type InputResult = { ok: true; value: SetupInput } | { ok: false; errors: InputErrors };

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** A file name inside `~/.ssh`, never a path. */
const KEY_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_MAX = 512;

/**
 * Single-quotes a value for a POSIX shell: the only way a validated parameter enters a command. The result is parsed
 * by the login shell of the remote user; sh, bash and zsh read it as written, fish treats backslashes inside single
 * quotes as escapes, so templates must not contain a backslash (the file bodies are sent as base64 for that reason).
 */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL in a shell argument');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (net.isIP(host) !== 0) return !host.includes('%');
  return HOSTNAME.test(host);
}

export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && net.isIP(domain) === 0 && DOMAIN.test(domain) && !/^\d+(\.\d+)*$/.test(domain);
}

function secret(value: unknown, field: 'password' | 'passphrase' | 'sudoPassword', errors: InputErrors): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > SECRET_MAX || /[\0\r\n]/.test(value)) {
    errors[field] = 'Use a single line of up to 512 characters';
    return undefined;
  }
  return value;
}

/** `raw` comes from the renderer over IPC: nothing about its shape is trusted. */
export function validateInput(raw: unknown): InputResult {
  const errors: InputErrors = {};
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  // Not trimmed: a stray newline or space is an error to show, never something to quietly drop.
  const host = typeof r.host === 'string' ? r.host.toLowerCase() : '';
  if (!isValidHost(host)) errors.host = 'Enter a host name or an IP address, without spaces or other characters';

  const portNumber = typeof r.port === 'string' && /^\d{1,5}$/.test(r.port) ? Number(r.port) : r.port;
  const port = typeof portNumber === 'number' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 ? portNumber : 0;
  if (port === 0) errors.port = 'Enter a port from 1 to 65535';

  const user = typeof r.user === 'string' ? r.user : '';
  if (!USER.test(user)) errors.user = 'Use the user name as it is on the server: lower-case letters, digits, "_" and "-"';

  let domain: string | null = null;
  if (typeof r.domain === 'string' && r.domain !== '') {
    const candidate = r.domain.toLowerCase();
    if (isValidDomain(candidate)) domain = candidate;
    else errors.domain = 'Enter a domain such as relay.example.com, or leave it empty';
  } else if (r.domain !== undefined && r.domain !== null && typeof r.domain !== 'string') {
    errors.domain = 'Enter a domain such as relay.example.com, or leave it empty';
  }

  const intent = r.intent === 'install' || r.intent === 'rollback' || r.intent === 'remove' ? r.intent : null;
  if (intent === null) errors.intent = 'Unknown action';

  let auth: SetupAuth = { kind: 'agent' };
  const rawAuth = (typeof r.auth === 'object' && r.auth !== null ? r.auth : {}) as Record<string, unknown>;
  if (rawAuth.kind === 'key' && typeof rawAuth.file === 'string' && KEY_FILE.test(rawAuth.file) && !rawAuth.file.endsWith('.pub')) {
    auth = { kind: 'key', file: rawAuth.file };
  } else if (rawAuth.kind === 'agent' || rawAuth.kind === 'password') {
    auth = { kind: rawAuth.kind };
  } else {
    errors.auth = 'Choose a key from ~/.ssh, the SSH agent or a password';
  }

  const rawSecrets = (typeof r.secrets === 'object' && r.secrets !== null ? r.secrets : {}) as Record<string, unknown>;
  const secrets: SetupSecrets = {};
  const password = secret(rawSecrets.password, 'password', errors);
  const passphrase = secret(rawSecrets.passphrase, 'passphrase', errors);
  const sudoPassword = secret(rawSecrets.sudoPassword, 'sudoPassword', errors);
  if (password !== undefined) secrets.password = password;
  if (passphrase !== undefined) secrets.passphrase = passphrase;
  if (sudoPassword !== undefined) secrets.sudoPassword = sudoPassword;
  if (auth.kind === 'password' && password === undefined && errors.password === undefined) errors.password = 'Enter the SSH password';

  if (Object.keys(errors).length > 0 || intent === null) return { ok: false, errors };
  return { ok: true, value: { host, port, user, auth, secrets, domain, intent } };
}
