import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantServer } from './assistant.js';

async function connect(fetch: typeof globalThis.fetch): Promise<Client> {
  const server = createAssistantServer({ url: 'http://127.0.0.1:1/assistant', token: 't0k', fetch });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}
const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parley-mcp в режиме помощника', () => {
  it('отдаёт ровно четыре инструмента', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['end_conversation', 'parley_detail', 'parley_overview', 'propose_message']);
  });
  it('вызов — POST в хост с токеном, ответ — текст', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { text: 'Work "Parley": 2 working' }));
    const client = await connect(fetch);
    const result = await client.callTool({ name: 'parley_detail', arguments: { target: 'room:a:w:r' } });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1/assistant/parley_detail', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer t0k' }),
      body: JSON.stringify({ target: 'room:a:w:r' }),
    }));
    expect(result.content).toEqual([{ type: 'text', text: 'Work "Parley": 2 working' }]);
    expect(result.isError).toBeFalsy();
  });
  it('отказ хоста — ошибка инструмента с его текстом', async () => {
    const client = await connect(vi.fn().mockResolvedValue(reply(404, { error: 'No room "Foo"' })));
    const result = await client.callTool({ name: 'propose_message', arguments: { target: 'Foo', text: 'x' } });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'No room "Foo"' }] });
  });
  it('хост недоступен — ошибка, а не падение сервера', async () => {
    const client = await connect(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await client.callTool({ name: 'parley_overview', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
