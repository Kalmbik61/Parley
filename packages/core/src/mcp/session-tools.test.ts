import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createParleyServer } from './tools.js';

const TOKEN = 'ab'.repeat(32);
const opened: Array<{ client: Client; server: ReturnType<typeof createParleyServer> }> = [];
let endpoint: Server | undefined;
let answer: { status: number; body: unknown };
const requests: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = [];

async function startEndpoint(): Promise<string> {
  answer = { status: 200, body: { ok: true, result: { sessionId: 's-02', provider: 'codex' } } };
  endpoint = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => endpoint!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/agent/browser`;
}

async function connect(url?: string, sessionId: string | null = 's-01'): Promise<Client> {
  const server = createParleyServer({
    projectPath: '/fixture', workId: 'w-01', workDir: '/fixture/.parley/works/w-01', sessionId, channel: false,
    ...(url === undefined ? {} : { agent: { url, token: TOKEN } }),
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, args: Record<string, unknown> = { provider: 'codex', label: 'Review', task: 'Review changes' }) {
  const result = await client.callTool({ name: 'create_session', arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: result.isError, text: content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
}

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) { await client.close(); await server.close(); }
  if (endpoint) await new Promise<void>((resolve, reject) => endpoint!.close(error => error ? reject(error) : resolve()));
  endpoint = undefined;
  requests.length = 0;
});

describe('create_session MCP', () => {
  it('advertises root session creation only with an identified host-connected session', async () => {
    const url = await startEndpoint();
    for (const client of [await connect(), await connect(url, null)]) {
      expect((await client.listTools()).tools.some(tool => tool.name === 'create_session')).toBe(false);
    }
    const client = await connect(url);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'create_session');
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: { required: ['provider', 'label', 'task'], additionalProperties: false },
    });
    expect(tool?.inputSchema.properties).not.toHaveProperty('parent');
    expect(tool?.inputSchema.properties).not.toHaveProperty('workId');
    expect(tool?.description).toContain('same workspace');
  });

  it('forwards model choices to the authenticated host and returns the created peer id', async () => {
    const client = await connect(await startEndpoint());
    const args = { provider: 'codex', label: 'Review', task: 'Review changes', model: 'gpt-6-astra', effort: 'high', role: 'builtin:reviewer', worktree: true };
    const result = await call(client, args);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.text)).toEqual({ sessionId: 's-02', provider: 'codex' });
    expect(requests).toEqual([{ url: '/agent/sessions', authorization: `Bearer ${TOKEN}`, body: args }]);
  });

  it('explains unavailable host support without mutating a map', async () => {
    const result = await call(await connect());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('host connection');
    expect(requests).toEqual([]);
  });

  it('preserves validation and budget refusals from the host', async () => {
    const client = await connect(await startEndpoint());
    answer.body = { ok: false, error: { code: 'resource-budget', message: 'The workspace new-session limit is exhausted.' } };
    expect(await call(client)).toEqual({ isError: true, text: 'resource-budget: The workspace new-session limit is exhausted.' });
    expect(requests).toHaveLength(1);
  });

  it('reports expired authorization and unsupported hosts without retrying creation', async () => {
    const client = await connect(await startEndpoint());
    answer.status = 401;
    expect((await call(client)).text).toContain('token');
    answer.status = 404;
    expect((await call(client)).text).toContain('does not support');
    expect(requests).toHaveLength(2);
  });

  it('rejects malformed success responses instead of reporting a created session', async () => {
    const client = await connect(await startEndpoint());
    answer.body = { ok: true, result: {} };
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('get_map');
  });
});
