import { describe, expect, it } from 'vitest';
import { mcpSummary, secretValues, safeText } from './redact.js';

describe('capability metadata projection', () => {
  it('exposes only hostname, executable/argument count and variable names', () => {
    const config = { type: 'http', url: 'https://user:FIXTURE_SECRET@example.com/private/FIXTURE_SECRET?token=FIXTURE_SECRET', headers: { Authorization: 'Bearer FIXTURE_SECRET' } };
    const text = mcpSummary(config);
    expect(text).toBe('https · example.com');
    expect(text).not.toContain('FIXTURE_SECRET');
    expect(mcpSummary({ command: '/private/server/node', args: ['FIXTURE_SECRET', '/private/path'], env: { API_KEY: 'FIXTURE_SECRET' } })).toBe('node · 2 args · env: API_KEY');
  });
  it('does not mistake a launcher option value/URL for a package identifier', () => {
    expect(mcpSummary({ command: 'npx', args: ['--registry', 'https://user:FIXTURE_SECRET@example.com', 'tool'] })).toBe('npx · 3 args');
    expect(mcpSummary({ command: 'npx', args: ['tool', '--token', 'FIXTURE_SECRET'] })).toBe('npx tool · +2 args');
  });
  it('removes known config secrets even when repeated in an allowed description', () => {
    const secrets = secretValues({ env: { API_KEY: 'FIXTURE_SECRET' }, transport: { bearer_token: 'SECOND_SECRET' } });
    expect(safeText('Metadata FIXTURE_SECRET SECOND_SECRET', secrets)).toBe('Metadata [redacted] [redacted]');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readNativeJson } from './redact.js';

it('real execFile bounds failure output and closes stdin, without publishing stderr on success', async () => {
 const root = await mkdtemp(path.join(tmpdir(), 'parley-p15-exec-'));
 try {
  const context = { projectPath: root };
  expect(await readNativeJson(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("FIXTURE_SECRET");process.stdout.write("{\\"ready\\":true}")})'], context)).toEqual({ status: 'valid', data: { ready: true } });
  expect(await readNativeJson(process.execPath, ['-e', 'process.stdout.write("FIXTURE_SECRET");setInterval(()=>{},1000)'], context, { timeoutMs: 100 })).toEqual({ status: 'invalid', code: 'timeout' });
  expect(await readNativeJson(process.execPath, ['-e', 'process.stdout.write("FIXTURE_SECRET".repeat(1000))'], context, { maxBuffer: 128 })).toEqual({ status: 'invalid', code: 'output-limit' });
 } finally { await rm(root, { recursive: true, force: true }); }
});

it('HTTP env metadata exposes validated names, never bearer/header values', () => {
 const value = { url: 'https://example.com/FIXTURE_SECRET', bearer_token: 'FIXTURE_SECRET',
  bearer_token_env_var: 'AUTH_TOKEN', env_vars: ['PROJECT_KEY'], env_http_headers: { Authorization: 'HEADER_TOKEN' }, http_headers: { Secret: 'FIXTURE_SECRET' } };
 expect(mcpSummary(value)).toBe('https · example.com · env: AUTH_TOKEN, HEADER_TOKEN, PROJECT_KEY');
});

it('filters credential components and URL secrets repeated outside their raw container', () => {
 const secrets = secretValues({ headers: { Authorization: 'Bearer FIXTURE_SECRET' }, url: 'https://user:URL_SECRET@example.com/private?token=QUERY_SECRET' });
 expect(safeText('FIXTURE_SECRET URL_SECRET QUERY_SECRET https://user:OTHER_SECRET@example.com/secret?token=OTHER_SECRET', secrets)).toBe('[redacted] [redacted] [redacted] https://example.com');
});

it('fails closed on excessive secret metadata instead of publishing unchecked descriptions', () => {
 const secrets = secretValues({ env: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`KEY_${index}`, `secret-${index}`])) });
 expect(safeText('Metadata secret-299', secrets)).toBeNull();
});
