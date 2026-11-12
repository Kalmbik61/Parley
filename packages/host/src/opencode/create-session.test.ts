import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { createOpencodeSession } from './create-session.js';

const REF: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
const PASSWORD = 'lab-secret-not-real';
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
});

async function listen(status: number): Promise<{ url: string; password: string; bodies: string[]; auth: Array<string | undefined> }> {
  const seen = { url: '', password: PASSWORD, bodies: [] as string[], auth: [] as Array<string | undefined> };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.bodies.push(`${req.method} ${req.url} ${body}`);
      seen.auth.push(req.headers.authorization);
      res.writeHead(status).end('{}');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  seen.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return seen;
}

describe('createOpencodeSession', () => {
  it('POSTs the id with Basic auth and reports success', async () => {
    const fake = await listen(200);
    expect(await createOpencodeSession(fake, 'ses_x', REF, { warn: vi.fn() })).toBe(true);
    expect(fake.bodies).toEqual(['POST /api/session {"id":"ses_x"}']);
    expect(fake.auth[0]).toBe(`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`);
  });

  it('409 (the session already exists) is fine', async () => {
    expect(await createOpencodeSession(await listen(409), 'ses_x', REF, { warn: vi.fn() })).toBe(true);
  });

  it('a failure is logged without the address or the password and does not throw', async () => {
    const warn = vi.fn();
    const fake = await listen(500);
    expect(await createOpencodeSession(fake, 'ses_x', REF, { warn })).toBe(false);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(await createOpencodeSession(fake, 'ses_x', REF, { warn }, fetch, 500)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(fake.url);
    expect(logged).toContain('http 500');
  });
});
