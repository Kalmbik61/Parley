import { describe, expect, it } from 'vitest';
import { isValidDomain, isValidHost, shQuote, validateInput } from './input.js';

const base = { host: '203.0.113.7', port: 22, user: 'root', auth: { kind: 'agent' }, secrets: {}, intent: 'install' };

describe('validateInput', () => {
  it('accepts a normal request and normalises case', () => {
    const result = validateInput({ ...base, host: 'Server.Example.COM', domain: 'Relay.Example.com', port: '2222' });
    expect(result).toEqual({
      ok: true,
      value: { host: 'server.example.com', port: 2222, user: 'root', auth: { kind: 'agent' }, secrets: {}, domain: 'relay.example.com', intent: 'install' },
    });
  });

  it.each([
    ['semicolon', '1.2.3.4; rm -rf /'],
    ['command substitution', '$(reboot).example.com'],
    ['backticks', '`id`.example.com'],
    ['newline', 'example.com\nrm -rf /'],
    ['trailing newline', 'example.com\n'],
    ['space', 'my server.example.com'],
    ['quote', "a'b.example.com"],
    ['pipe', 'a|b'],
    ['empty', ''],
    ['zone id', 'fe80::1%eth0'],
    ['leading dash', '-oProxyCommand=x'],
  ])('refuses a host with %s', (_name, host) => {
    const result = validateInput({ ...base, host });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.host).toBeDefined();
  });

  it.each([
    ['semicolon', 'a.com; rm -rf /'],
    ['command substitution', '$(id).example.com'],
    ['newline', 'relay.example.com\nevil'],
    ['space', 'relay example.com'],
    ['no dot', 'localhost'],
    ['an IP', '203.0.113.7'],
    ['a path', 'relay.example.com/x'],
    ['a port', 'relay.example.com:8443'],
  ])('refuses a domain with %s', (_name, domain) => {
    const result = validateInput({ ...base, domain });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.domain).toBeDefined();
  });

  it.each(['root; id', 'a b', 'Root', '$(id)', 'a\nb', '', '-x'])('refuses the user %j', (user) => {
    expect(validateInput({ ...base, user }).ok).toBe(false);
  });

  it.each([0, 65536, -1, 1.5, 'x', '22; id', '', null])('refuses the port %j', (port) => {
    expect(validateInput({ ...base, port }).ok).toBe(false);
  });

  it('refuses a key path that is not a plain file name in ~/.ssh', () => {
    for (const file of ['../../etc/passwd', '/etc/passwd', 'id_rsa.pub', 'a b', '.hidden', 'x;y']) {
      expect(validateInput({ ...base, auth: { kind: 'key', file } }).ok).toBe(false);
    }
    expect(validateInput({ ...base, auth: { kind: 'key', file: 'id_ed25519' } }).ok).toBe(true);
  });

  it('refuses multi-line or oversized secrets and requires a password for password login', () => {
    expect(validateInput({ ...base, auth: { kind: 'password' }, secrets: { password: 'a\nb' } }).ok).toBe(false);
    expect(validateInput({ ...base, secrets: { sudoPassword: 'x'.repeat(513) } }).ok).toBe(false);
    expect(validateInput({ ...base, auth: { kind: 'password' } }).ok).toBe(false);
    expect(validateInput({ ...base, auth: { kind: 'password' }, secrets: { password: 'pw' } }).ok).toBe(true);
  });

  it('refuses garbage shapes without throwing', () => {
    for (const raw of [null, undefined, 5, 'x', [], { intent: 'install' }]) expect(validateInput(raw).ok).toBe(false);
    expect(validateInput({ ...base, intent: 'format' }).ok).toBe(false);
  });
});

describe('host and domain checks', () => {
  it('knows IPv4, IPv6 and DNS names', () => {
    expect(isValidHost('2001:db8::1')).toBe(true);
    expect(isValidHost('a-b.example.com')).toBe(true);
    expect(isValidDomain('relay.example.com')).toBe(true);
    expect(isValidDomain('1.2.3.4')).toBe(false);
  });
});

describe('shQuote', () => {
  it('wraps in single quotes and closes them around a quote', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote('$(id) `id`; rm')).toBe("'$(id) `id`; rm'");
  });
  it('refuses NUL', () => {
    expect(() => shQuote('a\0b')).toThrow();
  });
});
